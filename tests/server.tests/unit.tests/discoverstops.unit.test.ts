/**
 * TUC4 – Discover Stops & Schedules: unit tests
 *
 * Test-worthy logic covered:
 *   - haversineMeters          (great-circle distance formula)
 *   - computeWalkMinutes       (1 km = 15 min heuristic with ceiling, TUC4 R4)
 *   - getNearbyStops           (radius filtering, A6 expansion, route/system/
 *                               direction filters, stop deduplication,
 *                               multi-route accumulation, sorted output,
 *                               includeRoutes flag)
 */

import { TransitModel } from '../../../server/models/transit.model';
import { haversineMeters } from '../../../common/geo';
import {
  computeWalkMinutes
} from '../../../server/models/transit.model';
import { IRoute, IStop } from '../../../common/transit.interface';

// ---------------------------------------------------------------------------
// Module-level mocks — isolate external service boundaries
// ---------------------------------------------------------------------------

jest.mock('../../../server/services/gtfs.service', () => ({
  __esModule: true,
  default: {
    isLoaded: jest.fn().mockReturnValue(true),
    getRoutes: jest.fn().mockReturnValue([]),
    getPatterns: jest.fn().mockReturnValue([]),
    getStops: jest.fn().mockReturnValue([]),
    getStopsByDirection: jest.fn().mockReturnValue([]),
    filterRoutesByDate: jest.fn().mockReturnValue([]),
    filterRoutesByDateTime: jest.fn().mockReturnValue([])
  }
}));

jest.mock('../../../server/services/tripshot.service', () => ({
  __esModule: true,
  default: {
    isConfigured: jest.fn().mockReturnValue(false),
    getRoutes: jest.fn().mockResolvedValue([]),
    getStops: jest.fn().mockResolvedValue([]),
    getVehicles: jest.fn().mockResolvedValue([])
  }
}));

jest.mock('../../../server/services/truetime.service', () => ({
  __esModule: true,
  default: {
    getRoutes: jest.fn().mockResolvedValue([]),
    getDetours: jest.fn().mockResolvedValue([]),
    getDetourGeometry: jest.fn().mockResolvedValue([])
  }
}));

// ---------------------------------------------------------------------------
// Shared test fixtures
// ---------------------------------------------------------------------------

/**
 * Reference point: CMU Tepper School area (Pittsburgh, PA).
 * All test stops below are positioned relative to this origin.
 */
const CENTER = { lat: 40.4433, lon: -79.9436 };

/**
 * Stops at increasing distances from CENTER (pure-north movement so
 * longitude stays constant; distance ≈ delta_lat × 111 000 m).
 *
 * delta  0.0000° →   ~0 m  (collocated with center)
 * delta  0.0045° →  ~500 m  (inside 1 000 m default radius)
 * delta  0.0081° →  ~900 m  (inside 1 000 m default radius)
 * delta  0.0135° → ~1 500 m (inside 2 000 m expansion radius only)
 * delta  0.0270° → ~3 000 m (outside both radii)
 */
const STOP_AT_CENTER: IStop = {
  stopId: 's0',
  stopName: 'At Center',
  lat: CENTER.lat,
  lon: CENTER.lon,
  dtradd: [],
  dtrrem: []
};

const STOP_500M: IStop = {
  stopId: 's1',
  stopName: '~500m Stop',
  lat: CENTER.lat + 0.0045,
  lon: CENTER.lon,
  dtradd: [],
  dtrrem: []
};

const STOP_900M: IStop = {
  stopId: 's2',
  stopName: '~900m Stop',
  lat: CENTER.lat + 0.0081,
  lon: CENTER.lon,
  dtradd: [],
  dtrrem: []
};

const STOP_1500M: IStop = {
  stopId: 's3',
  stopName: '~1500m Stop',
  lat: CENTER.lat + 0.0135,
  lon: CENTER.lon,
  dtradd: [],
  dtrrem: []
};

const ROUTE_PRT: IRoute = {
  id: '61C',
  name: 'McKeesport via Forbes',
  system: 'PRT',
  color: '#FF6600',
  directions: ['INBOUND', 'OUTBOUND'],
  activeStatus: true,
  operatingDays: [1, 2, 3, 4, 5]
};

const ROUTE_PRT_P1: IRoute = {
  id: 'P1',
  name: 'East Busway',
  system: 'PRT',
  color: '#00518B',
  directions: ['INBOUND', 'OUTBOUND'],
  activeStatus: true,
  operatingDays: [1, 2, 3, 4, 5]
};

/** Distance between two (lat, lon) pairs, in meters. */
function haversineDistanceMeters(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number
): number {
  return haversineMeters({ lat: lat1, lng: lon1 }, { lat: lat2, lng: lon2 });
}

// ============================================================================
// Tests
// ============================================================================

describe('TUC4 – Discover Stops & Schedules unit tests', () => {
  beforeEach(() => jest.restoreAllMocks());

  // --------------------------------------------------------------------------
  // haversineMeters — great-circle distance formula
  // --------------------------------------------------------------------------

  describe('haversineMeters', () => {
    test('two identical coordinates produce zero distance', () => {
      const d = haversineDistanceMeters(40.4433, -79.9436, 40.4433, -79.9436);
      expect(d).toBe(0);
    });

    test('one degree of latitude at the equator is approximately 111 km', () => {
      // (0°N, 0°E) → (1°N, 0°E)
      const d = haversineDistanceMeters(0, 0, 1, 0);
      expect(d).toBeGreaterThan(110_000);
      expect(d).toBeLessThan(112_000);
    });

    test('distance is symmetric — swapping origin and destination gives same result', () => {
      const d1 = haversineDistanceMeters(40.4433, -79.9436, 40.4514, -79.9436);
      const d2 = haversineDistanceMeters(40.4514, -79.9436, 40.4433, -79.9436);
      expect(d1).toBeCloseTo(d2, 5);
    });

    test('stop in the ~500m fixture is within 400–600 m of CENTER', () => {
      const d = haversineDistanceMeters(
        CENTER.lat,
        CENTER.lon,
        STOP_500M.lat,
        STOP_500M.lon
      );
      expect(d).toBeGreaterThan(400);
      expect(d).toBeLessThan(600);
    });

    test('stop in the ~1500m fixture is outside 1 000 m but inside 2 000 m', () => {
      const d = haversineDistanceMeters(
        CENTER.lat,
        CENTER.lon,
        STOP_1500M.lat,
        STOP_1500M.lon
      );
      expect(d).toBeGreaterThan(1000);
      expect(d).toBeLessThan(2000);
    });
  });

  // --------------------------------------------------------------------------
  // computeWalkMinutes — 1 km = 15 min walk-time heuristic (TUC4 R4)
  // --------------------------------------------------------------------------

  describe('computeWalkMinutes', () => {
    test('0 m produces 0 minutes', () => {
      expect(computeWalkMinutes(0)).toBe(0);
    });

    test('exactly 1 km (1000 m) produces exactly 15 minutes', () => {
      // 1000 / 1000 * 15 = 15.0 → ceil(15.0) = 15
      expect(computeWalkMinutes(1000)).toBe(15);
    });

    test('fractional km rounds up — 1 m over a boundary adds one minute', () => {
      // 1001 / 1000 * 15 = 15.015 → ceil = 16
      expect(computeWalkMinutes(1001)).toBe(16);
    });

    test('500 m produces 8 minutes (ceiling of 7.5)', () => {
      // 500 / 1000 * 15 = 7.5 → ceil = 8
      expect(computeWalkMinutes(500)).toBe(8);
    });

    test('100 m produces 2 minutes (ceiling of 1.5)', () => {
      // 100 / 1000 * 15 = 1.5 → ceil = 2
      expect(computeWalkMinutes(100)).toBe(2);
    });
  });

  // --------------------------------------------------------------------------
  // getNearbyStops — core Discover business logic
  // --------------------------------------------------------------------------

  describe('getNearbyStops', () => {
    function spyRoutes(routes: IRoute[]) {
      return jest.spyOn(TransitModel, 'getRoutes').mockResolvedValue(routes);
    }

    function spyStops(stopsByKey: Record<string, IStop[]>) {
      return jest
        .spyOn(TransitModel, 'getStops')
        .mockImplementation(async (routeId, direction) => {
          return stopsByKey[`${routeId}:${direction}`] ?? [];
        });
    }

    // -----------------------------------------------------------------------
    // 1. POSITIVE: stops within radius appear in results, sorted by distance
    // -----------------------------------------------------------------------
    test('(+) stops within the default radius are returned sorted by ascending distance', async () => {
      spyRoutes([ROUTE_PRT]);
      spyStops({
        '61C:INBOUND': [STOP_900M, STOP_AT_CENTER], // deliberately unsorted
        '61C:OUTBOUND': []
      });

      const result = await TransitModel.getNearbyStops(CENTER.lat, CENTER.lon);

      expect(result.stops).toHaveLength(2);
      // Closest stop (at center, 0 m) must come first
      expect(result.stops[0].stop.stopId).toBe('s0');
      expect(result.stops[1].stop.stopId).toBe('s2');
      // Distance is monotonically non-decreasing
      expect(result.stops[0].distanceMeters).toBeLessThanOrEqual(
        result.stops[1].distanceMeters
      );
    });

    // -----------------------------------------------------------------------
    // 2. NEGATIVE: stops outside the radius are excluded from results
    // -----------------------------------------------------------------------
    test('(-) stops beyond the requested radius are excluded from results', async () => {
      spyRoutes([ROUTE_PRT]);
      // STOP_900M is ~900 m from center; request only 500 m → should be excluded
      // Use a custom 500 m radius so A6 expansion does not fire (A6 only
      // triggers when the default 1000 m radius is used).
      spyStops({
        '61C:INBOUND': [STOP_900M],
        '61C:OUTBOUND': []
      });

      const result = await TransitModel.getNearbyStops(
        CENTER.lat,
        CENTER.lon,
        500 // custom radius — A6 does not apply
      );

      expect(result.stops).toHaveLength(0);
      expect(result.expandedRadiusApplied).toBe(false);
    });

    // -----------------------------------------------------------------------
    // 3. POSITIVE: A6 radius expansion — no stops at 1 km triggers 2 km retry
    // -----------------------------------------------------------------------
    test('(+) radius expands to 2000 m when no stops exist within the default 1000 m (A6)', async () => {
      spyRoutes([ROUTE_PRT]);
      spyStops({
        // STOP_1500M is outside 1000 m but inside 2000 m
        '61C:INBOUND': [STOP_1500M],
        '61C:OUTBOUND': []
      });

      const result = await TransitModel.getNearbyStops(
        CENTER.lat,
        CENTER.lon
        // default radius = 1000 m
      );

      expect(result.expandedRadiusApplied).toBe(true);
      expect(result.radiusMeters).toBe(2000);
      expect(result.stops).toHaveLength(1);
      expect(result.stops[0].stop.stopId).toBe('s3');
    });

    // -----------------------------------------------------------------------
    // 4. NEGATIVE: A6 expansion is NOT triggered when stops exist at 1 km
    // -----------------------------------------------------------------------
    test('(-) radius is not expanded when at least one stop lies within 1000 m', async () => {
      spyRoutes([ROUTE_PRT]);
      spyStops({
        '61C:INBOUND': [STOP_500M, STOP_1500M],
        '61C:OUTBOUND': []
      });

      const result = await TransitModel.getNearbyStops(CENTER.lat, CENTER.lon);

      expect(result.expandedRadiusApplied).toBe(false);
      expect(result.radiusMeters).toBe(1000);
      // Only the close stop should appear; the far one is excluded
      expect(result.stops).toHaveLength(1);
      expect(result.stops[0].stop.stopId).toBe('s1');
    });

    // -----------------------------------------------------------------------
    // 5. POSITIVE: walkMinutesEstimate uses the ceiling heuristic (TUC4 R4)
    // -----------------------------------------------------------------------
    test('(+) walkMinutesEstimate in each result uses the 1 km = 15 min ceiling heuristic (R4)', async () => {
      spyRoutes([ROUTE_PRT]);
      spyStops({
        '61C:INBOUND': [STOP_AT_CENTER, STOP_500M],
        '61C:OUTBOUND': []
      });

      const result = await TransitModel.getNearbyStops(CENTER.lat, CENTER.lon);

      // Stop at center: distance ≈ 0 m → 0 min
      const centerResult = result.stops.find((s) => s.stop.stopId === 's0')!;
      expect(centerResult.walkMinutesEstimate).toBe(0);

      // Stop at ~500 m: distance ~500 m → ceil(500/1000 * 15) = ceil(7.5) = 8
      const midResult = result.stops.find((s) => s.stop.stopId === 's1')!;
      expect(midResult.walkMinutesEstimate).toBeGreaterThanOrEqual(7);
      expect(midResult.walkMinutesEstimate).toBeLessThanOrEqual(9);
    });

    // -----------------------------------------------------------------------
    // 6. POSITIVE: routeId filter restricts stops to just that route
    // -----------------------------------------------------------------------
    test('(+) routeId filter limits results to stops served exclusively by that route', async () => {
      spyRoutes([ROUTE_PRT, ROUTE_PRT_P1]);
      spyStops({
        '61C:INBOUND': [STOP_500M],
        '61C:OUTBOUND': [],
        'P1:INBOUND': [STOP_900M],
        'P1:OUTBOUND': []
      });

      const result = await TransitModel.getNearbyStops(
        CENTER.lat,
        CENTER.lon,
        1000,
        { routeId: '61C' }
      );

      expect(result.stops).toHaveLength(1);
      expect(result.stops[0].stop.stopId).toBe('s1');
      // The P1 stop must not appear
      expect(result.stops.some((s) => s.stop.stopId === 's2')).toBe(false);
    });

    // -----------------------------------------------------------------------
    // 7. POSITIVE: system filter includes only routes of the given system
    // -----------------------------------------------------------------------
    test('(+) system=PRT filter excludes CMU routes and their stops', async () => {
      const cmuRoute: IRoute = {
        ...ROUTE_PRT,
        id: 'BLUE',
        name: 'Blue Route',
        system: 'CMU'
      };
      spyRoutes([ROUTE_PRT, cmuRoute]);
      // CMU stop is also inside radius — must be absent after PRT-only filter
      const cmuStop: IStop = {
        stopId: 'cmu1',
        stopName: 'CMU Stop',
        lat: CENTER.lat + 0.002,
        lon: CENTER.lon,
        dtradd: [],
        dtrrem: []
      };
      spyStops({
        '61C:INBOUND': [STOP_500M],
        '61C:OUTBOUND': [],
        'BLUE:INBOUND': [cmuStop],
        'BLUE:OUTBOUND': []
      });

      const result = await TransitModel.getNearbyStops(
        CENTER.lat,
        CENTER.lon,
        1000,
        { system: 'PRT' }
      );

      expect(result.stops.every((s) => s.stop.stopId !== 'cmu1')).toBe(true);
      expect(result.stops).toHaveLength(1);
    });

    // -----------------------------------------------------------------------
    // 8. POSITIVE: direction filter only retrieves stops for that direction
    // -----------------------------------------------------------------------
    test('(+) direction filter queries only the specified direction and excludes others', async () => {
      const stopInboundOnly: IStop = {
        stopId: 'ib1',
        stopName: 'Inbound-only Stop',
        lat: CENTER.lat + 0.002,
        lon: CENTER.lon,
        dtradd: [],
        dtrrem: []
      };
      const stopOutboundOnly: IStop = {
        stopId: 'ob1',
        stopName: 'Outbound-only Stop',
        lat: CENTER.lat + 0.003,
        lon: CENTER.lon,
        dtradd: [],
        dtrrem: []
      };
      spyRoutes([ROUTE_PRT]);
      spyStops({
        '61C:INBOUND': [stopInboundOnly],
        '61C:OUTBOUND': [stopOutboundOnly]
      });

      const result = await TransitModel.getNearbyStops(
        CENTER.lat,
        CENTER.lon,
        1000,
        { direction: 'INBOUND' }
      );

      expect(result.stops.some((s) => s.stop.stopId === 'ib1')).toBe(true);
      expect(result.stops.some((s) => s.stop.stopId === 'ob1')).toBe(false);
    });

    // -----------------------------------------------------------------------
    // 9. POSITIVE: stops shared by multiple routes accumulate all route IDs
    // -----------------------------------------------------------------------
    test('(+) a stop served by two routes carries both route IDs in routesServingStop', async () => {
      // Same stopId appears in both 61C and P1 stop lists
      const sharedStop: IStop = {
        ...STOP_500M,
        stopId: 'shared-stop'
      };
      spyRoutes([ROUTE_PRT, ROUTE_PRT_P1]);
      spyStops({
        '61C:INBOUND': [sharedStop],
        '61C:OUTBOUND': [],
        'P1:INBOUND': [sharedStop],
        'P1:OUTBOUND': []
      });

      const result = await TransitModel.getNearbyStops(CENTER.lat, CENTER.lon);

      // Shared stop must appear exactly once (deduplication)
      const matches = result.stops.filter(
        (s) => s.stop.stopId === 'shared-stop'
      );
      expect(matches).toHaveLength(1);

      // And it must carry both route IDs
      expect(matches[0].routesServingStop).toContain('61C');
      expect(matches[0].routesServingStop).toContain('P1');
    });

    // -----------------------------------------------------------------------
    // 10. NEGATIVE: includeRoutes=false strips routesServingStop from results
    // -----------------------------------------------------------------------
    test('(-) includeRoutes=false returns empty routesServingStop arrays for all stops', async () => {
      spyRoutes([ROUTE_PRT]);
      spyStops({
        '61C:INBOUND': [STOP_500M],
        '61C:OUTBOUND': []
      });

      const result = await TransitModel.getNearbyStops(
        CENTER.lat,
        CENTER.lon,
        1000,
        { includeRoutes: false }
      );

      expect(result.stops).toHaveLength(1);
      expect(result.stops[0].routesServingStop).toEqual([]);
    });

    // -----------------------------------------------------------------------
    // 11. POSITIVE: response envelope carries correct center and radius
    // -----------------------------------------------------------------------
    test('(+) response envelope reflects the exact coordinates and radius passed to the call', async () => {
      spyRoutes([ROUTE_PRT]);
      spyStops({ '61C:INBOUND': [], '61C:OUTBOUND': [] });

      const result = await TransitModel.getNearbyStops(40.4433, -79.9436, 500);

      expect(result.center).toEqual({ lat: 40.4433, lon: -79.9436 });
      expect(result.radiusMeters).toBe(500);
      expect(result.expandedRadiusApplied).toBe(false);
    });

    // -----------------------------------------------------------------------
    // 12. NEGATIVE: custom radius outside default 1000 m does NOT trigger A6 expansion
    // -----------------------------------------------------------------------
    test('(-) A6 expansion is skipped when a custom (non-default) radius is requested', async () => {
      spyRoutes([ROUTE_PRT]);
      // Only a stop well beyond 500 m but inside 1000 m default
      spyStops({
        '61C:INBOUND': [STOP_900M],
        '61C:OUTBOUND': []
      });

      // Caller asks for only 500 m — stop is outside, but expansion should NOT
      // fire because caller passed a custom (non-1000 m) radius.
      const result = await TransitModel.getNearbyStops(
        CENTER.lat,
        CENTER.lon,
        500
      );

      expect(result.expandedRadiusApplied).toBe(false);
      expect(result.stops).toHaveLength(0);
    });

    // -----------------------------------------------------------------------
    // 13. POSITIVE: distanceMeters in results is rounded to whole meters
    // -----------------------------------------------------------------------
    test('(+) distanceMeters values in results are whole integers', async () => {
      spyRoutes([ROUTE_PRT]);
      spyStops({
        '61C:INBOUND': [STOP_500M, STOP_900M],
        '61C:OUTBOUND': []
      });

      const result = await TransitModel.getNearbyStops(CENTER.lat, CENTER.lon);

      for (const stop of result.stops) {
        expect(Number.isInteger(stop.distanceMeters)).toBe(true);
      }
    });
  });
});

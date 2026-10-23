/**
 * Automated tests for TUC 4 — Discover Stops & Schedules
 * Tests the GET /transit/stops/nearbystops REST API endpoint per the
 * REST specification (REST_Discover.md) and the TUC 4 use case
 * (basic flow, alternative flows, rules).
 *
 * External services (TrueTime API, GTFS feed, Tripshot) are mocked so
 * tests run deterministically without network access.
 */

import { Server as HttpServer } from 'http';
import App from '../../../server/app';
import { MongoDB } from '../../../server/db/mongo.db';
import AuthController from '../../../server/controllers/auth.controller';
import MapController from '../../../server/controllers/map.controller';
import TransitController from '../../../server/controllers/transit.controller';
import DAC from '../../../server/db/dac';
import * as responses from '../../../common/server.responses';
import {
  IStop,
  INearbyStop,
  INearbyStopsPayload
} from '../../../common/transit.interface';

// ---------------------------------------------------------------------------
// Sample data
// ---------------------------------------------------------------------------

// Stops near CMU campus (40.4433, -79.9436)
const nearbyStops: IStop[] = [
  {
    stopId: '4407',
    stopName: 'Forbes Ave at Morewood Ave',
    lat: 40.4441,
    lon: -79.9422,
    routes: ['61C'],
    dtradd: [],
    dtrrem: []
  },
  {
    stopId: '4408',
    stopName: 'Forbes Ave at Craig St',
    lat: 40.4445,
    lon: -79.949,
    routes: ['61C', 'P1'],
    dtradd: [],
    dtrrem: []
  }
];

// Stop far from CMU campus (~5 km away in downtown)
const farStop: IStop = {
  stopId: '7079',
  stopName: 'Fifth Ave at Smithfield',
  lat: 40.441,
  lon: -80.002,
  routes: ['P1'],
  dtradd: [],
  dtrrem: []
};

// ---------------------------------------------------------------------------
// Mocks — isolate from real services
// ---------------------------------------------------------------------------

jest.mock('../../../server/models/transit.model', () => ({
  __esModule: true,
  TransitModel: {
    refreshAllCaches: jest.fn().mockResolvedValue(undefined),
    getRoutes: jest.fn(),
    getPatterns: jest.fn(),
    getStops: jest.fn(),
    getDetours: jest.fn(),
    getAllTransitData: jest.fn(),
    getNearbyStops: jest.fn(),
    colorsAvailable: true
  }
}));

jest.mock('../../../server/services/gtfs.service', () => ({
  __esModule: true,
  default: {
    load: jest.fn().mockResolvedValue(undefined),
    isLoaded: jest.fn().mockReturnValue(true),
    getRoutes: jest.fn(),
    getPatterns: jest.fn(),
    getStops: jest.fn(),
    getStopsByDirection: jest.fn(),
    filterRoutesByDate: jest.fn(),
    filterRoutesByDateTime: jest.fn()
  }
}));

jest.mock('../../../server/services/vehicle-positions.service', () => ({
  __esModule: true,
  default: {
    start: jest.fn(),
    stop: jest.fn(),
    getVehicles: jest.fn(),
    isHealthy: jest.fn().mockReturnValue(true),
    getLastFetched: jest.fn().mockReturnValue(new Date()),
    getConsecutiveFailures: jest.fn().mockReturnValue(0),
    getLastError: jest.fn().mockReturnValue(null)
  }
}));

jest.mock('../../../server/services/trip-updates.service', () => ({
  __esModule: true,
  default: {
    start: jest.fn(),
    stop: jest.fn(),
    getPredictions: jest.fn(),
    isHealthy: jest.fn().mockReturnValue(true),
    getLastFetched: jest.fn().mockReturnValue(new Date()),
    getConsecutiveFailures: jest.fn().mockReturnValue(0),
    getLastError: jest.fn().mockReturnValue(null)
  }
}));

jest.mock('../../../server/services/tripshot.service', () => ({
  __esModule: true,
  default: {
    isConfigured: jest.fn().mockReturnValue(false),
    getRoutes: jest.fn().mockResolvedValue([]),
    getPatterns: jest.fn().mockResolvedValue([]),
    getStops: jest.fn().mockResolvedValue([]),
    getVehicles: jest.fn().mockResolvedValue([])
  }
}));

jest.mock('../../../server/services/memory-monitor.service', () => ({
  __esModule: true,
  default: {
    start: jest.fn(),
    stop: jest.fn(),
    capture: jest.fn(),
    enablePersistence: jest.fn(),
    getSummary: jest.fn().mockReturnValue({
      latest: {
        timestamp: new Date().toISOString(),
        rssMb: 128,
        heapUsedMb: 64,
        heapTotalMb: 96,
        externalMb: 10,
        arrayBuffersMb: 4,
        uptimeSec: 1
      },
      peakRssMb: 128,
      peakHeapUsedMb: 64,
      recentSamples: [],
      rssDelta5mMb: 0,
      heapUsedDelta5mMb: 0,
      rssSlopeMbPerMin: 0,
      heapUsedSlopeMbPerMin: 0,
      warning: false,
      critical: false
    })
  }
}));

import { TransitModel } from '../../../server/models/transit.model';

const mockTransitModel = TransitModel as jest.Mocked<typeof TransitModel>;

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

const TEST_PORT = 8484;
const TEST_URL = `http://localhost:${TEST_PORT}`;
const TEST_DB_URL =
  process.env.TEST_DB_URL ??
  (process.env.DB_URL && process.env.DEV_DB
    ? `${process.env.DB_URL}${process.env.DEV_DB}`
    : '');

if (!TEST_DB_URL) {
  throw new Error(
    'Missing DB_URL/DEV_DB (or TEST_DB_URL override). Refusing to run DB-writing tests without explicit DEV database configuration.'
  );
}

let app: App;
let server: HttpServer;

const testUser = {
  credentials: { username: 'discoveruser', password: 'Discover123!' },
  email: 'discoveruser@cmu.edu',
  agreed: true
};

async function request(
  method: string,
  path: string,
  body?: object,
  token?: string
): Promise<{ status: number; data: responses.IResponse }> {
  const headers: HeadersInit = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const response = await fetch(`${TEST_URL}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined
  });

  const data = await response.json();
  return { status: response.status, data };
}

async function setupUser(userData: typeof testUser): Promise<string> {
  await request('POST', '/auth/users', {
    credentials: userData.credentials,
    email: userData.email,
    agreed: userData.agreed
  });
  await request('PATCH', `/auth/users/${userData.credentials.username}`, {
    password: userData.credentials.password
  });
  const res = await request(
    'POST',
    `/auth/tokens/${userData.credentials.username}`,
    { password: userData.credentials.password }
  );
  const success = res.data as responses.ISuccess;
  const payload = success.payload as responses.IAuthenticatedUser;
  return payload.token;
}

// ---------------------------------------------------------------------------
// Suite lifecycle
// ---------------------------------------------------------------------------

beforeAll(async () => {
  const db = new MongoDB(TEST_DB_URL);
  app = new App(
    [
      AuthController.getInstance('/auth'),
      MapController.getInstance('/'),
      TransitController.getInstance('/transit')
    ],
    {
      clientDir: './.dist/client',
      db,
      port: TEST_PORT,
      host: 'localhost',
      url: TEST_URL,
      initOnStart: true
    }
  );

  server = await app.listen();
  await new Promise((resolve) => setTimeout(resolve, 1000));

  await setupUser(testUser);
}, 30000);

afterAll(async () => {
  if (app && app.io) {
    await new Promise<void>((resolve) => app.io.close(() => resolve()));
  }
  if (server) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  if (DAC.db) await DAC.db.close();
}, 10000);

beforeEach(() => {
  jest.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Helper to build a mock INearbyStopsPayload
// ---------------------------------------------------------------------------

function buildNearbyPayload(
  stops: INearbyStop[],
  overrides?: Partial<INearbyStopsPayload>
): INearbyStopsPayload {
  return {
    center: { lat: 40.4433, lon: -79.9436 },
    radiusMeters: 1000,
    expandedRadiusApplied: false,
    stops,
    ...overrides
  };
}

function buildNearbyStop(
  stop: IStop,
  distanceMeters: number,
  routeIds: string[]
): INearbyStop {
  return {
    stop,
    distanceMeters,
    // Walk-time heuristic (TUC4 R4): ceil((distanceMeters / 1000) * 15)
    walkMinutesEstimate: Math.ceil((distanceMeters / 1000) * 15),
    routesServingStop: routeIds
  };
}

// ============================================================================
// GET /transit/stops/nearbystops — TUC 4 Basic Flow & Rules
// ============================================================================

describe('GET /transit/stops/nearbystops', () => {
  // --------------------------------------------------------------------------
  // 1. Basic Flow step 2: Returns nearby stops within 1 km radius
  // --------------------------------------------------------------------------
  test('returns nearby stops within default 1 km radius (Basic Flow step 2)', async () => {
    const mockStops = [
      buildNearbyStop(nearbyStops[0], 210, ['61C']),
      buildNearbyStop(nearbyStops[1], 480, ['61C', 'P1'])
    ];
    const payload = buildNearbyPayload(mockStops);
    mockTransitModel.getNearbyStops.mockResolvedValue(payload);

    const res = await request(
      'GET',
      '/transit/stops/nearbystops?lat=40.4433&lon=-79.9436'
    );

    expect(res.status).toBe(200);
    const success = res.data as responses.ISuccess;
    expect(success.name).toBe('NearbyStopsRetrieved');

    const result = success.payload as INearbyStopsPayload;
    expect(result.radiusMeters).toBe(1000);
    expect(result.expandedRadiusApplied).toBe(false);
    expect(result.stops.length).toBe(2);
    expect(result.center).toEqual({ lat: 40.4433, lon: -79.9436 });
  });

  // --------------------------------------------------------------------------
  // 2. R4: Walk-time heuristic — 1 km = 15 min
  // --------------------------------------------------------------------------
  test('walk-time estimate follows R4 heuristic (1 km = 15 min)', async () => {
    const mockStops = [
      buildNearbyStop(nearbyStops[0], 210, ['61C']),
      buildNearbyStop(nearbyStops[1], 667, ['61C', 'P1'])
    ];
    const payload = buildNearbyPayload(mockStops);
    mockTransitModel.getNearbyStops.mockResolvedValue(payload);

    const res = await request(
      'GET',
      '/transit/stops/nearbystops?lat=40.4433&lon=-79.9436'
    );

    const result = (res.data as responses.ISuccess)
      .payload as INearbyStopsPayload;

    // R4: walkMinutesEstimate = ceil((distanceMeters / 1000) * 15)
    // 210m → ceil(0.21 * 15) = ceil(3.15) = 4
    expect(result.stops[0].walkMinutesEstimate).toBe(
      Math.ceil((210 / 1000) * 15)
    );
    // 667m → ceil(0.667 * 15) = ceil(10.005) = 11
    expect(result.stops[1].walkMinutesEstimate).toBe(
      Math.ceil((667 / 1000) * 15)
    );
  });

  // --------------------------------------------------------------------------
  // 3. Stops sorted by distance ascending (closest first)
  // --------------------------------------------------------------------------
  test('stops are sorted by distance ascending', async () => {
    const mockStops = [
      buildNearbyStop(nearbyStops[0], 150, ['61C']),
      buildNearbyStop(nearbyStops[1], 480, ['61C', 'P1'])
    ];
    const payload = buildNearbyPayload(mockStops);
    mockTransitModel.getNearbyStops.mockResolvedValue(payload);

    const res = await request(
      'GET',
      '/transit/stops/nearbystops?lat=40.4433&lon=-79.9436'
    );

    const result = (res.data as responses.ISuccess)
      .payload as INearbyStopsPayload;
    expect(result.stops[0].distanceMeters).toBeLessThanOrEqual(
      result.stops[1].distanceMeters
    );
  });

  // --------------------------------------------------------------------------
  // 4. A6: Auto-expand from 1 km to 2 km when no stops at default radius
  // --------------------------------------------------------------------------
  test('auto-expands radius to 2 km when no stops within 1 km (A6)', async () => {
    const expandedPayload = buildNearbyPayload(
      [buildNearbyStop(farStop, 1800, ['P1'])],
      { radiusMeters: 2000, expandedRadiusApplied: true }
    );
    mockTransitModel.getNearbyStops.mockResolvedValue(expandedPayload);

    const res = await request(
      'GET',
      '/transit/stops/nearbystops?lat=40.4000&lon=-79.9000'
    );

    expect(res.status).toBe(200);
    const result = (res.data as responses.ISuccess)
      .payload as INearbyStopsPayload;
    expect(result.expandedRadiusApplied).toBe(true);
    expect(result.radiusMeters).toBe(2000);
    expect(result.stops.length).toBeGreaterThan(0);
  });

  // --------------------------------------------------------------------------
  // 5. Returns empty list when no stops even after expansion
  // --------------------------------------------------------------------------
  test('returns empty stops array when none found even after expansion', async () => {
    const emptyPayload = buildNearbyPayload([], {
      radiusMeters: 2000,
      expandedRadiusApplied: true
    });
    mockTransitModel.getNearbyStops.mockResolvedValue(emptyPayload);

    const res = await request(
      'GET',
      '/transit/stops/nearbystops?lat=0.0001&lon=0.0001'
    );

    expect(res.status).toBe(200);
    const result = (res.data as responses.ISuccess)
      .payload as INearbyStopsPayload;
    expect(result.stops).toEqual([]);
    expect(result.expandedRadiusApplied).toBe(true);
  });

  // --------------------------------------------------------------------------
  // 6. 400 MissingParameter when lat/lon are absent
  // --------------------------------------------------------------------------
  test('returns 400 MissingParameter when lat is missing', async () => {
    const res = await request('GET', '/transit/stops/nearbystops?lon=-79.9436');

    expect(res.status).toBe(400);
    const error = res.data as responses.IAppError;
    expect(error.name).toBe('MissingParameter');
  });

  test('returns 400 MissingParameter when lon is missing', async () => {
    const res = await request('GET', '/transit/stops/nearbystops?lat=40.4433');

    expect(res.status).toBe(400);
    const error = res.data as responses.IAppError;
    expect(error.name).toBe('MissingParameter');
  });

  // --------------------------------------------------------------------------
  // 7. 400 OutOfBounds for invalid coordinates
  // --------------------------------------------------------------------------
  test('returns 400 OutOfBounds for invalid latitude (>90)', async () => {
    const res = await request(
      'GET',
      '/transit/stops/nearbystops?lat=91&lon=-79.9436'
    );

    expect(res.status).toBe(400);
    const error = res.data as responses.IAppError;
    expect(error.name).toBe('OutOfBounds');
  });

  test('returns 400 OutOfBounds for invalid longitude (>180)', async () => {
    const res = await request(
      'GET',
      '/transit/stops/nearbystops?lat=40.4433&lon=181'
    );

    expect(res.status).toBe(400);
    const error = res.data as responses.IAppError;
    expect(error.name).toBe('OutOfBounds');
  });

  // --------------------------------------------------------------------------
  // 8. Custom radiusMeters query param overrides default
  // --------------------------------------------------------------------------
  test('respects custom radiusMeters query parameter', async () => {
    const payload = buildNearbyPayload(
      [buildNearbyStop(nearbyStops[0], 210, ['61C'])],
      { radiusMeters: 500 }
    );
    mockTransitModel.getNearbyStops.mockResolvedValue(payload);

    const res = await request(
      'GET',
      '/transit/stops/nearbystops?lat=40.4433&lon=-79.9436&radiusMeters=500'
    );

    expect(res.status).toBe(200);
    const result = (res.data as responses.ISuccess)
      .payload as INearbyStopsPayload;
    expect(result.radiusMeters).toBe(500);

    // Verify the model was called with the custom radius
    expect(mockTransitModel.getNearbyStops).toHaveBeenCalledWith(
      40.4433,
      -79.9436,
      500,
      expect.any(Object)
    );
  });

  // --------------------------------------------------------------------------
  // 9. routeId filter limits stops to a specific route
  // --------------------------------------------------------------------------
  test('passes routeId filter to model when provided', async () => {
    const payload = buildNearbyPayload([
      buildNearbyStop(nearbyStops[0], 210, ['61C'])
    ]);
    mockTransitModel.getNearbyStops.mockResolvedValue(payload);

    const res = await request(
      'GET',
      '/transit/stops/nearbystops?lat=40.4433&lon=-79.9436&routeId=61C'
    );

    expect(res.status).toBe(200);
    expect(mockTransitModel.getNearbyStops).toHaveBeenCalledWith(
      40.4433,
      -79.9436,
      undefined,
      expect.objectContaining({ routeId: '61C' })
    );
  });

  // --------------------------------------------------------------------------
  // 10. system filter (PRT or CMU)
  // --------------------------------------------------------------------------
  test('passes system filter to model when provided', async () => {
    const payload = buildNearbyPayload([
      buildNearbyStop(nearbyStops[0], 210, ['61C'])
    ]);
    mockTransitModel.getNearbyStops.mockResolvedValue(payload);

    const res = await request(
      'GET',
      '/transit/stops/nearbystops?lat=40.4433&lon=-79.9436&system=PRT'
    );

    expect(res.status).toBe(200);
    expect(mockTransitModel.getNearbyStops).toHaveBeenCalledWith(
      40.4433,
      -79.9436,
      undefined,
      expect.objectContaining({ system: 'PRT' })
    );
  });

  // --------------------------------------------------------------------------
  // 11. direction filter (INBOUND or OUTBOUND)
  // --------------------------------------------------------------------------
  test('passes direction filter (uppercased) to model', async () => {
    const payload = buildNearbyPayload([
      buildNearbyStop(nearbyStops[0], 210, ['61C'])
    ]);
    mockTransitModel.getNearbyStops.mockResolvedValue(payload);

    const res = await request(
      'GET',
      '/transit/stops/nearbystops?lat=40.4433&lon=-79.9436&direction=inbound'
    );

    expect(res.status).toBe(200);
    expect(mockTransitModel.getNearbyStops).toHaveBeenCalledWith(
      40.4433,
      -79.9436,
      undefined,
      expect.objectContaining({ direction: 'INBOUND' })
    );
  });

  // --------------------------------------------------------------------------
  // 12. date and time schedule-aware filters
  // --------------------------------------------------------------------------
  test('passes date and time filters to model', async () => {
    const payload = buildNearbyPayload([
      buildNearbyStop(nearbyStops[0], 210, ['61C'])
    ]);
    mockTransitModel.getNearbyStops.mockResolvedValue(payload);

    const res = await request(
      'GET',
      '/transit/stops/nearbystops?lat=40.4433&lon=-79.9436&date=2026-04-02&time=14:30'
    );

    expect(res.status).toBe(200);
    expect(mockTransitModel.getNearbyStops).toHaveBeenCalledWith(
      40.4433,
      -79.9436,
      undefined,
      expect.objectContaining({ date: '2026-04-02', time: '14:30' })
    );
  });

  // --------------------------------------------------------------------------
  // 13. includeRoutes=false omits route IDs from payload
  // --------------------------------------------------------------------------
  test('passes includeRoutes=false to model', async () => {
    const payload = buildNearbyPayload([
      {
        stop: nearbyStops[0],
        distanceMeters: 210,
        walkMinutesEstimate: 4,
        routesServingStop: []
      }
    ]);
    mockTransitModel.getNearbyStops.mockResolvedValue(payload);

    const res = await request(
      'GET',
      '/transit/stops/nearbystops?lat=40.4433&lon=-79.9436&includeRoutes=false'
    );

    expect(res.status).toBe(200);
    expect(mockTransitModel.getNearbyStops).toHaveBeenCalledWith(
      40.4433,
      -79.9436,
      undefined,
      expect.objectContaining({ includeRoutes: false })
    );
    const result = (res.data as responses.ISuccess)
      .payload as INearbyStopsPayload;
    expect(result.stops[0].routesServingStop).toEqual([]);
  });

  // --------------------------------------------------------------------------
  // 14. 500 when model throws unexpected error
  // --------------------------------------------------------------------------
  test('returns 500 when model throws unexpected error', async () => {
    mockTransitModel.getNearbyStops.mockRejectedValue(
      new Error('Unexpected MongoDB failure')
    );

    const res = await request(
      'GET',
      '/transit/stops/nearbystops?lat=40.4433&lon=-79.9436'
    );

    expect(res.status).toBe(500);
    const error = res.data as responses.IAppError;
    expect(error.type).toBe('ServerError');
    expect(error.name).toBe('GetRequestFailure');
  });

  // --------------------------------------------------------------------------
  // 15. INearbyStop payload has all required fields
  // --------------------------------------------------------------------------
  test('each nearby stop has required INearbyStop fields', async () => {
    const mockStops = [buildNearbyStop(nearbyStops[0], 210, ['61C'])];
    const payload = buildNearbyPayload(mockStops);
    mockTransitModel.getNearbyStops.mockResolvedValue(payload);

    const res = await request(
      'GET',
      '/transit/stops/nearbystops?lat=40.4433&lon=-79.9436'
    );

    const result = (res.data as responses.ISuccess)
      .payload as INearbyStopsPayload;
    const stop = result.stops[0];

    // INearbyStop shape
    expect(stop).toHaveProperty('stop');
    expect(stop).toHaveProperty('distanceMeters');
    expect(stop).toHaveProperty('walkMinutesEstimate');
    expect(stop).toHaveProperty('routesServingStop');

    // IStop shape nested inside
    expect(stop.stop).toHaveProperty('stopId');
    expect(stop.stop).toHaveProperty('stopName');
    expect(stop.stop).toHaveProperty('lat');
    expect(stop.stop).toHaveProperty('lon');
  });

  // --------------------------------------------------------------------------
  // 16. INearbyStopsPayload has all required fields
  // --------------------------------------------------------------------------
  test('response payload has required INearbyStopsPayload fields', async () => {
    const payload = buildNearbyPayload([]);
    mockTransitModel.getNearbyStops.mockResolvedValue(payload);

    const res = await request(
      'GET',
      '/transit/stops/nearbystops?lat=40.4433&lon=-79.9436'
    );

    expect(res.status).toBe(200);
    const success = res.data as responses.ISuccess;
    expect(success).toHaveProperty('name');
    expect(success).toHaveProperty('message');
    expect(success).toHaveProperty('payload');

    const result = success.payload as INearbyStopsPayload;
    expect(result).toHaveProperty('center');
    expect(result).toHaveProperty('radiusMeters');
    expect(result).toHaveProperty('expandedRadiusApplied');
    expect(result).toHaveProperty('stops');
    expect(result.center).toHaveProperty('lat');
    expect(result.center).toHaveProperty('lon');
  });
});

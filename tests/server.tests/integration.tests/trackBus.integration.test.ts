/**
 * Integration tests for TUC 2 — Track Bus in Real-Time
 *
 * Tests the full stack: HTTP request → Express → Controller → Services/Model → Response
 *
 * External services (TrueTime API, GTFS static parsing, GTFS-RT feeds, TripShot)
 * are mocked at the service boundary. TransitModel runs un-mocked against a real
 * MongoDB test database so that cache writes and reads are exercised end-to-end.
 */

import { Server as HttpServer } from 'http';
import App from '../../../server/app';
import { MongoDB } from '../../../server/db/mongo.db';
import AuthController from '../../../server/controllers/auth.controller';
import MapController from '../../../server/controllers/map.controller';
import BusController from '../../../server/controllers/transit.controller';
import HealthController from '../../../server/controllers/health.controller';
import DAC from '../../../server/db/dac';
import { TransitModel } from '../../../server/models/transit.model';
import * as responses from '../../../common/server.responses';
import {
  IRoute,
  IVehicle,
  IStop,
  IPrediction,
  IDetour,
  IPattern
} from '../../../common/transit.interface';

// ---------------------------------------------------------------------------
// Mocks — external service boundaries only; TransitModel is NOT mocked
// ---------------------------------------------------------------------------

// Deterministic sample routes for GTFS mock
const sampleRoutes: IRoute[] = [
  {
    id: 'P1',
    name: 'East Busway All-Stops',
    system: 'PRT',
    color: '#1e90ff',
    directions: ['INBOUND', 'OUTBOUND'],
    activeStatus: true,
    operatingDays: [1, 2, 3, 4, 5]
  },
  {
    id: '61C',
    name: 'McKeesport - Homestead',
    system: 'PRT',
    color: '#1e90ff',
    directions: ['INBOUND', 'OUTBOUND'],
    activeStatus: true,
    operatingDays: [0, 1, 2, 3, 4, 5, 6]
  }
];

const samplePatternsP1: IPattern[] = [
  {
    direction: 'INBOUND',
    path: [
      { lat: 40.441, lng: -80.002 },
      { lat: 40.445, lng: -79.995 }
    ]
  },
  {
    direction: 'OUTBOUND',
    path: [
      { lat: 40.445, lng: -79.995 },
      { lat: 40.441, lng: -80.002 }
    ]
  }
];

const sampleStopsP1Inbound: IStop[] = [
  {
    stopId: '7079',
    stopName: 'East Busway at Negley',
    lat: 40.4521,
    lon: -79.9321,
    dtradd: [],
    dtrrem: []
  }
];

const sampleStopsP1Outbound: IStop[] = [
  {
    stopId: '8192',
    stopName: 'East Busway at Wilkinsburg',
    lat: 40.4415,
    lon: -79.8822,
    dtradd: [],
    dtrrem: []
  }
];

// Deterministic vehicle data returned by the vehicle positions mock
const sampleVehiclesP1: IVehicle[] = [
  {
    vid: '3301',
    lat: 40.4425,
    lon: -79.995,
    routeId: 'P1',
    heading: 90,
    source: 'live',
    lastUpdate: '2026-03-27T10:00:00Z',
    isDetoured: false,
    delay: 0,
    tripId: 'trip-001'
  },
  {
    vid: '3302',
    lat: 40.448,
    lon: -79.987,
    routeId: 'P1',
    heading: 270,
    source: 'live',
    lastUpdate: '2026-03-27T10:00:00Z',
    isDetoured: true,
    delay: 120
  }
];

// Deterministic prediction data returned by the trip updates mock
const samplePredictions7079: IPrediction[] = [
  {
    stopId: '7079',
    routeId: 'P1',
    vid: '3301',
    predictedArrivalTime: Date.now() + 180000,
    isDelayed: false,
    minutes: 3
  },
  {
    stopId: '7079',
    routeId: 'P1',
    vid: '3302',
    predictedArrivalTime: Date.now() + 600000,
    isDelayed: true,
    minutes: 10
  }
];

// Deterministic detour data returned by TrueTime mock
const sampleDetours: IDetour[] = [
  {
    id: 'DTR_201',
    description:
      'Route P1 diverted due to construction on East Busway at Negley Station.',
    startdt: '2026-03-25T08:00:00Z',
    enddt: '2026-03-30T17:00:00Z',
    routeIds: ['P1']
  }
];

const sampleDetourGeometry = [
  {
    detourId: 'DTR_201',
    direction: 'INBOUND',
    detourPath: [
      { lat: 40.452, lng: -79.932 },
      { lat: 40.454, lng: -79.928 },
      { lat: 40.456, lng: -79.924 }
    ],
    originalPath: [
      { lat: 40.452, lng: -79.932 },
      { lat: 40.453, lng: -79.93 }
    ]
  }
];

// GTFS service: provides parsed static schedule data
jest.mock('../../../server/services/gtfs.service', () => ({
  __esModule: true,
  default: {
    load: jest.fn().mockResolvedValue(undefined),
    isLoaded: jest.fn().mockReturnValue(true),
    getRoutes: jest.fn(),
    getPatterns: jest.fn(),
    getStops: jest.fn(),
    getStopsByDirection: jest.fn(),
    getTripDirection: jest.fn(),
    getTripShapeId: jest.fn((tripId: string) => `shape-${tripId}`),
    filterRoutesByDate: jest.fn(),
    filterRoutesByDateTime: jest.fn()
  }
}));

// TrueTime: external API for route colors and detours
jest.mock('../../../server/services/truetime.service', () => ({
  __esModule: true,
  default: {
    getRoutes: jest.fn().mockResolvedValue([]),
    getDetours: jest.fn().mockResolvedValue([]),
    getDetourGeometry: jest.fn().mockResolvedValue([])
  }
}));

// Vehicle positions: GTFS-RT in-memory poller (not DB-backed)
jest.mock('../../../server/services/vehicle-positions.service', () => ({
  __esModule: true,
  default: {
    start: jest.fn(),
    stop: jest.fn(),
    getVehicles: jest.fn().mockReturnValue([]),
    isHealthy: jest.fn().mockReturnValue(true),
    getLastFetched: jest.fn().mockReturnValue(new Date()),
    getConsecutiveFailures: jest.fn().mockReturnValue(0),
    getLastError: jest.fn().mockReturnValue(null)
  }
}));

// Trip updates: GTFS-RT in-memory poller (not DB-backed)
jest.mock('../../../server/services/trip-updates.service', () => ({
  __esModule: true,
  default: {
    start: jest.fn(),
    stop: jest.fn(),
    getPredictions: jest.fn().mockReturnValue([]),
    isHealthy: jest.fn().mockReturnValue(true),
    getLastFetched: jest.fn().mockReturnValue(new Date()),
    getConsecutiveFailures: jest.fn().mockReturnValue(0),
    getLastError: jest.fn().mockReturnValue(null)
  }
}));

// Health includes the independently polled CMU feed; keep it deterministic too.
jest.mock('../../../server/services/tripshot-livestatus.service', () => ({
  __esModule: true,
  default: {
    start: jest.fn(),
    stop: jest.fn(),
    isHealthy: jest.fn().mockReturnValue(true),
    getLastFetched: jest.fn().mockReturnValue(new Date()),
    getConsecutiveFailures: jest.fn().mockReturnValue(0),
    getLastError: jest.fn().mockReturnValue(null)
  }
}));

// TripShot: CMU Shuttle external API
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

// Memory monitor: not relevant to bus tracking
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

import gtfsService from '../../../server/services/gtfs.service';
import vehiclePositionsService from '../../../server/services/vehicle-positions.service';
import tripUpdatesService from '../../../server/services/trip-updates.service';
import tripshotLiveStatusService from '../../../server/services/tripshot-livestatus.service';
import trueTimeService from '../../../server/services/truetime.service';

const mockGtfs = gtfsService as jest.Mocked<typeof gtfsService>;
const mockVehicles = vehiclePositionsService as jest.Mocked<
  typeof vehiclePositionsService
>;
const mockTrips = tripUpdatesService as jest.Mocked<typeof tripUpdatesService>;
const mockTrueTime = trueTimeService as jest.Mocked<typeof trueTimeService>;

// ---------------------------------------------------------------------------
// Test configuration
// ---------------------------------------------------------------------------

const TEST_PORT = 8289;
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function request(
  method: string,
  path: string,
  body?: object
): Promise<{ status: number; data: responses.IResponse }> {
  const headers: HeadersInit = { 'Content-Type': 'application/json' };

  const response = await fetch(`${TEST_URL}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined
  });

  const data = await response.json();
  return { status: response.status, data };
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

beforeAll(async () => {
  // Configure GTFS mock to return deterministic data
  mockGtfs.getRoutes.mockReturnValue(sampleRoutes);
  mockGtfs.getPatterns.mockImplementation((routeId: string) => {
    if (routeId === 'P1') return samplePatternsP1;
    return [];
  });
  mockGtfs.getStopsByDirection.mockImplementation(
    (routeId: string, direction: string) => {
      if (routeId === 'P1' && direction === 'INBOUND')
        return sampleStopsP1Inbound;
      if (routeId === 'P1' && direction === 'OUTBOUND')
        return sampleStopsP1Outbound;
      return [];
    }
  );
  mockGtfs.getTripDirection.mockImplementation((tripId: string) => {
    if (tripId === 'trip-001') return 'INBOUND';
    return undefined;
  });

  const db = new MongoDB(TEST_DB_URL);
  app = new App(
    [
      AuthController.getInstance('/auth'),
      MapController.getInstance('/'),
      BusController.getInstance('/transit'),
      HealthController.getInstance('/transit')
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
  await app.initComplete;

  // Populate the transit cache through the real TransitModel → MongoDB flow
  await TransitModel.refreshAllCaches();
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

// ============================================================================
// Integration Tests — TUC 2: Track Bus in Real-Time
// ============================================================================

describe('TUC 2: Track Bus in Real-Time — Integration Tests', () => {
  // --------------------------------------------------------------------------
  // 1. POSITIVE: GET /transit/vehicles/:routeId — live vehicle positions
  // --------------------------------------------------------------------------
  test('(+) GET /transit/vehicles/:routeId — live vehicles with full IVehicle fields', async () => {
    mockVehicles.getVehicles.mockReturnValue(sampleVehiclesP1);

    const res = await request('GET', '/transit/vehicles/P1');

    expect(res.status).toBe(200);
    const success = res.data as responses.ISuccess;
    expect(success.name).toBe('VehiclesLocated');
    expect(success.message).toContain('2 vehicles');

    const vehicles = success.payload as IVehicle[];
    expect(vehicles).toHaveLength(2);

    // Verify first vehicle has correct position and metadata
    const v1 = vehicles.find((v) => v.vid === '3301');
    expect(v1).toBeDefined();
    expect(v1!.lat).toBeCloseTo(40.4425, 4);
    expect(v1!.lon).toBeCloseTo(-79.995, 4);
    expect(v1!.routeId).toBe('P1');
    expect(v1!.heading).toBe(90);
    expect(v1!.source).toBe('live');
    expect(v1!.isDetoured).toBe(false);
    expect(v1!.shapeId).toBe('shape-trip-001');

    // Verify second vehicle is flagged as detoured with delay
    const v2 = vehicles.find((v) => v.vid === '3302');
    expect(v2).toBeDefined();
    expect(v2!.isDetoured).toBe(true);
    expect(v2!.delay).toBe(120);
    expect(v2!.shapeId).toBeUndefined();
  });

  // --------------------------------------------------------------------------
  // 2. POSITIVE: GET /transit/vehicles/:routeId — empty array when no active buses
  // --------------------------------------------------------------------------
  test('(+) GET /transit/vehicles/:routeId — empty array when no active buses on route', async () => {
    mockVehicles.getVehicles.mockReturnValue([]);

    const res = await request('GET', '/transit/vehicles/61C');

    expect(res.status).toBe(200);
    const success = res.data as responses.ISuccess;
    expect(success.name).toBe('VehiclesLocated');
    expect(success.message).toContain('0 vehicles');

    const vehicles = success.payload as IVehicle[];
    expect(vehicles).toHaveLength(0);
  });

  // --------------------------------------------------------------------------
  // 3. POSITIVE: GET /transit/stops/:stopId/predictions — arrival predictions
  // --------------------------------------------------------------------------
  test('(+) GET /transit/stops/:stopId/predictions — real-time arrival predictions with timing data', async () => {
    mockTrips.getPredictions.mockReturnValue(samplePredictions7079);

    const res = await request('GET', '/transit/stops/7079/predictions');

    expect(res.status).toBe(200);
    const success = res.data as responses.ISuccess;
    expect(success.name).toBe('PredictionsRetrieved');
    expect(success.message).toContain('2 predictions');

    const predictions = success.payload as IPrediction[];
    expect(predictions).toHaveLength(2);

    // First prediction: on-time arrival in 3 minutes
    const p1 = predictions.find((p) => p.vid === '3301');
    expect(p1).toBeDefined();
    expect(p1!.stopId).toBe('7079');
    expect(p1!.routeId).toBe('P1');
    expect(p1!.minutes).toBe(3);
    expect(p1!.isDelayed).toBe(false);

    // Second prediction: delayed arrival in 10 minutes
    const p2 = predictions.find((p) => p.vid === '3302');
    expect(p2).toBeDefined();
    expect(p2!.minutes).toBe(10);
    expect(p2!.isDelayed).toBe(true);
  });

  // --------------------------------------------------------------------------
  // 4. POSITIVE: GET /transit/stops/:stopId/predictions — empty when no arrivals
  // --------------------------------------------------------------------------
  test('(+) GET /transit/stops/:stopId/predictions — empty predictions for stop with no upcoming arrivals', async () => {
    mockTrips.getPredictions.mockReturnValue([]);

    const res = await request('GET', '/transit/stops/9999/predictions');

    expect(res.status).toBe(200);
    const success = res.data as responses.ISuccess;
    expect(success.name).toBe('PredictionsRetrieved');
    expect(success.message).toContain('0 predictions');

    const predictions = success.payload as IPrediction[];
    expect(predictions).toHaveLength(0);
  });

  // --------------------------------------------------------------------------
  // 5. POSITIVE: GET /transit/health — all services healthy
  // --------------------------------------------------------------------------
  test('(+) GET /transit/health — healthy status when all upstream feeds are operational', async () => {
    mockGtfs.isLoaded.mockReturnValue(true);
    jest.mocked(tripshotLiveStatusService.isHealthy).mockReturnValue(true);
    mockVehicles.isHealthy.mockReturnValue(true);
    mockVehicles.getConsecutiveFailures.mockReturnValue(0);
    mockVehicles.getLastError.mockReturnValue(null);
    mockTrips.isHealthy.mockReturnValue(true);
    mockTrips.getConsecutiveFailures.mockReturnValue(0);
    mockTrips.getLastError.mockReturnValue(null);

    const res = await request('GET', '/transit/health');

    expect(res.status).toBe(200);
    const status = res.data as unknown as Record<string, unknown>;
    expect(status.overall).toBe(true);
    expect(status.gtfs).toEqual({ ready: true });

    // Verify vehicle positions health subsection
    const vpHealth = status.vehiclePositions as Record<string, unknown>;
    expect(vpHealth.healthy).toBe(true);
    expect(vpHealth.consecutiveFailures).toBe(0);
    expect(vpHealth.error).toBeNull();

    // Verify trip updates health subsection
    const tuHealth = status.tripUpdates as Record<string, unknown>;
    expect(tuHealth.healthy).toBe(true);
    expect(tuHealth.consecutiveFailures).toBe(0);
    expect(tuHealth.error).toBeNull();
  });

  test('(-) GET /transit/health — not ready while static schedules are still loading', async () => {
    mockGtfs.isLoaded.mockReturnValue(false);
    mockVehicles.isHealthy.mockReturnValue(true);
    mockTrips.isHealthy.mockReturnValue(true);
    jest.mocked(tripshotLiveStatusService.isHealthy).mockReturnValue(true);
    try {
      const res = await request('GET', '/transit/health');
      expect(res.status).toBe(200);
      expect(res.data).toMatchObject({
        gtfs: { ready: false },
        overall: false
      });
    } finally {
      mockGtfs.isLoaded.mockReturnValue(true);
    }
  });

  test('(-) GET /transit/health — not ready before the first CMU live sample', async () => {
    mockGtfs.isLoaded.mockReturnValue(true);
    mockVehicles.isHealthy.mockReturnValue(true);
    mockTrips.isHealthy.mockReturnValue(true);
    jest.mocked(tripshotLiveStatusService.isHealthy).mockReturnValue(false);
    jest.mocked(tripshotLiveStatusService.getLastFetched).mockReturnValue(null);
    try {
      const res = await request('GET', '/transit/health');
      expect(res.status).toBe(200);
      expect(res.data).toMatchObject({
        tripshotLiveStatus: { healthy: false, lastFetched: null },
        overall: false
      });
    } finally {
      jest.mocked(tripshotLiveStatusService.isHealthy).mockReturnValue(true);
      jest
        .mocked(tripshotLiveStatusService.getLastFetched)
        .mockReturnValue(new Date());
    }
  });

  // --------------------------------------------------------------------------
  // 6. NEGATIVE: GET /transit/health — degraded when GTFS-RT feed fails
  // --------------------------------------------------------------------------
  test('(-) GET /transit/health — degraded status when vehicle positions feed has consecutive failures', async () => {
    mockVehicles.isHealthy.mockReturnValue(false);
    mockVehicles.getConsecutiveFailures.mockReturnValue(5);
    mockVehicles.getLastError.mockReturnValue('ECONNREFUSED');
    mockTrips.isHealthy.mockReturnValue(true);
    mockTrips.getConsecutiveFailures.mockReturnValue(0);
    mockTrips.getLastError.mockReturnValue(null);

    const res = await request('GET', '/transit/health');

    expect(res.status).toBe(200);
    const status = res.data as unknown as Record<string, unknown>;
    expect(status.overall).toBe(false);

    const vpHealth = status.vehiclePositions as Record<string, unknown>;
    expect(vpHealth.healthy).toBe(false);
    expect(vpHealth.consecutiveFailures).toBe(5);
    expect(vpHealth.error).toBe('ECONNREFUSED');

    // Trip updates should still be healthy independently
    const tuHealth = status.tripUpdates as Record<string, unknown>;
    expect(tuHealth.healthy).toBe(true);
  });

  // --------------------------------------------------------------------------
  // 7. POSITIVE: GET /transit/detours/:routeId — active detours from cache
  // --------------------------------------------------------------------------
  test('(+) GET /transit/detours/:routeId — active detour with description and date range', async () => {
    // Clear the detour cache so the model will re-fetch from TrueTime mock
    await TransitModel.clearCache('detours');
    mockTrueTime.getDetours.mockResolvedValue(sampleDetours);

    const res = await request('GET', '/transit/detours/P1');

    expect(res.status).toBe(200);
    const success = res.data as responses.ISuccess;
    expect(success.name).toBe('DetoursRetrieved');

    const detours = success.payload as IDetour[];
    expect(detours.length).toBeGreaterThanOrEqual(1);

    const detour = detours.find((d) => d.id === 'DTR_201');
    expect(detour).toBeDefined();
    expect(detour!.description).toContain('construction');
    expect(detour!.description).toContain('Negley Station');
    expect(detour!.startdt).toBe('2026-03-25T08:00:00Z');
    expect(detour!.enddt).toBe('2026-03-30T17:00:00Z');
  });

  // --------------------------------------------------------------------------
  // 8. POSITIVE: GET /transit/detours/:routeId/geometry — detour overlay data
  // --------------------------------------------------------------------------
  test('(+) GET /transit/detours/:routeId/geometry — detour with divergent path segments for map overlay', async () => {
    await TransitModel.clearCache('detours');
    mockTrueTime.getDetours.mockResolvedValue(sampleDetours);
    mockTrueTime.getDetourGeometry.mockResolvedValue(sampleDetourGeometry);

    const res = await request('GET', '/transit/detours/P1/geometry');

    expect(res.status).toBe(200);
    const success = res.data as responses.ISuccess;
    expect(success.name).toBe('DetoursRetrieved');

    const detours = success.payload as IDetour[];
    expect(detours.length).toBeGreaterThanOrEqual(1);

    const withGeom = detours.find((d) => d.id === 'DTR_201');
    expect(withGeom).toBeDefined();
    expect(withGeom!.geometry).toBeDefined();
    expect(withGeom!.geometry!.length).toBeGreaterThanOrEqual(1);

    // Verify geometry contains the detour path coordinates
    const geom = withGeom!.geometry![0];
    expect(geom.detourId).toBe('DTR_201');
    expect(geom.direction).toBe('INBOUND');
    expect(geom.detourPath.length).toBe(3);
    expect(geom.detourPath[0]).toEqual({ lat: 40.452, lng: -79.932 });
  });

  // --------------------------------------------------------------------------
  // 9. NEGATIVE: GET /transit/detours/:routeId — no detours for route
  // --------------------------------------------------------------------------
  test('(-) GET /transit/detours/:routeId — empty detours when route has no active diversions', async () => {
    await TransitModel.clearCache('detours');
    mockTrueTime.getDetours.mockResolvedValue([]);

    const res = await request('GET', '/transit/detours/61C');

    expect(res.status).toBe(200);
    const success = res.data as responses.ISuccess;
    expect(success.name).toBe('DetoursRetrieved');
    expect(success.message).toContain('0 detours');

    const detours = success.payload as IDetour[];
    expect(detours).toHaveLength(0);
  });

  // --------------------------------------------------------------------------
  // 10. NEGATIVE: GET /transit/detours/:routeId/geometry — no geometry available
  // --------------------------------------------------------------------------
  test('(-) GET /transit/detours/:routeId/geometry — empty when detour has no geometry data', async () => {
    // Detour exists but TrueTime returns no geometry for it
    await TransitModel.clearCache('detours');
    mockTrueTime.getDetours.mockResolvedValue([
      {
        id: 'DTR_301',
        description: 'Minor delay on 61C',
        startdt: '2026-03-27T06:00:00Z',
        enddt: '2026-03-27T18:00:00Z',
        routeIds: ['61C']
      }
    ]);
    mockTrueTime.getDetourGeometry.mockResolvedValue([]);

    const res = await request('GET', '/transit/detours/61C/geometry');

    expect(res.status).toBe(200);
    const success = res.data as responses.ISuccess;
    expect(success.name).toBe('DetoursRetrieved');

    // The controller filters to only detours WITH geometry
    const detours = success.payload as IDetour[];
    expect(detours).toHaveLength(0);
  });

  // --------------------------------------------------------------------------
  // 11. POSITIVE: GET /transit/vehicles/:routeId — CMU shuttle returns empty
  //     when TripShot is not configured
  // --------------------------------------------------------------------------
  test('(+) GET /transit/vehicles/CMU-A — empty vehicles when TripShot is not configured', async () => {
    const res = await request('GET', '/transit/vehicles/CMU-A');

    expect(res.status).toBe(200);
    const success = res.data as responses.ISuccess;
    expect(success.name).toBe('VehiclesLocated');

    const vehicles = success.payload as IVehicle[];
    expect(vehicles).toHaveLength(0);
  });

  // --------------------------------------------------------------------------
  // 12. NEGATIVE: GET /transit/health — both feeds unhealthy
  // --------------------------------------------------------------------------
  test('(-) GET /transit/health — overall unhealthy when both vehicle and trip feeds fail', async () => {
    mockVehicles.isHealthy.mockReturnValue(false);
    mockVehicles.getConsecutiveFailures.mockReturnValue(10);
    mockVehicles.getLastError.mockReturnValue('ETIMEDOUT');
    mockTrips.isHealthy.mockReturnValue(false);
    mockTrips.getConsecutiveFailures.mockReturnValue(8);
    mockTrips.getLastError.mockReturnValue('ECONNRESET');

    const res = await request('GET', '/transit/health');

    expect(res.status).toBe(200);
    const status = res.data as unknown as Record<string, unknown>;
    expect(status.overall).toBe(false);

    const vpHealth = status.vehiclePositions as Record<string, unknown>;
    expect(vpHealth.healthy).toBe(false);
    expect(vpHealth.consecutiveFailures).toBe(10);
    expect(vpHealth.error).toBe('ETIMEDOUT');

    const tuHealth = status.tripUpdates as Record<string, unknown>;
    expect(tuHealth.healthy).toBe(false);
    expect(tuHealth.consecutiveFailures).toBe(8);
    expect(tuHealth.error).toBe('ECONNRESET');
  });
});

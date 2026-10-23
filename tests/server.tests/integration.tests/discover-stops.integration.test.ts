/**
 * Integration tests for TUC 4 — Discover Stops & Schedules
 *
 * Tests the full stack: HTTP request → Express → Controller → TransitModel → in-memory cache
 *
 * External services (GTFS, TrueTime, vehicle positions, trip updates, TripShot)
 * are mocked at the service boundary. TransitModel runs un-mocked with an in-memory
 * bulk cache populated by refreshAllCaches() from mock GTFS data, so the complete
 * geospatial filtering and walk-time logic is exercised end-to-end.
 */

import { Server as HttpServer } from 'http';
import App from '../../../server/app';
import { MongoDB } from '../../../server/db/mongo.db';
import AuthController from '../../../server/controllers/auth.controller';
import MapController from '../../../server/controllers/map.controller';
import TransitController from '../../../server/controllers/transit.controller';
import DAC from '../../../server/db/dac';
import { TransitModel } from '../../../server/models/transit.model';
import * as responses from '../../../common/server.responses';
import {
  IRoute,
  IStop,
  IPattern,
  IPrediction,
  IBulkTransitData,
  INearbyStopsPayload,
  INearbyStop
} from '../../../common/transit.interface';

// ---------------------------------------------------------------------------
// Mocks — external service boundaries only; TransitModel is NOT mocked
// ---------------------------------------------------------------------------

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

// Trip updates: GTFS-RT in-memory poller for stop-level predictions
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

// TripShot: CMU Shuttle external API
jest.mock('../../../server/services/tripshot.service', () => ({
  __esModule: true,
  default: {
    isConfigured: jest.fn().mockReturnValue(false),
    getRoutes: jest.fn().mockResolvedValue([]),
    getPatterns: jest.fn().mockResolvedValue([]),
    getStops: jest.fn().mockResolvedValue([]),
    getVehicles: jest.fn().mockResolvedValue([]),
    getPredictions: jest.fn().mockReturnValue([])
  }
}));

// Memory monitor: not relevant to stop discovery
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
import tripUpdatesService from '../../../server/services/trip-updates.service';

const mockGtfs = gtfsService as jest.Mocked<typeof gtfsService>;
const mockTripUpdates = tripUpdatesService as jest.Mocked<
  typeof tripUpdatesService
>;

// ---------------------------------------------------------------------------
// Deterministic sample transit data
// ---------------------------------------------------------------------------

const sampleRoutes: IRoute[] = [
  {
    id: '71A',
    name: 'Highland - Swissvale',
    system: 'PRT',
    color: '#1e90ff',
    directions: ['INBOUND', 'OUTBOUND'],
    activeStatus: true,
    operatingDays: [0, 1, 2, 3, 4, 5, 6]
  },
  {
    id: 'P1',
    name: 'East Busway All-Stops',
    system: 'PRT',
    color: '#1e90ff',
    directions: ['INBOUND', 'OUTBOUND'],
    activeStatus: true,
    operatingDays: [1, 2, 3, 4, 5]
  }
];

// Test query origin — CMU campus area
const CENTER_LAT = 40.4433;
const CENTER_LON = -79.9436;

// 71A INBOUND — two stops within ~270 m of the center
const stops71AInbound: IStop[] = [
  {
    stopId: '4407',
    stopName: 'Forbes Ave at CMU Main Entrance',
    lat: 40.4438, // ~75 m from center
    lon: -79.943,
    dtradd: [],
    dtrrem: []
  },
  {
    stopId: '4409',
    stopName: 'Forbes Ave at Morewood Ave',
    lat: 40.4443, // ~269 m from center
    lon: -79.9407,
    dtradd: [],
    dtrrem: []
  }
];

// 71A OUTBOUND — one stop within ~257 m of the center
const stops71AOutbound: IStop[] = [
  {
    stopId: '4408',
    stopName: 'Forbes Ave at Craig St',
    lat: 40.4448, // ~257 m from center
    lon: -79.9459,
    dtradd: [],
    dtrrem: []
  }
];

// P1 INBOUND — one stop within ~153 m of the center (P1-only, not served by 71A)
const stopsP1Inbound: IStop[] = [
  {
    stopId: '7079',
    stopName: 'Murray Ave at Forbes',
    lat: 40.4445, // ~153 m from center
    lon: -79.9445,
    dtradd: [],
    dtrrem: []
  }
];

const samplePatterns71A: IPattern[] = [
  {
    direction: 'INBOUND',
    path: [
      { lat: 40.438, lng: -79.945 },
      { lat: 40.445, lng: -79.94 }
    ]
  },
  {
    direction: 'OUTBOUND',
    path: [
      { lat: 40.445, lng: -79.94 },
      { lat: 40.438, lng: -79.945 }
    ]
  }
];

const samplePatternsP1: IPattern[] = [
  {
    direction: 'INBOUND',
    path: [
      { lat: 40.441, lng: -80.002 },
      { lat: 40.445, lng: -79.995 }
    ]
  }
];

// Predictions returned by the mocked trip-updates service for stop 4407
const samplePredictions: IPrediction[] = [
  {
    stopId: '4407',
    routeId: '71A',
    vid: '5510',
    predictedArrivalTime: 1700000300,
    isDelayed: false,
    minutes: 5
  },
  {
    stopId: '4407',
    routeId: '71D',
    vid: '5520',
    predictedArrivalTime: 1700000720,
    isDelayed: true,
    minutes: 12
  }
];

// ---------------------------------------------------------------------------
// Test configuration
// ---------------------------------------------------------------------------

const TEST_PORT = 8291;
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

const testUser = {
  credentials: { username: 'discoverstopsuser', password: 'Discover123!' },
  email: 'discoverstopsuser@cmu.edu',
  agreed: true
};

let app: App;
let server: HttpServer;
let memberToken: string;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
// Lifecycle
// ---------------------------------------------------------------------------

beforeAll(async () => {
  // Configure GTFS mock to return deterministic fixture data
  mockGtfs.getRoutes.mockReturnValue(sampleRoutes);
  mockGtfs.getPatterns.mockImplementation((routeId: string) => {
    if (routeId === '71A') return samplePatterns71A;
    if (routeId === 'P1') return samplePatternsP1;
    return [];
  });
  mockGtfs.getStopsByDirection.mockImplementation(
    (routeId: string, direction: string) => {
      if (routeId === '71A' && direction === 'INBOUND') return stops71AInbound;
      if (routeId === '71A' && direction === 'OUTBOUND')
        return stops71AOutbound;
      if (routeId === 'P1' && direction === 'INBOUND') return stopsP1Inbound;
      return [];
    }
  );

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
  await app.initComplete;

  memberToken = await setupUser(testUser);

  // Populate the in-memory bulk cache (routes + patterns + stops) so that
  // TransitModel.getNearbyStops and all related endpoints have data to serve.
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
// Integration Tests — TUC 4: Discover Stops & Schedules
// ============================================================================

describe('TUC 4: Discover Stops & Schedules — Integration Tests', () => {
  // --------------------------------------------------------------------------
  // 1. POSITIVE: nearbystops from campus center — all 4 stops within 1 km,
  //    sorted closest-first with correct INearbyStop fields
  // --------------------------------------------------------------------------
  test('(+) GET /transit/stops/nearbystops from campus center — nearby stops sorted by distance with full INearbyStop fields', async () => {
    const res = await request(
      'GET',
      `/transit/stops/nearbystops?lat=${CENTER_LAT}&lon=${CENTER_LON}`
    );

    expect(res.status).toBe(200);
    const success = res.data as responses.ISuccess;
    expect(success.name).toBe('NearbyStopsRetrieved');

    const payload = success.payload as INearbyStopsPayload;
    expect(payload.center).toEqual({ lat: CENTER_LAT, lon: CENTER_LON });
    expect(payload.radiusMeters).toBe(1000);
    expect(payload.expandedRadiusApplied).toBe(false);

    // All 4 fixture stops are within 270 m of the center
    expect(payload.stops.length).toBe(4);

    // Stops must be sorted ascending by distanceMeters
    for (let i = 0; i < payload.stops.length - 1; i++) {
      expect(payload.stops[i].distanceMeters).toBeLessThanOrEqual(
        payload.stops[i + 1].distanceMeters
      );
    }

    // Closest stop is 4407 (~75 m); verify all INearbyStop fields
    const closest = payload.stops[0] as INearbyStop;
    expect(closest.stop.stopId).toBe('4407');
    expect(closest.stop.stopName).toBe('Forbes Ave at CMU Main Entrance');
    expect(closest.distanceMeters).toBeGreaterThan(0);
    expect(closest.distanceMeters).toBeLessThan(200); // confirmed ~75 m
    expect(closest.walkMinutesEstimate).toBe(2); // ceil((75/1000)*15) = 2
    expect(closest.routesServingStop).toContain('71A');
  });

  // --------------------------------------------------------------------------
  // 2. POSITIVE: nearbystops with routeId filter — only 71A stops returned,
  //    P1-only stop excluded from results
  // --------------------------------------------------------------------------
  test('(+) GET /transit/stops/nearbystops?routeId=71A — only stops served by 71A with no P1-only stops', async () => {
    const res = await request(
      'GET',
      `/transit/stops/nearbystops?lat=${CENTER_LAT}&lon=${CENTER_LON}&routeId=71A`
    );

    expect(res.status).toBe(200);
    const success = res.data as responses.ISuccess;
    expect(success.name).toBe('NearbyStopsRetrieved');

    const payload = success.payload as INearbyStopsPayload;

    // 71A has 3 fixture stops: 4407 (INBOUND), 4409 (INBOUND), 4408 (OUTBOUND)
    expect(payload.stops.length).toBe(3);

    const returnedIds = payload.stops.map((s) => s.stop.stopId);
    expect(returnedIds).toContain('4407');
    expect(returnedIds).toContain('4408');
    expect(returnedIds).toContain('4409');

    // Stop 7079 is served only by P1 — must not appear in a 71A-only query
    expect(returnedIds).not.toContain('7079');

    // Every returned stop must report 71A as a serving route
    for (const nearby of payload.stops) {
      expect(nearby.routesServingStop).toContain('71A');
    }
  });

  // --------------------------------------------------------------------------
  // 3. POSITIVE: nearbystops from a location 1.5 km away — TUC4 A6 auto-
  //    expansion kicks in (no stops within 1 km, stops found within 2 km)
  // --------------------------------------------------------------------------
  test('(+) GET /transit/stops/nearbystops from 1.5 km away — A6 radius auto-expansion with expandedRadiusApplied=true', async () => {
    // Query from ~1.5 km south of all fixture stops; no stop is within 1 km
    // but all four are within 2 km — triggers TUC4 A6 expansion rule
    const FAR_LAT = 40.43;
    const FAR_LON = CENTER_LON;

    const res = await request(
      'GET',
      `/transit/stops/nearbystops?lat=${FAR_LAT}&lon=${FAR_LON}`
    );

    expect(res.status).toBe(200);
    const success = res.data as responses.ISuccess;
    expect(success.name).toBe('NearbyStopsRetrieved');

    const payload = success.payload as INearbyStopsPayload;
    expect(payload.expandedRadiusApplied).toBe(true);
    expect(payload.radiusMeters).toBe(2000);
    expect(payload.center).toEqual({ lat: FAR_LAT, lon: FAR_LON });

    // All fixture stops are 1.5–1.7 km from FAR_LAT — visible after expansion
    expect(payload.stops.length).toBe(4);

    // Every returned stop must be beyond the original 1 km radius
    for (const nearby of payload.stops) {
      expect(nearby.distanceMeters).toBeGreaterThan(1000);
      expect(nearby.distanceMeters).toBeLessThanOrEqual(2000);
    }
  });

  // --------------------------------------------------------------------------
  // 4. POSITIVE: nearbystops with includeRoutes=false — routesServingStop is
  //    empty for every result to reduce payload size
  // --------------------------------------------------------------------------
  test('(+) GET /transit/stops/nearbystops?includeRoutes=false — routesServingStop omitted from all results', async () => {
    const res = await request(
      'GET',
      `/transit/stops/nearbystops?lat=${CENTER_LAT}&lon=${CENTER_LON}&includeRoutes=false`
    );

    expect(res.status).toBe(200);
    const success = res.data as responses.ISuccess;
    expect(success.name).toBe('NearbyStopsRetrieved');

    const payload = success.payload as INearbyStopsPayload;
    expect(payload.stops.length).toBeGreaterThan(0);

    // With includeRoutes=false every stop's route list must be empty
    for (const nearby of payload.stops) {
      expect(nearby.routesServingStop).toEqual([]);
    }

    // Core stop data (id, name, coordinates) must still be present
    const first = payload.stops[0];
    expect(first.stop.stopId).toBeTruthy();
    expect(first.stop.stopName).toBeTruthy();
    expect(typeof first.distanceMeters).toBe('number');
    expect(first.walkMinutesEstimate).toBeGreaterThan(0);
  });

  // --------------------------------------------------------------------------
  // 5. POSITIVE: predictions for a known stop ID — PredictionsRetrieved with
  //    full IPrediction fields including routeId, minutes, and isDelayed flag
  // --------------------------------------------------------------------------
  test('(+) GET /transit/stops/4407/predictions — PredictionsRetrieved with two arrivals and correct IPrediction fields', async () => {
    // Configure trip-updates mock to return two predictions for this stop
    mockTripUpdates.getPredictions.mockReturnValueOnce(samplePredictions);

    const res = await request('GET', '/transit/stops/4407/predictions');

    expect(res.status).toBe(200);
    const success = res.data as responses.ISuccess;
    expect(success.name).toBe('PredictionsRetrieved');

    const predictions = success.payload as IPrediction[];
    expect(predictions.length).toBe(2);

    // First prediction: on-time 71A arrival in 5 minutes
    expect(predictions[0].stopId).toBe('4407');
    expect(predictions[0].routeId).toBe('71A');
    expect(predictions[0].minutes).toBe(5);
    expect(predictions[0].isDelayed).toBe(false);
    expect(predictions[0].vid).toBe('5510');

    // Second prediction: delayed 71D arrival in 12 minutes
    expect(predictions[1].routeId).toBe('71D');
    expect(predictions[1].minutes).toBe(12);
    expect(predictions[1].isDelayed).toBe(true);
  });

  // --------------------------------------------------------------------------
  // 6. POSITIVE: GET /transit/bulk — IBulkTransitData contains seeded routes,
  //    patterns keyed by routeId, and stops keyed by "routeId:DIRECTION"
  // --------------------------------------------------------------------------
  test('(+) GET /transit/bulk — IBulkTransitData with both seeded routes, 71A patterns, and 71A:INBOUND stops', async () => {
    const res = await request('GET', '/transit/bulk');

    expect(res.status).toBe(200);
    const success = res.data as responses.ISuccess;
    expect(success.name).toBe('BulkDataRetrieved');

    const bulk = success.payload as IBulkTransitData;

    // Both fixture routes must be present
    const routeIds = bulk.routes.map((r) => r.id);
    expect(routeIds).toContain('71A');
    expect(routeIds).toContain('P1');

    // Patterns keyed by routeId
    expect(bulk.patterns).toHaveProperty('71A');
    expect(bulk.patterns['71A'].length).toBe(2); // INBOUND + OUTBOUND
    expect(bulk.patterns['71A'][0]).toHaveProperty('direction');
    expect(bulk.patterns['71A'][0]).toHaveProperty('path');

    // Stops keyed by "routeId:DIRECTION"
    expect(bulk.stops).toHaveProperty('71A:INBOUND');
    const inboundStops = bulk.stops['71A:INBOUND'];
    expect(inboundStops.length).toBe(2);
    expect(inboundStops.map((s) => s.stopId)).toContain('4407');
    expect(inboundStops.map((s) => s.stopId)).toContain('4409');

    expect(bulk.stops).toHaveProperty('71A:OUTBOUND');
    expect(bulk.stops['71A:OUTBOUND'][0].stopId).toBe('4408');

    expect(bulk.stops).toHaveProperty('P1:INBOUND');
    expect(bulk.stops['P1:INBOUND'][0].stopId).toBe('7079');
  });

  // --------------------------------------------------------------------------
  // 7. NEGATIVE: nearbystops without lat — 400 MissingParameter
  // --------------------------------------------------------------------------
  test('(-) GET /transit/stops/nearbystops without lat — 400 MissingParameter referencing lat and lon', async () => {
    const res = await request(
      'GET',
      `/transit/stops/nearbystops?lon=${CENTER_LON}`
    );

    expect(res.status).toBe(400);
    const error = res.data as responses.IAppError;
    expect(error.name).toBe('MissingParameter');
    expect(error.message).toMatch(/lat/i);
    expect(error.message).toMatch(/lon/i);
  });

  // --------------------------------------------------------------------------
  // 8. NEGATIVE: nearbystops with lat outside valid globe range — 400 OutOfBounds
  // --------------------------------------------------------------------------
  test('(-) GET /transit/stops/nearbystops with lat=999 — 400 OutOfBounds with valid-range message', async () => {
    const res = await request(
      'GET',
      `/transit/stops/nearbystops?lat=999&lon=${CENTER_LON}`
    );

    expect(res.status).toBe(400);
    const error = res.data as responses.IAppError;
    expect(error.name).toBe('OutOfBounds');
    expect(error.message).toMatch(/range/i);
  });
});

/**
 * Integration tests for TUC 1 — Visualize Routes
 *
 * Tests the full stack: HTTP request → Express → Controller → TransitModel → MongoDB
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
import TransitController from '../../../server/controllers/transit.controller';
import DAC from '../../../server/db/dac';
import { TransitModel } from '../../../server/models/transit.model';
import * as responses from '../../../common/server.responses';
import {
  IRoute,
  IStop,
  IPattern,
  IBulkTransitData
} from '../../../common/transit.interface';
import { IConfig } from '../../../common/map.interface';

// ---------------------------------------------------------------------------
// Mocks — external service boundaries only; TransitModel is NOT mocked
// ---------------------------------------------------------------------------

// Deterministic sample data that GTFS mock will return
const sampleRoutes: IRoute[] = [
  {
    id: 'P1',
    name: 'East Busway All-Stops',
    system: 'PRT',
    color: '#1e90ff', // GTFS default before TrueTime merge
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
      { lat: 40.445, lng: -79.995 },
      { lat: 40.452, lng: -79.982 }
    ]
  },
  {
    direction: 'OUTBOUND',
    path: [
      { lat: 40.452, lng: -79.982 },
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
  },
  {
    stopId: '7080',
    stopName: 'East Busway at Penn',
    lat: 40.4612,
    lon: -79.9198,
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

// Memory monitor: not relevant to transit visualization
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
const mockGtfs = gtfsService as jest.Mocked<typeof gtfsService>;

// ---------------------------------------------------------------------------
// Test configuration
// ---------------------------------------------------------------------------

const TEST_PORT = 8287;
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
  credentials: { username: 'visrouteuser', password: 'VisRoute123!' },
  email: 'visrouteuser@cmu.edu',
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

  // Populate the transit cache through the real TransitModel → MongoDB flow.
  // This seeds routes, patterns, and stops into the DB from the mocked GTFS data.
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
// Integration Tests — TUC 1: Visualize Routes
// ============================================================================

describe('TUC 1: Visualize Routes — Integration Tests', () => {
  // --------------------------------------------------------------------------
  // 1. POSITIVE: GET /transit/routes returns cached routes with correct fields
  // --------------------------------------------------------------------------
  test('(+) GET /transit/routes — cached PRT routes with all IRoute fields', async () => {
    const res = await request('GET', '/transit/routes');

    expect(res.status).toBe(200);
    const success = res.data as responses.ISuccess;
    expect(success.name).toBe('RoutesRetrieved');

    const routes = success.payload as IRoute[];
    expect(routes.length).toBe(2);

    // Verify first route has all IRoute fields with expected values
    const p1 = routes.find((r) => r.id === 'P1');
    expect(p1).toBeDefined();
    expect(p1!.name).toBe('East Busway All-Stops');
    expect(p1!.system).toBe('PRT');
    expect(p1!.directions).toEqual(['INBOUND', 'OUTBOUND']);
    expect(p1!.activeStatus).toBe(true);
    expect(p1!.operatingDays).toEqual([1, 2, 3, 4, 5]);

    // Verify second route
    const c61 = routes.find((r) => r.id === '61C');
    expect(c61).toBeDefined();
    expect(c61!.name).toBe('McKeesport - Homestead');
  });

  // --------------------------------------------------------------------------
  // 2. POSITIVE: GET /transit/routes/:id returns IPattern[] from MongoDB cache
  // --------------------------------------------------------------------------
  test('(+) GET /transit/routes/:id — route patterns with INBOUND and OUTBOUND paths', async () => {
    const res = await request('GET', '/transit/routes/P1');

    expect(res.status).toBe(200);
    const success = res.data as responses.ISuccess;
    expect(success.name).toBe('PathGenerated');

    const patterns = success.payload as IPattern[];
    expect(patterns.length).toBe(2);

    const inbound = patterns.find((p) => p.direction === 'INBOUND');
    const outbound = patterns.find((p) => p.direction === 'OUTBOUND');
    expect(inbound).toBeDefined();
    expect(outbound).toBeDefined();

    // Verify path coordinates are lat/lng objects
    expect(inbound!.path.length).toBe(3);
    expect(inbound!.path[0]).toEqual({ lat: 40.441, lng: -80.002 });
    expect(outbound!.path[0]).toEqual({ lat: 40.452, lng: -79.982 });
  });

  // --------------------------------------------------------------------------
  // 3. POSITIVE: GET /transit/stops/:routeId?dir=INBOUND — stops from cache
  // --------------------------------------------------------------------------
  test('(+) GET /transit/stops/:routeId?dir=INBOUND — cached stops with correct IStop fields', async () => {
    const res = await request('GET', '/transit/stops/P1?dir=INBOUND');

    expect(res.status).toBe(200);
    const success = res.data as responses.ISuccess;
    expect(success.name).toBe('StopsRetrieved');

    const stops = success.payload as IStop[];
    expect(stops.length).toBe(2);

    const stop = stops.find((s) => s.stopId === '7079');
    expect(stop).toBeDefined();
    expect(stop!.stopName).toBe('East Busway at Negley');
    expect(stop!.lat).toBeCloseTo(40.4521, 4);
    expect(stop!.lon).toBeCloseTo(-79.9321, 4);
    expect(stop!.dtradd).toEqual([]);
    expect(stop!.dtrrem).toEqual([]);
  });

  // --------------------------------------------------------------------------
  // 4. POSITIVE: GET /transit/bulk — all transit data in a single response
  // --------------------------------------------------------------------------
  test('(+) GET /transit/bulk — complete IBulkTransitData with routes, patterns, and stops', async () => {
    const res = await request('GET', '/transit/bulk');

    expect(res.status).toBe(200);
    const success = res.data as responses.ISuccess;
    expect(success.name).toBe('BulkDataRetrieved');

    const bulk = success.payload as IBulkTransitData;

    // Routes
    expect(bulk.routes.length).toBe(2);
    expect(bulk.routes.map((r) => r.id)).toEqual(
      expect.arrayContaining(['P1', '61C'])
    );

    // Patterns keyed by routeId
    expect(bulk.patterns).toHaveProperty('P1');
    expect(bulk.patterns['P1'].length).toBe(2);
    expect(bulk.patterns['P1'][0]).toHaveProperty('direction');
    expect(bulk.patterns['P1'][0]).toHaveProperty('path');

    // Stops keyed by "routeId:DIRECTION"
    expect(bulk.stops).toHaveProperty('P1:INBOUND');
    expect(bulk.stops['P1:INBOUND'].length).toBe(2);
    expect(bulk.stops).toHaveProperty('P1:OUTBOUND');
    expect(bulk.stops['P1:OUTBOUND'].length).toBe(1);
    expect(bulk.stops['P1:OUTBOUND'][0].stopId).toBe('8192');
  });

  // --------------------------------------------------------------------------
  // 5. POSITIVE: GET /map/config with auth — map configuration defaults
  // --------------------------------------------------------------------------
  test('(+) GET /map/config — authenticated request returns IConfig with CMU campus center', async () => {
    const res = await request('GET', '/config', undefined, memberToken);

    expect(res.status).toBe(200);
    const success = res.data as responses.ISuccess;
    expect(success.name).toBe('ConfigFound');

    const config = success.payload as IConfig;
    expect(config).toHaveProperty('apiKey');
    expect(config.lat).toBeCloseTo(40.4433, 4);
    expect(config.lon).toBeCloseTo(-79.9436, 4);
    expect(config.defaultZoom).toBe(14);
  });

  // --------------------------------------------------------------------------
  // 6. POSITIVE: POST /transit/routes/available with date — filters routes
  // --------------------------------------------------------------------------
  test('(+) POST /transit/routes/available with date — filtered routes for weekday', async () => {
    // Wednesday — only 61C runs every day
    mockGtfs.filterRoutesByDate.mockReturnValue([sampleRoutes[1]]);

    const res = await request('POST', '/transit/routes/available', {
      date: '2026-02-15'
    });

    expect(res.status).toBe(200);
    const success = res.data as responses.ISuccess;
    expect(success.name).toBe('RoutesRetrieved');

    const routes = success.payload as IRoute[];
    expect(routes.length).toBe(1);
    expect(routes[0].id).toBe('61C');
    expect(routes[0].operatingDays).toContain(0); // runs Sundays too
  });

  // --------------------------------------------------------------------------
  // 7. NEGATIVE: POST /transit/routes/available without date — 400
  // --------------------------------------------------------------------------
  test('(-) POST /transit/routes/available without date — 400 MissingParameter', async () => {
    const res = await request('POST', '/transit/routes/available', {});

    expect(res.status).toBe(400);
    const error = res.data as responses.IAppError;
    expect(error.name).toBe('MissingParameter');
    expect(error.message).toContain('date');
  });

  // --------------------------------------------------------------------------
  // 8. NEGATIVE: GET /transit/stops/:routeId without dir — 400
  // --------------------------------------------------------------------------
  test('(-) GET /transit/stops/:routeId without dir param — 400 MissingParameter', async () => {
    const res = await request('GET', '/transit/stops/P1');

    expect(res.status).toBe(400);
    const error = res.data as responses.IAppError;
    expect(error.name).toBe('MissingParameter');
    expect(error.message).toContain('dir');
  });

  // --------------------------------------------------------------------------
  // 9. NEGATIVE: GET /transit/routes/:id for non-existent route — 404
  // --------------------------------------------------------------------------
  test('(-) GET /transit/routes/:id for non-existent route — 404 RouteNotFound', async () => {
    const res = await request('GET', '/transit/routes/NONEXISTENT');

    expect(res.status).toBe(404);
    const error = res.data as responses.IAppError;
    expect(error.name).toBe('RouteNotFound');
    expect(error.message).toContain('NONEXISTENT');
  });

  // --------------------------------------------------------------------------
  // 10. NEGATIVE: GET /map/config without auth token — 401
  // --------------------------------------------------------------------------
  test('(-) GET /map/config without token — 401 MissingToken', async () => {
    const res = await request('GET', '/config');

    expect(res.status).toBe(401);
    const error = res.data as responses.IAppError;
    expect(error.name).toBe('MissingToken');
    expect(error.message).toContain('Token');
  });

  // --------------------------------------------------------------------------
  // 11. NEGATIVE: GET /map/config with invalid token — 401
  // --------------------------------------------------------------------------
  test('(-) GET /map/config with invalid token — 401 InvalidToken', async () => {
    const res = await request(
      'GET',
      '/config',
      undefined,
      'this.is.not.a.valid.jwt'
    );

    expect(res.status).toBe(401);
    const error = res.data as responses.IAppError;
    expect(error.name).toBe('InvalidToken');
  });

  // --------------------------------------------------------------------------
  // 12. POSITIVE: POST /transit/routes/available with date+time — narrows further
  // --------------------------------------------------------------------------
  test('(+) POST /transit/routes/available with date and time — date+time filtered result', async () => {
    mockGtfs.filterRoutesByDateTime.mockReturnValue([sampleRoutes[0]]);

    const res = await request('POST', '/transit/routes/available', {
      date: '2026-03-26',
      time: '08:30'
    });

    expect(res.status).toBe(200);
    const success = res.data as responses.ISuccess;
    expect(success.name).toBe('RoutesRetrieved');

    const routes = success.payload as IRoute[];
    expect(routes.length).toBe(1);
    expect(routes[0].id).toBe('P1');
    expect(routes[0].name).toBe('East Busway All-Stops');

    // confirm the service was called with correct args
    expect(mockGtfs.filterRoutesByDateTime).toHaveBeenCalledWith(
      expect.any(Date),
      '08:30'
    );
  });
});

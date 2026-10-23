/**
 * Automated tests for TUC 1 — Visualize Routes
 * Tests all Transit & Map REST API endpoints per the REST specification
 * and the TUC 1 use case (basic flow, alternative flows, rules).
 *
 * External services (TrueTime API, GTFS feed) are mocked so tests run
 * deterministically without network access.
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
  IRoute,
  IVehicle,
  IStop,
  IPrediction,
  IDetour,
  IPattern
} from '../../../common/transit.interface';
import { IConfig } from '../../../common/map.interface';

// ---------------------------------------------------------------------------
// Mocks — isolate from real PRT TrueTime & GTFS feeds
// ---------------------------------------------------------------------------

// Sample data for mocks
const sampleRoutes: IRoute[] = [
  {
    id: 'P1',
    name: 'East Busway All-Stops',
    system: 'PRT',
    color: '#00518B',
    directions: ['INBOUND', 'OUTBOUND'],
    activeStatus: true,
    operatingDays: [1, 2, 3, 4, 5]
  },
  {
    id: '61C',
    name: 'McKeesport - Homestead',
    system: 'PRT',
    color: '#FF6600',
    directions: ['INBOUND', 'OUTBOUND'],
    activeStatus: true,
    operatingDays: [0, 1, 2, 3, 4, 5, 6]
  }
];

const samplePatterns: IPattern[] = [
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

const sampleStops: IStop[] = [
  {
    stopId: '7079',
    stopName: 'Fifth Ave at Smithfield',
    lat: 40.441,
    lon: -80.002,
    dtradd: [],
    dtrrem: []
  },
  {
    stopId: '8192',
    stopName: 'Forbes Ave at Craig',
    lat: 40.444,
    lon: -79.949,
    dtradd: [],
    dtrrem: []
  }
];

const sampleVehicles: IVehicle[] = [
  {
    vid: '2201',
    lat: 40.441,
    lon: -80.002,
    routeId: 'P1',
    heading: 180,
    source: 'live',
    lastUpdate: '2026-02-13T08:00:00Z',
    isDetoured: false
  }
];

const samplePredictions: IPrediction[] = [
  {
    stopId: '7079',
    routeId: 'P1',
    vid: '2201',
    predictedArrivalTime: Date.now() + 300_000,
    isDelayed: false,
    minutes: 5
  }
];

const sampleDetours: IDetour[] = [
  {
    id: 'DTR_101',
    description:
      'Route P1 diverted due to construction on East Busway at Negley Station.',
    startdt: '2026-02-13T08:00:00Z',
    enddt: '2026-02-15T17:00:00Z'
  }
];

// Mock TransitModel (controller uses this for route/pattern/stop/detour data)
jest.mock('../../../server/models/transit.model', () => ({
  __esModule: true,
  TransitModel: {
    refreshAllCaches: jest.fn().mockResolvedValue(undefined),
    getRoutes: jest.fn(),
    getPatterns: jest.fn(),
    getStops: jest.fn(),
    getDetours: jest.fn(),
    getAllTransitData: jest.fn(),
    colorsAvailable: true
  }
}));

// Mock GTFS service
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

import gtfsService from '../../../server/services/gtfs.service';
import { TransitModel } from '../../../server/models/transit.model';
import vehiclePositionsService from '../../../server/services/vehicle-positions.service';
import tripUpdatesService from '../../../server/services/trip-updates.service';

const mockGtfs = gtfsService as jest.Mocked<typeof gtfsService>;
const mockTransitModel = TransitModel as jest.Mocked<typeof TransitModel>;
const mockVehiclePositions = vehiclePositionsService as jest.Mocked<
  typeof vehiclePositionsService
>;
const mockTripUpdates = tripUpdatesService as jest.Mocked<
  typeof tripUpdatesService
>;

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

const TEST_PORT = 8282;
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
let memberToken: string;

// Test user
const testUser = {
  credentials: { username: 'transituser', password: 'Transit123!' },
  email: 'transituser@cmu.edu',
  agreed: true
};

/**
 * Helper to make HTTP requests
 */
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

/**
 * Helper to register + agree + login a user
 */
async function setupUser(userData: typeof testUser): Promise<string> {
  // Register
  await request('POST', '/auth/users', {
    credentials: userData.credentials,
    email: userData.email,
    agreed: userData.agreed
  });
  // Agree to terms
  await request('PATCH', `/auth/users/${userData.credentials.username}`, {
    password: userData.credentials.password
  });
  // Login and get token
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

  memberToken = await setupUser(testUser);
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

// ============================================================================
// GET /transit/routes — Basic Flow step 4: display all PRT routes
// ============================================================================

describe('GET /transit/routes', () => {
  test('returns all routes (Basic Flow step 4)', async () => {
    mockTransitModel.getRoutes.mockResolvedValue(sampleRoutes);

    const res = await request('GET', '/transit/routes');

    expect(res.status).toBe(200);
    const success = res.data as responses.ISuccess;
    expect(success.name).toBe('RoutesRetrieved');
    const routes = success.payload as IRoute[];
    expect(routes.length).toBe(2);
    expect(routes[0].id).toBe('P1');
    expect(routes[1].id).toBe('61C');
  });

  test('filters by system=PRT (Basic Flow step 4, Rule R2 default)', async () => {
    mockTransitModel.getRoutes.mockResolvedValue(sampleRoutes);

    const res = await request('GET', '/transit/routes?system=PRT');

    expect(res.status).toBe(200);
    const success = res.data as responses.ISuccess;
    const routes = success.payload as IRoute[];
    expect(routes.every((r) => r.system === 'PRT')).toBe(true);
  });

  test('returns empty array when no routes exist', async () => {
    mockTransitModel.getRoutes.mockResolvedValue([]);

    const res = await request('GET', '/transit/routes');

    expect(res.status).toBe(200);
    const success = res.data as responses.ISuccess;
    const routes = success.payload as IRoute[];
    expect(routes).toEqual([]);
  });

  test('returns 500 when TrueTime API fails (A2 upstream error)', async () => {
    const err: responses.IAppError = {
      type: 'ServerError',
      name: 'UpstreamError',
      message: 'TrueTime API request timed out (>5 s)'
    };
    mockTransitModel.getRoutes.mockRejectedValue(err);

    const res = await request('GET', '/transit/routes');

    expect(res.status).toBe(500);
    const error = res.data as responses.IAppError;
    expect(error.name).toBe('UpstreamError');
  });

  test('route objects have required IRoute fields', async () => {
    mockTransitModel.getRoutes.mockResolvedValue(sampleRoutes);

    const res = await request('GET', '/transit/routes');
    const routes = (res.data as responses.ISuccess).payload as IRoute[];
    const route = routes[0];

    expect(route).toHaveProperty('id');
    expect(route).toHaveProperty('name');
    expect(route).toHaveProperty('system');
    expect(route).toHaveProperty('color');
    expect(route).toHaveProperty('directions');
    expect(route).toHaveProperty('activeStatus');
    expect(route).toHaveProperty('operatingDays');
  });
});

// ============================================================================
// POST /transit/routes/available — Basic Flow steps 8-9: Calendar & Clock filter
// ============================================================================

describe('POST /transit/routes/available', () => {
  test('filters routes by date only (Basic Flow step 8)', async () => {
    mockGtfs.filterRoutesByDate.mockReturnValue([sampleRoutes[1]]); // 61C runs every day

    const res = await request('POST', '/transit/routes/available', {
      date: '2026-02-15' // Sunday
    });

    expect(res.status).toBe(200);
    const success = res.data as responses.ISuccess;
    expect(success.name).toBe('RoutesRetrieved');
    const routes = success.payload as IRoute[];
    expect(routes.length).toBe(1);
    expect(routes[0].id).toBe('61C');
  });

  test('filters routes by date and time (Basic Flow step 9)', async () => {
    mockGtfs.filterRoutesByDateTime.mockReturnValue([sampleRoutes[0]]);

    const res = await request('POST', '/transit/routes/available', {
      date: '2026-02-12',
      time: '14:30'
    });

    expect(res.status).toBe(200);
    const success = res.data as responses.ISuccess;
    const routes = success.payload as IRoute[];
    expect(routes.length).toBe(1);
    expect(routes[0].id).toBe('P1');
    expect(mockGtfs.filterRoutesByDateTime).toHaveBeenCalledWith(
      expect.any(Date),
      '14:30'
    );
  });

  test('returns 400 when date is missing', async () => {
    const res = await request('POST', '/transit/routes/available', {});

    expect(res.status).toBe(400);
    const error = res.data as responses.IAppError;
    expect(error.name).toBe('MissingParameter');
  });

  test('returns empty list when no service on selected date/time (A7)', async () => {
    mockGtfs.filterRoutesByDateTime.mockReturnValue([]);

    const res = await request('POST', '/transit/routes/available', {
      date: '2026-12-25',
      time: '03:00'
    });

    expect(res.status).toBe(200);
    const success = res.data as responses.ISuccess;
    const routes = success.payload as IRoute[];
    expect(routes).toEqual([]);
  });

  test('returns 500 when GTFS data not yet loaded', async () => {
    const err: responses.IAppError = {
      type: 'ServerError',
      name: 'GetRequestFailure',
      message: 'GTFS schedule data is not yet loaded'
    };
    mockGtfs.filterRoutesByDate.mockImplementation(() => {
      throw err;
    });

    const res = await request('POST', '/transit/routes/available', {
      date: '2026-02-12'
    });

    expect(res.status).toBe(500);
    const error = res.data as responses.IAppError;
    expect(error.name).toBe('GetRequestFailure');
  });
});

// ============================================================================
// GET /transit/routes/:id — Basic Flow step 7: single route geometry
// ============================================================================

describe('GET /transit/routes/:id', () => {
  test('returns route patterns with INBOUND and OUTBOUND (basic flow)', async () => {
    mockTransitModel.getPatterns.mockResolvedValue(samplePatterns);

    const res = await request('GET', '/transit/routes/P1');

    expect(res.status).toBe(200);
    const success = res.data as responses.ISuccess;
    expect(success.name).toBe('PathGenerated');
    const patterns = success.payload as IPattern[];
    expect(patterns.length).toBe(2);
    expect(patterns.map((p) => p.direction)).toEqual(
      expect.arrayContaining(['INBOUND', 'OUTBOUND'])
    );
  });

  test('pattern path contains lat/lng coordinates', async () => {
    mockTransitModel.getPatterns.mockResolvedValue(samplePatterns);

    const res = await request('GET', '/transit/routes/P1');
    const patterns = (res.data as responses.ISuccess).payload as IPattern[];

    patterns.forEach((p) => {
      expect(p.path.length).toBeGreaterThan(0);
      p.path.forEach((coord) => {
        expect(coord).toHaveProperty('lat');
        expect(coord).toHaveProperty('lng');
        expect(typeof coord.lat).toBe('number');
        expect(typeof coord.lng).toBe('number');
      });
    });
  });

  test('returns 500 when route pattern lookup throws', async () => {
    mockTransitModel.getPatterns.mockRejectedValue(new Error('API down'));

    const res = await request('GET', '/transit/routes/P1');

    expect(res.status).toBe(500);
    expect(mockGtfs.getPatterns).not.toHaveBeenCalled();
  });

  test('returns 404 when route pattern lookup is empty', async () => {
    mockTransitModel.getPatterns.mockResolvedValue([]);

    const res = await request('GET', '/transit/routes/P1');

    expect(res.status).toBe(404);
    expect(mockGtfs.getPatterns).not.toHaveBeenCalled();
  });

  test('returns 404 when route not found in either source', async () => {
    mockTransitModel.getPatterns.mockResolvedValue([]);
    mockGtfs.isLoaded.mockReturnValue(true);
    mockGtfs.getPatterns.mockReturnValue([]);

    const res = await request('GET', '/transit/routes/INVALID');

    expect(res.status).toBe(404);
    const error = res.data as responses.IAppError;
    expect(error.name).toBe('RouteNotFound');
  });

  test('returns 404 when GTFS not loaded and TrueTime returns nothing', async () => {
    mockTransitModel.getPatterns.mockResolvedValue([]);
    mockGtfs.isLoaded.mockReturnValue(false);

    const res = await request('GET', '/transit/routes/NOEXIST');

    expect(res.status).toBe(404);
    const error = res.data as responses.IAppError;
    expect(error.name).toBe('RouteNotFound');
  });
});

// ============================================================================
// GET /transit/vehicles/:routeId — Basic Flow: real-time vehicle positions
// ============================================================================

describe('GET /transit/vehicles/:routeId', () => {
  test('returns live vehicle positions for a route', async () => {
    mockVehiclePositions.getVehicles.mockReturnValue(sampleVehicles);

    const res = await request('GET', '/transit/vehicles/P1');

    expect(res.status).toBe(200);
    const success = res.data as responses.ISuccess;
    expect(success.name).toBe('VehiclesLocated');
    const vehicles = success.payload as IVehicle[];
    expect(vehicles.length).toBe(1);
    expect(vehicles[0].vid).toBe('2201');
    expect(vehicles[0].routeId).toBe('P1');
    expect(vehicles[0].source).toBe('live');
  });

  test('vehicle objects have all IVehicle fields', async () => {
    mockVehiclePositions.getVehicles.mockReturnValue(sampleVehicles);

    const res = await request('GET', '/transit/vehicles/P1');
    const vehicles = (res.data as responses.ISuccess).payload as IVehicle[];
    const v = vehicles[0];

    expect(v).toHaveProperty('vid');
    expect(v).toHaveProperty('lat');
    expect(v).toHaveProperty('lon');
    expect(v).toHaveProperty('routeId');
    expect(v).toHaveProperty('heading');
    expect(v).toHaveProperty('source');
    expect(v).toHaveProperty('lastUpdate');
    expect(v).toHaveProperty('isDetoured');
  });

  test('returns empty array when no vehicles active (A7 no service)', async () => {
    mockVehiclePositions.getVehicles.mockReturnValue([]);

    const res = await request('GET', '/transit/vehicles/P1');

    expect(res.status).toBe(200);
    const success = res.data as responses.ISuccess;
    const vehicles = success.payload as IVehicle[];
    expect(vehicles).toEqual([]);
  });

  test('returns 500 when TrueTime API is unreachable (A2)', async () => {
    const err: responses.IAppError = {
      type: 'ServerError',
      name: 'UpstreamError',
      message: 'TrueTime API request timed out (>5 s)'
    };
    mockVehiclePositions.getVehicles.mockImplementation(() => {
      throw err;
    });

    const res = await request('GET', '/transit/vehicles/P1');

    expect(res.status).toBe(500);
    const error = res.data as responses.IAppError;
    expect(error.name).toBe('UpstreamError');
  });

  test('only returns vehicles for the requested route (Rule R1)', async () => {
    mockVehiclePositions.getVehicles.mockReturnValue(sampleVehicles);

    const res = await request('GET', '/transit/vehicles/P1');
    const vehicles = (res.data as responses.ISuccess).payload as IVehicle[];

    vehicles.forEach((v) => {
      expect(v.routeId).toBe('P1');
    });
  });
});

// ============================================================================
// GET /transit/stops/:routeId — Basic Flow: stops for a route
// ============================================================================

describe('GET /transit/stops/:routeId', () => {
  test('returns stops for a route with direction filter (Basic Flow step 11)', async () => {
    mockTransitModel.getStops.mockResolvedValue(sampleStops);

    const res = await request('GET', '/transit/stops/G2?dir=INBOUND');

    expect(res.status).toBe(200);
    const success = res.data as responses.ISuccess;
    expect(success.name).toBe('StopsRetrieved');
    const stops = success.payload as IStop[];
    expect(stops.length).toBe(2);
    expect(stops[0].stopId).toBe('7079');
  });

  test('returns 400 when dir parameter is missing', async () => {
    const res = await request('GET', '/transit/stops/G2');

    expect(res.status).toBe(400);
    const error = res.data as responses.IAppError;
    expect(error.name).toBe('MissingParameter');
    expect(error.message).toContain('dir');
  });

  test('stop objects have all IStop fields', async () => {
    mockTransitModel.getStops.mockResolvedValue(sampleStops);

    const res = await request('GET', '/transit/stops/P1?dir=OUTBOUND');
    const stops = (res.data as responses.ISuccess).payload as IStop[];
    const stop = stops[0];

    expect(stop).toHaveProperty('stopId');
    expect(stop).toHaveProperty('stopName');
    expect(stop).toHaveProperty('lat');
    expect(stop).toHaveProperty('lon');
    expect(typeof stop.lat).toBe('number');
    expect(typeof stop.lon).toBe('number');
  });

  test('returns 404 when route has no stops in cache', async () => {
    mockTransitModel.getStops.mockResolvedValue([]);

    const res = await request('GET', '/transit/stops/P1?dir=INBOUND');

    expect(res.status).toBe(404);
  });

  test('returns 404 when route has no stops in either source', async () => {
    mockTransitModel.getStops.mockResolvedValue([]);
    mockGtfs.isLoaded.mockReturnValue(true);
    mockGtfs.getStopsByDirection.mockReturnValue([]);

    const res = await request('GET', '/transit/stops/INVALID?dir=INBOUND');

    expect(res.status).toBe(404);
    const error = res.data as responses.IAppError;
    expect(error.name).toBe('StopNotFound');
  });
});

// ============================================================================
// GET /transit/stops/:stopId/predictions — arrival predictions for a stop
// ============================================================================

describe('GET /transit/stops/:stopId/predictions', () => {
  test('returns predictions for a valid stop', async () => {
    mockTripUpdates.getPredictions.mockReturnValue(samplePredictions);

    const res = await request('GET', '/transit/stops/7079/predictions');

    expect(res.status).toBe(200);
    const success = res.data as responses.ISuccess;
    expect(success.name).toBe('PredictionsRetrieved');
    const predictions = success.payload as IPrediction[];
    expect(predictions.length).toBe(1);
    expect(predictions[0].stopId).toBe('7079');
    expect(predictions[0].routeId).toBe('P1');
  });

  test('prediction objects have all IPrediction fields', async () => {
    mockTripUpdates.getPredictions.mockReturnValue(samplePredictions);

    const res = await request('GET', '/transit/stops/7079/predictions');
    const predictions = (res.data as responses.ISuccess)
      .payload as IPrediction[];
    const pred = predictions[0];

    expect(pred).toHaveProperty('stopId');
    expect(pred).toHaveProperty('routeId');
    expect(pred).toHaveProperty('predictedArrivalTime');
    expect(pred).toHaveProperty('isDelayed');
    expect(pred).toHaveProperty('minutes');
    expect(typeof pred.minutes).toBe('number');
  });

  test('returns empty array when no predictions available', async () => {
    mockTripUpdates.getPredictions.mockReturnValue([]);

    const res = await request('GET', '/transit/stops/7079/predictions');

    expect(res.status).toBe(200);
    const success = res.data as responses.ISuccess;
    const predictions = success.payload as IPrediction[];
    expect(predictions).toEqual([]);
  });

  test('returns error when stop not found', async () => {
    const err: responses.IAppError = {
      type: 'ClientError',
      name: 'StopNotFound',
      message: 'Stop 99999 not found'
    };
    mockTripUpdates.getPredictions.mockImplementation(() => {
      throw err;
    });

    const res = await request('GET', '/transit/stops/99999/predictions');

    expect(res.status).toBe(404);
    const error = res.data as responses.IAppError;
    expect(error.name).toBe('StopNotFound');
  });

  test('returns 500 when TrueTime API fails', async () => {
    const err: responses.IAppError = {
      type: 'ServerError',
      name: 'UpstreamError',
      message: 'TrueTime API returned HTTP 503'
    };
    mockTripUpdates.getPredictions.mockImplementation(() => {
      throw err;
    });

    const res = await request('GET', '/transit/stops/7079/predictions');

    expect(res.status).toBe(500);
    const error = res.data as responses.IAppError;
    expect(error.name).toBe('UpstreamError');
  });
});

// ============================================================================
// GET /transit/detours/:routeId — active detours for a route
// ============================================================================

describe('GET /transit/detours/:routeId', () => {
  test('returns detours for a route', async () => {
    mockTransitModel.getDetours.mockResolvedValue(sampleDetours);

    const res = await request('GET', '/transit/detours/P1');

    expect(res.status).toBe(200);
    const success = res.data as responses.ISuccess;
    expect(success.name).toBe('DetoursRetrieved');
    const detours = success.payload as IDetour[];
    expect(detours.length).toBe(1);
    expect(detours[0].id).toBe('DTR_101');
  });

  test('detour objects have all IDetour fields', async () => {
    mockTransitModel.getDetours.mockResolvedValue(sampleDetours);

    const res = await request('GET', '/transit/detours/P1');
    const detours = (res.data as responses.ISuccess).payload as IDetour[];
    const detour = detours[0];

    expect(detour).toHaveProperty('id');
    expect(detour).toHaveProperty('description');
    expect(detour).toHaveProperty('startdt');
    expect(detour).toHaveProperty('enddt');
  });

  test('returns empty array when no active detours', async () => {
    mockTransitModel.getDetours.mockResolvedValue([]);

    const res = await request('GET', '/transit/detours/P1');

    expect(res.status).toBe(200);
    const success = res.data as responses.ISuccess;
    const detours = success.payload as IDetour[];
    expect(detours).toEqual([]);
  });

  test('returns 500 when TrueTime API fails', async () => {
    const err: responses.IAppError = {
      type: 'ServerError',
      name: 'UpstreamError',
      message: 'TrueTime API returned HTTP 500'
    };
    mockTransitModel.getDetours.mockRejectedValue(err);

    const res = await request('GET', '/transit/detours/P1');

    expect(res.status).toBe(500);
    const error = res.data as responses.IAppError;
    expect(error.name).toBe('UpstreamError');
  });
});

// ============================================================================
// GET /map/config — map configuration endpoint (requires auth)
// ============================================================================

describe('GET /map/config', () => {
  test('returns map configuration with valid token', async () => {
    const res = await request('GET', '/config', undefined, memberToken);

    expect(res.status).toBe(200);
    const success = res.data as responses.ISuccess;
    expect(success.name).toBe('ConfigFound');
    const config = success.payload as IConfig;
    expect(config).toHaveProperty('apiKey');
    expect(config).toHaveProperty('lat');
    expect(config).toHaveProperty('lon');
    expect(config).toHaveProperty('defaultZoom');
  });

  test('default center is CMU campus coordinates', async () => {
    const res = await request('GET', '/config', undefined, memberToken);

    const config = (res.data as responses.ISuccess).payload as IConfig;
    expect(config.lat).toBeCloseTo(40.4433, 2);
    expect(config.lon).toBeCloseTo(-79.9436, 2);
  });

  test('returns 401 without token (MissingToken)', async () => {
    const res = await request('GET', '/config');

    expect(res.status).toBe(401);
    const error = res.data as responses.IAppError;
    expect(error.name).toBe('MissingToken');
  });

  test('returns 401 with invalid token (InvalidToken)', async () => {
    const res = await request('GET', '/config', undefined, 'bad_token');

    expect(res.status).toBe(401);
    const error = res.data as responses.IAppError;
    expect(error.name).toBe('InvalidToken');
  });
});

// ============================================================================
// Response format consistency tests
// ============================================================================

describe('Response format consistency', () => {
  test('success responses have name & payload fields', async () => {
    mockTransitModel.getRoutes.mockResolvedValue(sampleRoutes);
    const res = await request('GET', '/transit/routes');

    expect(res.status).toBe(200);
    const success = res.data as responses.ISuccess;
    expect(success).toHaveProperty('name');
    expect(success).toHaveProperty('payload');
    expect(typeof success.name).toBe('string');
  });

  test('error responses have type, name & message fields', async () => {
    const err: responses.IAppError = {
      type: 'ServerError',
      name: 'UpstreamError',
      message: 'TrueTime API request timed out'
    };
    mockTransitModel.getRoutes.mockRejectedValue(err);

    const res = await request('GET', '/transit/routes');
    const error = res.data as responses.IAppError;

    expect(error).toHaveProperty('type');
    expect(error).toHaveProperty('name');
    expect(error).toHaveProperty('message');
  });
});

// ============================================================================
// A2 Fallback — comprehensive TrueTime-to-GTFS fallback tests
// ============================================================================

describe('A2 Fallback: TrueTime down → GTFS static data', () => {
  test('routes/:id returns 500 when cache fetch throws timeout', async () => {
    mockTransitModel.getPatterns.mockRejectedValue(
      Object.assign(new Error('timeout'), { name: 'AbortError' })
    );

    const res = await request('GET', '/transit/routes/P1');

    expect(res.status).toBe(500);
    expect(mockGtfs.getPatterns).not.toHaveBeenCalled();
  });

  test('stops/:routeId returns 500 when cache fetch throws timeout', async () => {
    mockTransitModel.getStops.mockRejectedValue(
      Object.assign(new Error('timeout'), { name: 'AbortError' })
    );

    const res = await request('GET', '/transit/stops/P1?dir=INBOUND');

    expect(res.status).toBe(500);
    expect(mockGtfs.getStopsByDirection).not.toHaveBeenCalled();
  });

  test('GTFS fallback not used when GTFS is not loaded', async () => {
    mockTransitModel.getPatterns.mockResolvedValue([]);
    mockGtfs.isLoaded.mockReturnValue(false);

    const res = await request('GET', '/transit/routes/P1');

    expect(res.status).toBe(404);
    expect(mockGtfs.getPatterns).not.toHaveBeenCalled();
  });
});

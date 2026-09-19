/** @jest-environment jsdom */

import { FilterController } from '../../client/scripts/controllers/filter-controller';
import {
  transitApiService,
  type IServiceHealth
} from '../../client/scripts/services/transit-api.service';
import type { IMapState } from '../../client/scripts/state/map-state';
import type {
  IBulkTransitData,
  IRoute,
  IStop,
  INearbyStopsPayload
} from '../../common/transit.interface';
import { registerActivePopup } from '../../client/scripts/utils/map-popup';

let mockState: IMapState;
const mockRenderer = {
  clearAllRoutes: jest.fn(),
  clearRoutePolylines: jest.fn(),
  clearStopMarkers: jest.fn(),
  showRoute: jest.fn(),
  hideRoute: jest.fn(),
  renderRouteGeometry: jest.fn(),
  fitToRouteData: jest.fn(),
  showDirectionPolylines: jest.fn(),
  hideDirectionPolylines: jest.fn(),
  renderStopMarkers: jest.fn(),
  clearDetourPolylines: jest.fn(),
  renderDetourGeometry: jest.fn(),
  hasRouteGeometry: jest.fn(() => false)
};
const mockTracker = {
  stopPolling: jest.fn(),
  startPolling: jest.fn(),
  refreshDirectionVisibility: jest.fn()
};
const mockDirections = { isActive: false, sessionVersion: 0 };
const mockPredictions = {
  hasActiveSelection: false,
  sessionVersion: 0,
  setRouteColorProvider: jest.fn(),
  setWalkTimeProvider: jest.fn(),
  stopPolling: jest.fn(() => {
    mockPredictions.sessionVersion++;
  })
};
const mockPublishRoutes = jest.fn((routes: IRoute[]) => {
  mockState.availableRoutes = routes;
  mockState.filteredRoutes = routes.filter(
    (route) =>
      (route.system === 'PRT'
        ? mockState.selectedSystems.prt
        : mockState.selectedSystems.cmu) &&
      (!mockState.selectedRouteId || mockState.selectedRouteId === route.id)
  );
});
jest.mock('../../client/scripts/state/map-state', () => ({
  MapStateManager: {
    getInstance: () => ({
      getState: () => ({ ...mockState }),
      setAvailableRoutes: mockPublishRoutes,
      reapplyFilters: jest.fn()
    })
  }
}));
jest.mock('../../client/scripts/renderers/route-renderer', () => ({
  RouteRenderer: { getInstance: () => mockRenderer }
}));
jest.mock('../../client/scripts/trackers/vehicle-tracker', () => ({
  VehicleTracker: { getInstance: () => mockTracker }
}));
jest.mock('../../client/scripts/state/url-sync', () => ({
  URLSyncManager: { getInstance: () => ({ updateURL: jest.fn() }) }
}));
jest.mock('../../client/scripts/controllers/directions-controller', () => ({
  DirectionsController: { getInstance: () => mockDirections }
}));
jest.mock('../../client/scripts/controllers/prediction-controller', () => ({
  PredictionController: { getInstance: () => mockPredictions }
}));
jest.mock('../../client/scripts/utils/map-popup', () => ({
  MAP_POPUP_ID: 'map-popup',
  dismissPopup: jest.fn(),
  prepareForNewPopup: jest.fn(),
  registerActivePopup: jest.fn()
}));
jest.mock('../../client/scripts/services/auth.service', () => ({
  AuthService: { getInstance: () => ({ isRouteSubscribed: () => false }) }
}));
jest.mock('../../client/scripts/services/transit-api.service', () => ({
  transitApiService: {
    getRoutes: jest.fn(),
    getBulkData: jest.fn(),
    getHealth: jest.fn(),
    getPatterns: jest.fn(),
    getStops: jest.fn(),
    getDetourGeometry: jest.fn(),
    getNearbyStops: jest.fn(),
    filterRoutesByDateTime: jest.fn(),
    getRouteSchedule: jest.fn()
  }
}));

const api = jest.mocked(transitApiService);
const route: IRoute = {
  id: '61A',
  name: 'Route 61A',
  system: 'PRT',
  color: '#4285F4',
  directions: ['INBOUND', 'OUTBOUND'],
  activeStatus: true,
  operatingDays: [1]
};
const position = { lat: 40.44, lng: -79.94 };
const stop: IStop = {
  stopId: 'test',
  stopName: 'Test',
  lat: position.lat,
  lon: position.lng,
  dtradd: [],
  dtrrem: []
};
const geometry = [{ direction: 'OUTBOUND', path: [position] }];
const coldBulk: IBulkTransitData = { routes: [], patterns: {}, stops: {} };
const warmBulk: IBulkTransitData = {
  routes: [route],
  patterns: { [route.id]: geometry },
  stops: { [`${route.id}:INBOUND`]: [stop], [`${route.id}:OUTBOUND`]: [stop] }
};
const healthyFeed = { healthy: true, consecutiveFailures: 0, error: null };
const health = (ready: boolean): IServiceHealth => ({
  gtfs: { ready },
  memory: {},
  vehiclePositions: healthyFeed,
  tripUpdates: healthyFeed,
  tripshotLiveStatus: healthyFeed,
  trueTimeColors: { available: true },
  overall: ready
});
const nearby: INearbyStopsPayload = {
  center: { lat: position.lat, lon: position.lng },
  radiusMeters: 1000,
  expandedRadiusApplied: false,
  stops: [
    {
      stop,
      distanceMeters: 0,
      walkMinutesEstimate: 0,
      routesServingStop: [route.id]
    }
  ]
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((reply) => {
    resolve = reply;
  });
  return { promise, resolve };
}

describe('Transit readiness recovery', () => {
  let controller: FilterController;
  const banner = () => document.getElementById('service-status-banner')!;
  const tick = (milliseconds = 0) =>
    jest.advanceTimersByTimeAsync(milliseconds);

  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    document.body.innerHTML = '<div id="service-status-banner" hidden></div>';
    localStorage.setItem('token', 'test-session');
    Object.assign(mockDirections, { isActive: false, sessionVersion: 0 });
    Object.assign(mockPredictions, {
      hasActiveSelection: false,
      sessionVersion: 0
    });
    mockState = {
      selectedRouteId: null,
      selectedDate: null,
      selectedTime: null,
      selectedSystems: { prt: true, cmu: false },
      selectedDirections: { inbound: true, outbound: true },
      availableRoutes: [],
      filteredRoutes: [],
      activeVehicles: [],
      plannedLocation: position,
      plannedLocationLabel: 'CMU Campus',
      currentLocation: null,
      gpsPermissionGranted: false
    };
    api.getBulkData
      .mockReset()
      .mockResolvedValue(warmBulk)
      .mockResolvedValueOnce(coldBulk);
    api.getRoutes.mockReset().mockResolvedValue([route]);
    api.getHealth
      .mockReset()
      .mockResolvedValue(health(true))
      .mockResolvedValueOnce(health(false));
    api.getNearbyStops.mockReset().mockResolvedValue(nearby);
    api.getPatterns.mockReset().mockResolvedValue(geometry);
    api.getStops.mockReset().mockResolvedValue([stop]);
    api.getDetourGeometry.mockReset().mockResolvedValue([]);
    api.filterRoutesByDateTime.mockReset().mockResolvedValue([route]);
    controller = FilterController.getInstance();
  });

  afterEach(() => {
    controller.stopHealthPolling();
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  async function coldStart() {
    await controller.initialize();
    await tick();
    expect(mockState.availableRoutes).toEqual([]);
    expect(mockRenderer.renderRouteGeometry).not.toHaveBeenCalled();
    expect(banner().hidden).toBe(false);
    expect(banner().textContent).toContain('Loading transit data');
  }

  test('repopulates empty startup metadata, geometries, and nearby stops when GTFS becomes ready', async () => {
    await coldStart();
    await tick(5000);
    expect(api.getBulkData).toHaveBeenCalledTimes(2);
    expect(mockState.availableRoutes).toEqual([route]);
    expect(mockRenderer.renderRouteGeometry).toHaveBeenCalledWith(
      route.id,
      geometry,
      route.color
    );
    expect(mockRenderer.renderStopMarkers).toHaveBeenCalledWith(
      route.id,
      [stop],
      'NEARBY',
      expect.any(Function)
    );
    expect(api.getNearbyStops).toHaveBeenCalledWith(
      position.lat,
      position.lng,
      'PRT'
    );
    expect(banner().hidden).toBe(true);
    await tick(5000);
    expect(api.getBulkData).toHaveBeenCalledTimes(2);
  });

  test('keeps the warming banner through unsuccessful bulk retries', async () => {
    api.getBulkData.mockResolvedValue(coldBulk);
    await coldStart();
    await tick(5000);
    expect(api.getBulkData).toHaveBeenCalledTimes(2);
    expect(banner().hidden).toBe(false);
    expect(banner().textContent).toContain('Loading transit data');
    api.getBulkData.mockResolvedValue(warmBulk);
    await tick(5000);
    expect(banner().hidden).toBe(true);
  });

  test('retries a failed nearby request but accepts a successful empty result', async () => {
    await coldStart();
    api.getNearbyStops.mockResolvedValueOnce(null);
    await tick(5000);
    expect(banner().hidden).toBe(false);
    expect(mockRenderer.renderStopMarkers).not.toHaveBeenCalled();
    api.getNearbyStops.mockResolvedValueOnce({ ...nearby, stops: [] });
    await tick(5000);
    expect(api.getNearbyStops).toHaveBeenCalledTimes(2);
    expect(banner().hidden).toBe(true);
    expect(mockRenderer.renderRouteGeometry).toHaveBeenCalled();
  });

  test('retries selected route recovery when a stop request fails', async () => {
    await coldStart();
    mockState.selectedRouteId = route.id;
    api.getBulkData.mockResolvedValue({ ...warmBulk, stops: {} });
    api.getStops.mockResolvedValueOnce(null);
    await tick(5000);
    expect(banner().hidden).toBe(false);
    expect(mockTracker.startPolling).not.toHaveBeenCalled();
    await tick(5000);
    expect(banner().hidden).toBe(true);
    expect(mockTracker.startPolling).toHaveBeenCalledWith(
      route.id,
      route.color
    );
  });

  test('reapplies the current date/time and keeps retrying transport failures', async () => {
    await coldStart();
    mockState.selectedDate = new Date('2026-09-21T12:00:00Z');
    mockState.selectedTime = { hour: 8, minute: 30, period: 'AM' };
    api.filterRoutesByDateTime.mockResolvedValueOnce(null);
    await tick(5000);
    expect(banner().hidden).toBe(false);
    await tick(5000);
    expect(api.filterRoutesByDateTime).toHaveBeenLastCalledWith(
      '2026-09-21',
      '08:30'
    );
    expect(api.getNearbyStops).not.toHaveBeenCalled();
    expect(banner().hidden).toBe(true);
    expect(mockState.selectedTime).toEqual({
      hour: 8,
      minute: 30,
      period: 'AM'
    });
  });

  test.each(['directions', 'stop', 'popup'] as const)(
    'defers recovery while %s is active, then restores after it closes',
    async (active) => {
      await coldStart();
      if (active === 'directions') mockDirections.isActive = true;
      if (active === 'stop') mockPredictions.hasActiveSelection = true;
      if (active === 'popup')
        document.body.insertAdjacentHTML(
          'beforeend',
          '<div id="map-popup"></div>'
        );
      await tick(5000);
      expect(api.getBulkData).toHaveBeenCalledTimes(1);
      expect(mockRenderer.renderRouteGeometry).not.toHaveBeenCalled();
      expect(mockRenderer.clearAllRoutes).not.toHaveBeenCalled();
      expect(banner().hidden).toBe(false);
      mockDirections.isActive = false;
      mockPredictions.hasActiveSelection = false;
      document.getElementById('map-popup')?.remove();
      await tick(5000);
      expect(api.getBulkData).toHaveBeenCalledTimes(2);
      expect(mockRenderer.renderStopMarkers).toHaveBeenCalled();
    }
  );

  test('reapplies the current selected route and direction rather than the startup view', async () => {
    await coldStart();
    mockState.selectedRouteId = route.id;
    mockState.selectedDirections.inbound = false;
    await tick(5000);
    expect(api.getNearbyStops).not.toHaveBeenCalled();
    expect(mockRenderer.renderStopMarkers).toHaveBeenCalledTimes(1);
    expect(mockRenderer.renderStopMarkers).toHaveBeenCalledWith(
      route.id,
      [stop],
      'OUTBOUND',
      expect.any(Function)
    );
    expect(mockTracker.startPolling).toHaveBeenCalledWith(
      route.id,
      route.color
    );
    expect(mockState.selectedRouteId).toBe(route.id);
  });

  test('keeps retrying until enabled CMU route metadata is available', async () => {
    await coldStart();
    mockState.selectedSystems.cmu = true;
    api.getRoutes.mockResolvedValueOnce([]);
    await tick(5000);
    expect(banner().hidden).toBe(false);
    expect(mockState.availableRoutes).toEqual([]);
    await tick(5000);
    expect(banner().hidden).toBe(false); // PRT-only metadata is also incomplete.
    const cmuRoute: IRoute = { ...route, id: 'CMU-test', system: 'CMU' };
    api.getRoutes.mockResolvedValue([route, cmuRoute]);
    await tick(5000);
    expect(mockState.availableRoutes).toEqual([route, cmuRoute]);
    expect(api.getNearbyStops).toHaveBeenLastCalledWith(
      position.lat,
      position.lng,
      undefined
    );
    expect(banner().hidden).toBe(true);
  });

  test('respects both transit systems being switched off during startup', async () => {
    await coldStart();
    mockState.selectedSystems = { prt: false, cmu: false };
    await tick(5000);
    expect(mockState.availableRoutes).toEqual([route]);
    expect(mockRenderer.renderRouteGeometry).not.toHaveBeenCalled();
    expect(mockRenderer.renderStopMarkers).not.toHaveBeenCalled();
    expect(api.getNearbyStops).not.toHaveBeenCalled();
    expect(banner().hidden).toBe(true);
  });

  test.each(['directions', 'stop', 'filters', 'account'] as const)(
    'revokes an in-flight recovery after a newer %s session',
    async (change) => {
      await coldStart();
      const pending = deferred<IBulkTransitData>();
      api.getBulkData.mockImplementationOnce(() => pending.promise);
      await tick(5000);
      mockPublishRoutes.mockClear();
      if (change === 'directions') mockDirections.sessionVersion += 2;
      if (change === 'stop') mockPredictions.sessionVersion += 2;
      if (change === 'filters') mockState.selectedDirections.inbound = false;
      if (change === 'account')
        localStorage.setItem('token', 'different-session');
      pending.resolve(warmBulk);
      await tick();
      expect(mockPublishRoutes).not.toHaveBeenCalled();
      expect(mockRenderer.renderRouteGeometry).not.toHaveBeenCalled();
      expect(mockRenderer.renderStopMarkers).not.toHaveBeenCalled();
    }
  );

  test('page exit aborts the request, clears scheduled work, and rejects late results', async () => {
    await coldStart();
    const pending = deferred<IBulkTransitData>();
    api.getBulkData.mockImplementationOnce(() => pending.promise);
    await tick(5000);
    const signal = api.getBulkData.mock.calls[1][0]!;
    mockPublishRoutes.mockClear();
    window.dispatchEvent(new Event('pagehide'));
    expect(signal.aborted).toBe(true);
    pending.resolve(warmBulk);
    await tick(120000);
    expect(api.getHealth).toHaveBeenCalledTimes(2);
    expect(mockPublishRoutes).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
  });

  test('a stalled nested nearby request times out without stopping future health checks', async () => {
    await coldStart();
    const pending = deferred<INearbyStopsPayload>();
    api.getNearbyStops.mockImplementationOnce(() => pending.promise);
    await tick(5000);
    await tick(30000);
    expect(api.getHealth).toHaveBeenCalledTimes(2);
    mockRenderer.renderStopMarkers.mockClear();
    pending.resolve(nearby);
    await tick();
    expect(mockRenderer.renderStopMarkers).not.toHaveBeenCalled();
    await tick(5000);
    expect(api.getHealth).toHaveBeenCalledTimes(3);
    expect(mockRenderer.renderStopMarkers).toHaveBeenCalled();
    expect(banner().hidden).toBe(true);
  });

  test('backs startup polling off after 24 short retries', async () => {
    api.getHealth.mockReset().mockResolvedValue(health(false));
    await coldStart();
    await tick(120000);
    expect(api.getHealth).toHaveBeenCalledTimes(25);
    await tick(59000);
    expect(api.getHealth).toHaveBeenCalledTimes(25);
    await tick(1000);
    expect(api.getHealth).toHaveBeenCalledTimes(26);
  });

  test.each(['popup', 'network'] as const)(
    'retries route colors when a prior color recovery was blocked by %s',
    async (blockedBy) => {
      api.getBulkData.mockReset().mockResolvedValue(warmBulk);
      api.getHealth
        .mockReset()
        .mockResolvedValue(health(true))
        .mockResolvedValueOnce({
          ...health(true),
          trueTimeColors: { available: false }
        });
      await controller.initialize();
      await tick();
      const pending = deferred<IRoute[]>();
      api.getRoutes.mockImplementationOnce(() => pending.promise);
      await tick(60000);
      if (blockedBy === 'popup')
        document.body.insertAdjacentHTML(
          'beforeend',
          '<div id="map-popup"></div>'
        );
      pending.resolve(blockedBy === 'network' ? [] : [route]);
      await tick();
      expect(api.getRoutes).toHaveBeenCalledTimes(1);
      document.getElementById('map-popup')?.remove();
      await tick(60000);
      expect(api.getRoutes).toHaveBeenCalledTimes(2);
    }
  );

  test('full view restoration keeps recovered route colors and CMU metadata', async () => {
    api.getBulkData.mockReset().mockResolvedValue(warmBulk);
    api.getHealth
      .mockReset()
      .mockResolvedValue(health(true))
      .mockResolvedValueOnce({
        ...health(true),
        trueTimeColors: { available: false }
      });
    await controller.initialize();
    await tick();
    const colored = { ...route, color: '#112233' };
    const shuttle = {
      ...route,
      id: 'CMU-test',
      system: 'CMU' as const,
      color: '#C41230'
    };
    api.getRoutes.mockResolvedValue([colored, shuttle]);
    await tick(60000);
    mockState.selectedRouteId = route.id;
    await controller.restoreView(position, () => true);
    expect(mockState.availableRoutes).toEqual(
      expect.arrayContaining([colored, shuttle])
    );
    expect(mockTracker.startPolling).toHaveBeenLastCalledWith(
      route.id,
      '#112233'
    );
  });

  test.each(['stop', 'popup', 'directions'] as const)(
    'passive GPS restoration is deferred while a %s selection is active',
    (kind) => {
      if (kind === 'stop') mockPredictions.hasActiveSelection = true;
      if (kind === 'directions') mockDirections.isActive = true;
      if (kind === 'popup')
        document.body.insertAdjacentHTML(
          'beforeend',
          '<div id="map-popup"></div>'
        );
      expect(controller.canRefreshLocation()).toBe(false);
    }
  );

  test('canceled route schedule loading becomes retryable and cannot rebind an obsolete popup', async () => {
    document.body.insertAdjacentHTML(
      'beforeend',
      '<div class="map-container"></div>'
    );
    const pending = deferred<null>();
    api.getRouteSchedule.mockReturnValueOnce(pending.promise);
    let current = true;
    const request = controller.showRouteInfoPopup(route.id, () => current);
    expect(document.querySelector('.map-popup__body')!.textContent).toContain(
      'Loading schedule'
    );
    current = false;
    controller.invalidateView();
    jest.mocked(registerActivePopup).mockClear();
    expect(document.querySelector('.map-popup__body')!.textContent).toContain(
      'Select the route again to retry'
    );
    pending.resolve(null);
    await request;
    expect(document.querySelector('.map-popup__body')!.textContent).toContain(
      'Select the route again to retry'
    );
    expect(registerActivePopup).not.toHaveBeenCalled();
  });
});

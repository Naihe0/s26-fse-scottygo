/** @jest-environment jsdom */

import { FilterController } from '../../client/scripts/controllers/filter-controller';
import { transitApiService } from '../../client/scripts/services/transit-api.service';
import type { IMapState } from '../../client/scripts/state/map-state';
import type {
  IRoute,
  IStop,
  INearbyStopsPayload
} from '../../common/transit.interface';

let mockState: IMapState;
const mockRenderer = {
  clearAllRoutes: jest.fn(),
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
  setRouteGeometry: jest.fn(),
  stopPolling: jest.fn(),
  startPolling: jest.fn(),
  refreshDirectionVisibility: jest.fn()
};
const mockPublishRoutes = jest.fn((routes: IRoute[]) => {
  mockState.availableRoutes = routes;
  mockState.filteredRoutes = routes.filter(
    (route) =>
      !mockState.selectedRouteId || route.id === mockState.selectedRouteId
  );
});
const mockSyncURL = jest.fn();
jest.mock('../../client/scripts/state/map-state', () => ({
  MapStateManager: {
    getInstance: () => ({
      getState: () => mockState,
      updateFilter: (key: string, value: unknown) => {
        (mockState as unknown as Record<string, unknown>)[key] = value;
      },
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
  URLSyncManager: { getInstance: () => ({ updateURL: mockSyncURL }) }
}));
jest.mock('../../client/scripts/controllers/directions-controller', () => ({
  DirectionsController: { getInstance: () => ({ isActive: false }) }
}));
jest.mock('../../client/scripts/controllers/prediction-controller', () => ({
  PredictionController: {
    getInstance: () => ({
      setRouteColorProvider: jest.fn(),
      setWalkTimeProvider: jest.fn(),
      stopPolling: jest.fn()
    })
  }
}));
jest.mock('../../client/scripts/utils/map-popup', () => ({
  dismissPopup: jest.fn()
}));
jest.mock('../../client/scripts/services/auth.service', () => ({
  AuthService: {}
}));
jest.mock('../../client/scripts/services/transit-api.service', () => ({
  transitApiService: {
    getRoutes: jest.fn(),
    getPatterns: jest.fn(),
    getStops: jest.fn(),
    getDetourGeometry: jest.fn(),
    getNearbyStops: jest.fn()
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

function pauseRequest<T>() {
  let reply!: (value: T) => void;
  let fail!: (reason: Error) => void;
  let entered!: () => void;
  const reached = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const response = new Promise<T>((resolve, reject) => {
    reply = resolve;
    fail = reject;
  });
  return {
    reached,
    reply,
    fail,
    run: () => {
      entered();
      return response;
    }
  };
}

describe('Map restoration after exiting directions', () => {
  let controller: FilterController;
  let session: number;
  const isCurrent = () => session === 1;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    session = 1;
    mockState = {
      selectedRouteId: route.id,
      availableRoutes: [route],
      filteredRoutes: [route],
      selectedDirections: { inbound: true, outbound: true },
      selectedSystems: { prt: true, cmu: true }
    } as IMapState;
    api.getRoutes.mockReset().mockResolvedValue([route]);
    api.getPatterns.mockReset().mockResolvedValue(geometry);
    api.getStops.mockReset().mockResolvedValue([stop]);
    api.getDetourGeometry.mockReset().mockResolvedValue([]);
    api.getNearbyStops.mockReset().mockResolvedValue(nearby);
    controller = FilterController.getInstance();
  });

  afterEach(() => jest.restoreAllMocks());

  test('ignores stale metadata before it can clear a newer directions map', async () => {
    mockState.availableRoutes = [];
    const pending = pauseRequest<IRoute[]>();
    api.getRoutes.mockImplementationOnce(pending.run);
    const restore = controller.applyRouteFilter(route.id, isCurrent);
    await pending.reached;
    session = 3; // A new directions session started and exited again.
    pending.reply([route]);
    await restore;
    expect(mockPublishRoutes).not.toHaveBeenCalled();
    expect(mockRenderer.clearAllRoutes).not.toHaveBeenCalled();
    expect(mockTracker.startPolling).not.toHaveBeenCalled();
  });

  test.each(['geometry', 'stops', 'detours'] as const)(
    'does not render or restart polling after stale %s completes',
    async (phase) => {
      const pending = pauseRequest<unknown>();
      const target = {
        geometry: api.getPatterns,
        stops: api.getStops,
        detours: api.getDetourGeometry
      }[phase];
      (target as jest.Mock).mockImplementationOnce(pending.run);
      const restore = controller.applyRouteFilter(route.id, isCurrent);
      await pending.reached;
      session = 3;
      jest.clearAllMocks();
      pending.reply(
        phase === 'geometry' ? geometry : phase === 'stops' ? [stop] : []
      );
      await restore;
      expect(mockRenderer.renderRouteGeometry).not.toHaveBeenCalled();
      expect(mockRenderer.renderStopMarkers).not.toHaveBeenCalled();
      expect(mockRenderer.clearDetourPolylines).not.toHaveBeenCalled();
      expect(mockTracker.startPolling).not.toHaveBeenCalled();
      expect(mockTracker.refreshDirectionVisibility).not.toHaveBeenCalled();
      expect(mockSyncURL).not.toHaveBeenCalled();
    }
  );

  test('does not clear newer detours when an old request rejects', async () => {
    const pending = pauseRequest<never>();
    api.getDetourGeometry.mockImplementationOnce(pending.run);
    const restore = controller.applyRouteFilter(route.id, isCurrent);
    await pending.reached;
    session = 3;
    jest.clearAllMocks();
    pending.fail(new Error('Network failure'));
    await restore;
    expect(mockRenderer.clearDetourPolylines).not.toHaveBeenCalled();
    expect(mockTracker.startPolling).not.toHaveBeenCalled();
  });

  test.each(['nearby stops', 'nearby geometry'] as const)(
    'does not replace a newer map when stale %s returns',
    async (phase) => {
      const pending = pauseRequest<unknown>();
      const target =
        phase === 'nearby stops' ? api.getNearbyStops : api.getPatterns;
      (target as jest.Mock).mockImplementationOnce(pending.run);
      const restore = controller.restoreDefaultState(position, isCurrent);
      await pending.reached;
      session = 3;
      jest.clearAllMocks();
      pending.reply(phase === 'nearby stops' ? nearby : geometry);
      await restore;
      expect(mockRenderer.hideRoute).not.toHaveBeenCalled();
      expect(mockRenderer.renderRouteGeometry).not.toHaveBeenCalled();
      expect(mockRenderer.renderStopMarkers).not.toHaveBeenCalled();
      expect(mockTracker.startPolling).not.toHaveBeenCalled();
    }
  );

  test('still restores a selected route and polling when its session remains current', async () => {
    await controller.applyRouteFilter(route.id, isCurrent);
    expect(mockRenderer.renderRouteGeometry).toHaveBeenCalledTimes(1);
    expect(mockRenderer.renderStopMarkers).toHaveBeenCalledTimes(2);
    expect(mockTracker.startPolling).toHaveBeenCalledWith(
      route.id,
      route.color
    );
  });

  test('a newer full-view restoration owns the graphics and polling after an old nearby request finishes', async () => {
    mockState.selectedRouteId = null;
    const pending = pauseRequest<INearbyStopsPayload>();
    api.getNearbyStops.mockImplementationOnce(pending.run);
    const oldView = controller.restoreView(position, () => true);
    await pending.reached;
    controller.invalidateView();
    mockState.selectedRouteId = route.id;
    await controller.restoreView(position, () => true);
    jest.clearAllMocks();
    pending.reply(nearby);
    await oldView;
    expect(mockRenderer.renderStopMarkers).not.toHaveBeenCalled();
    expect(mockRenderer.renderRouteGeometry).not.toHaveBeenCalled();
    expect(mockTracker.startPolling).not.toHaveBeenCalled();
    expect(mockRenderer.clearAllRoutes).not.toHaveBeenCalled();
  });
});

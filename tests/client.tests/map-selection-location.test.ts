/** @jest-environment jsdom */

import type { IStop } from '../../common/transit.interface';
import type { MapStateManager } from '../../client/scripts/state/map-state';
import type { RiderShortcuts } from '../../client/scripts/components/rider-shortcuts';

// Exercise the page's real startup/event wiring, state, GPS controller and shared
// stop lookup. Map rendering and unrelated custom elements are boundary doubles.
jest.mock('../../client/scripts/components/app-header', () => ({}));
jest.mock('../../client/scripts/components/transit-search', () => ({}));
jest.mock('../../client/scripts/components/map-controls', () => ({}));
jest.mock('../../client/scripts/components/zoom-controls', () => ({}));
jest.mock('../../client/scripts/components/route-bell', () => ({}));
jest.mock('../../client/scripts/components/live-notifications', () => ({}));
jest.mock('../../client/scripts/components/bus-report-form', () => ({}));
jest.mock('../../client/scripts/components/map-key', () => ({}));
jest.mock('../../client/scripts/components/nearby-stops-panel', () => ({}));
jest.mock('../../client/scripts/components/route-explorer', () => ({}));
jest.mock('../../client/scripts/components/rider-shortcuts', () => ({}));
jest.mock('../../client/scripts/components/location-search', () => ({}));
jest.mock('../../client/scripts/components/toggle-panel', () => ({}));
jest.mock('../../client/scripts/components/route-selector', () => ({}));
jest.mock('../../client/scripts/components/onboarding-tutorial', () => ({}));
jest.mock('../../client/scripts/components/map-selection', () => ({
  dismissMapSelection: jest.fn()
}));
jest.mock('../../client/scripts/state/map-filter-controls', () => ({
  synchronizeMapFilterControls: jest.fn()
}));
jest.mock('../../client/scripts/utils/toast', () => ({ showToast: jest.fn() }));
jest.mock('../../client/scripts/utils/modal', () => ({ showModal: jest.fn() }));
jest.mock('axios', () => ({
  get: jest.fn(async () => ({
    status: 200,
    data: {
      name: 'ConfigFound',
      payload: { apiKey: 'test-map', lat: 40.4433, lon: -79.9436, defaultZoom: 14 }
    }
  }))
}));
jest.mock('../../client/scripts/services/auth.service', () => ({
  authService: {
    isLoggedIn: jest.fn(async () => true),
    getCurrentUserAccount: jest.fn(async () => null),
    syncSubscriptionsFromServer: jest.fn(async () => undefined)
  }
}));

const mockMap = {
  initialize: jest.fn(async () => undefined),
  setCenter: jest.fn(),
  setZoom: jest.fn(),
  getZoom: jest.fn(() => 14),
  addMarker: jest.fn(() => ({
    setPosition: jest.fn(), setVisible: jest.fn(), remove: jest.fn(), onClick: jest.fn()
  }))
};
let mockSelectedStop = false;
const mockFilter = {
  initialize: jest.fn(async () => undefined),
  setRouteSelectorCallback: jest.fn(),
  setUserLocation: jest.fn(),
  canRefreshLocation: jest.fn(() => !mockSelectedStop),
  showStopDetailsFromSearch: jest.fn(async () => { mockSelectedStop = true; })
};
const mockNavigation = {
  start: jest.fn(async () => undefined),
  restore: jest.fn<Promise<void>, []>(async () => undefined),
  cancel: jest.fn(), stop: jest.fn(), resume: jest.fn(),
  commit: jest.fn(), clear: jest.fn()
};
const mockDirections = {
  isActive: false,
  initialize: jest.fn(), setToastCallback: jest.fn(),
  setInfoPanelCallback: jest.fn(), setLoadingCallback: jest.fn(),
  setExitCallback: jest.fn(), updateUserLocation: jest.fn(),
  updatePlannedLocation: jest.fn()
};
const mockTracker = {
  initialize: jest.fn(), setSelectionCallback: jest.fn(),
  setAdminProximityBypass: jest.fn(), updateUserLocation: jest.fn(),
  cancelFollow: jest.fn()
};
const mockPredictions = { setSelectionCallback: jest.fn() };
const mockURL = {
  initialize: jest.fn(), onRestore: jest.fn(), setSelectedStop: jest.fn()
};
jest.mock('../../client/scripts/maps/google-map.provider', () => ({
  GoogleMapProvider: jest.fn(() => mockMap)
}));
jest.mock('../../client/scripts/state/map-navigation', () => ({
  MapNavigationCoordinator: jest.fn(() => mockNavigation)
}));
jest.mock('../../client/scripts/state/url-sync', () => ({
  URLSyncManager: { getInstance: () => mockURL }
}));
jest.mock('../../client/scripts/controllers/filter-controller', () => ({
  FilterController: { getInstance: () => mockFilter }
}));
jest.mock('../../client/scripts/controllers/directions-controller', () => ({
  DirectionsController: { getInstance: () => mockDirections }
}));
jest.mock('../../client/scripts/controllers/prediction-controller', () => ({
  PredictionController: { getInstance: () => mockPredictions }
}));
jest.mock('../../client/scripts/renderers/route-renderer', () => ({
  RouteRenderer: { getInstance: () => ({
    initialize: jest.fn(), setRouteClickCallback: jest.fn(), setFocusedRoute: jest.fn()
  }) }
}));
jest.mock('../../client/scripts/trackers/vehicle-tracker', () => ({
  VehicleTracker: { getInstance: () => mockTracker }
}));

const stop: IStop = {
  stopId: '314', stopName: 'Forbes at Morewood', lat: 40.444, lon: -79.941,
  routes: ['61C'], dtradd: [], dtrrem: []
};
const stopCenter = { lat: stop.lat, lng: stop.lon };
const gpsCenter = { lat: 40.45, lng: -79.95 };
const fix = () => ({
  coords: { latitude: gpsCenter.lat, longitude: gpsCenter.lng, accuracy: 12 },
  timestamp: Date.now()
}) as GeolocationPosition;
const attempts: Array<{ success: PositionCallback; error: PositionErrorCallback }> = [];
const geolocation = {
  watchPosition: jest.fn((success: PositionCallback, error: PositionErrorCallback) => {
    attempts.push({ success, error });
    return attempts.length;
  }),
  clearWatch: jest.fn(), getCurrentPosition: jest.fn()
};
const flush = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
};
type Ready = (event: Event) => Promise<void>;
type ListenerRegistration = {
  target: EventTarget; type: string;
  listener: EventListenerOrEventListenerObject;
  options?: boolean | AddEventListenerOptions;
};
let state: MapStateManager;
let ready: Ready;
let shortcuts: Parameters<RiderShortcuts['configure']>[0];
const listeners: ListenerRegistration[] = [];

beforeEach(async () => {
  jest.resetModules();
  jest.clearAllMocks();
  mockSelectedStop = false;
  mockDirections.isActive = false;
  mockNavigation.restore.mockReset().mockResolvedValue(undefined);
  attempts.length = 0;
  localStorage.clear();
  localStorage.setItem('token', 'test-session');
  history.replaceState(null, '', '/#/map?stop=314');
  document.body.innerHTML = '<div class="map-container"><div id="map"></div></div><rider-shortcuts></rider-shortcuts>';
  Object.assign(document.querySelector('rider-shortcuts')!, {
    configure: (context: typeof shortcuts) => { shortcuts = context; }
  });
  Object.defineProperty(navigator, 'geolocation', {
    configurable: true, value: geolocation
  });
  Object.defineProperty(globalThis, 'fetch', {
    configurable: true, writable: true,
    value: jest.fn(async () => ({
      ok: true, json: async () => ({ name: 'SearchTransitCompleted', payload: { stops: [stop] } })
    }))
  });
  jest.spyOn(customElements, 'whenDefined').mockResolvedValue(HTMLElement);
  const addDocument = document.addEventListener.bind(document);
  jest.spyOn(document, 'addEventListener').mockImplementation((type, listener, options) => {
    if (type === 'DOMContentLoaded') {
      ready = listener as Ready;
      return;
    }
    listeners.push({ target: document, type, listener, options });
    addDocument(type, listener, options);
  });
  const addWindow = window.addEventListener.bind(window);
  jest.spyOn(window, 'addEventListener').mockImplementation((type, listener, options) => {
    listeners.push({ target: window, type, listener, options });
    addWindow(type, listener, options);
  });
  state = (await import('../../client/scripts/state/map-state')).MapStateManager.getInstance();
  await import('../../client/scripts/map');
});

afterEach(() => {
  window.dispatchEvent(new Event('pagehide'));
  for (const { target, type, listener, options } of listeners.splice(0))
    target.removeEventListener(type, listener, options);
  jest.restoreAllMocks();
});

const start = () => ready(new Event('DOMContentLoaded'));

test('a shared stop keeps its viewport when the first GPS fix arrives', async () => {
  await start();
  expect(mockFilter.showStopDetailsFromSearch).toHaveBeenCalledWith(stop);
  mockMap.setCenter.mockClear();
  mockMap.setZoom.mockClear();
  attempts[0].success(fix());
  expect(mockMap.setCenter).not.toHaveBeenCalled();
  expect(mockMap.setZoom).not.toHaveBeenCalled();
  expect(state.getState().currentLocation).toEqual(gpsCenter);
  expect(mockTracker.updateUserLocation).toHaveBeenLastCalledWith(gpsCenter);
});

test.each([1, 2, 3])('GPS failure %i leaves the shared stop visible instead of centering campus', async (code) => {
  await start();
  mockMap.setCenter.mockClear();
  attempts[0].error({ code, message: 'Unavailable' } as GeolocationPositionError);
  expect(mockMap.setCenter).not.toHaveBeenCalled();
  expect(state.getState().gpsPermissionGranted).toBe(false);
  expect(document.getElementById('location-feedback')).not.toBeNull();
  expect(mockDirections.updateUserLocation).toHaveBeenLastCalledWith(null);
});

test('a shared stop takes viewport priority over an older persisted planned location', async () => {
  const oldPlace = { lat: 40.46, lng: -79.96 };
  state.setPlannedLocation(oldPlace, 'Saved home');
  await start();
  expect(mockMap.setCenter.mock.calls).toEqual([[stopCenter]]);
  expect(mockMap.setZoom).toHaveBeenLastCalledWith(16);
  expect(mockFilter.setUserLocation).toHaveBeenLastCalledWith(oldPlace);
  expect(state.getState().plannedLocation).toEqual(oldPlace);
  attempts[0].success(fix());
  expect(mockMap.setCenter).toHaveBeenLastCalledWith(stopCenter);
});

test('explicit recenter obtains a fresh fix and focuses the rider after selecting a stop', async () => {
  await start();
  document.dispatchEvent(new Event('recenter'));
  expect(geolocation.watchPosition).toHaveBeenCalledTimes(2);
  expect(mockURL.setSelectedStop).toHaveBeenLastCalledWith(null);
  attempts.at(-1)!.success(fix());
  expect(mockMap.setCenter).toHaveBeenLastCalledWith(gpsCenter);
  expect(mockMap.setZoom.mock.calls.at(-1)![0]).toBeGreaterThan(15);
});

test('explicit recenter uses the existing GPS fix without starting another watch', async () => {
  await start();
  attempts[0].success(fix());
  document.dispatchEvent(new Event('recenter'));
  expect(geolocation.watchPosition).toHaveBeenCalledTimes(1);
  expect(mockMap.setCenter).toHaveBeenLastCalledWith(gpsCenter);
});

test('a stop selected while an explicit GPS retry is pending keeps the latest viewport', async () => {
  await start();
  document.dispatchEvent(new Event('recenter'));
  document.dispatchEvent(new CustomEvent('searchSelectStop', { detail: { stop } }));
  mockMap.setCenter.mockClear();
  attempts.at(-1)!.success(fix());
  expect(state.getState().currentLocation).toEqual(gpsCenter);
  expect(mockMap.setCenter).not.toHaveBeenCalled();
});

test('selecting a stop from search before GPS arrives also preserves the selected viewport', async () => {
  history.replaceState(null, '', '/#/map');
  await start();
  document.dispatchEvent(new CustomEvent('searchSelectStop', { detail: { stop } }));
  attempts[0].success(fix());
  expect(mockMap.setCenter.mock.calls).toEqual([[stopCenter]]);
  expect(mockNavigation.cancel).toHaveBeenCalled();
});

test('selecting a saved place centers it again after route restoration finishes', async () => {
  await start();
  const place = { id: 'home', name: 'Home', label: 'Saved address', lat: 40.46, lng: -79.96 };
  let finishRestore!: () => void;
  mockNavigation.restore.mockImplementationOnce(() => new Promise<void>((resolve) => {
    finishRestore = resolve;
  }));
  shortcuts.onSelectPlace(place);
  expect(state.getState().plannedLocation).toEqual({ lat: place.lat, lng: place.lng });
  expect(mockMap.setCenter).toHaveBeenLastCalledWith({ lat: place.lat, lng: place.lng });
  // Route restoration may change the map viewport while it renders geometry.
  mockMap.setCenter({ lat: 40.44, lng: -79.94 });
  finishRestore();
  await flush();
  expect(mockMap.setCenter).toHaveBeenLastCalledWith({ lat: place.lat, lng: place.lng });
  expect(mockMap.setZoom.mock.calls.at(-1)![0]).toBeGreaterThan(15);
});

test('a newer stop selection wins over a still-pending saved-place restoration', async () => {
  await start();
  let finishRestore!: () => void;
  mockNavigation.restore.mockImplementationOnce(() => new Promise<void>((resolve) => {
    finishRestore = resolve;
  }));
  shortcuts.onSelectPlace({ id: 'home', name: 'Home', label: 'Saved address', lat: 40.46, lng: -79.96 });
  document.dispatchEvent(new CustomEvent('searchSelectStop', { detail: { stop } }));
  mockMap.setCenter.mockClear();
  finishRestore();
  await flush();
  expect(mockMap.setCenter).not.toHaveBeenCalled();
  expect(mockURL.setSelectedStop).toHaveBeenLastCalledWith(stop.stopId);
});

test('direct stop and bus selections invalidate in-flight navigation through controller callbacks', async () => {
  await start();
  mockNavigation.cancel.mockClear();
  mockPredictions.setSelectionCallback.mock.calls[0][0](stop);
  expect(mockURL.setSelectedStop).toHaveBeenLastCalledWith(stop.stopId);
  expect(mockNavigation.cancel).toHaveBeenCalledTimes(1);
  mockTracker.setSelectionCallback.mock.calls[0][0]();
  expect(mockURL.setSelectedStop).toHaveBeenLastCalledWith(null);
  expect(mockNavigation.cancel).toHaveBeenCalledTimes(2);
});

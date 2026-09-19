/** @jest-environment jsdom */

import { MapStateManager } from '../../client/scripts/state/map-state';

const mockMarkers: Array<{
  setPosition: jest.Mock;
  setVisible: jest.Mock;
  remove: jest.Mock;
  onClick: jest.Mock;
}> = [];
const mockMap = {
  setCenter: jest.fn(),
  setZoom: jest.fn(),
  addMarker: jest.fn(() => {
    const marker = {
      setPosition: jest.fn(),
      setVisible: jest.fn(),
      remove: jest.fn(),
      onClick: jest.fn()
    };
    mockMarkers.push(marker);
    return marker;
  })
};
const mockFilter = {
  setUserLocation: jest.fn(),
  canRefreshLocation: () => false
};
const mockDirections = {
  isActive: false,
  updateUserLocation: jest.fn(),
  updatePlannedLocation: jest.fn()
};
const mockTracker = { updateUserLocation: jest.fn() };
jest.mock('../../client/scripts/services/auth.service', () => ({
  authService: {}
}));
jest.mock('../../client/scripts/utils/toast', () => ({ showToast: jest.fn() }));
jest.mock('../../client/scripts/components/live-notifications', () => ({}));
jest.mock('../../client/scripts/maps/google-map.provider', () => ({
  GoogleMapProvider: jest.fn(() => mockMap)
}));
jest.mock('../../client/scripts/state/url-sync', () => ({
  URLSyncManager: { getInstance: () => ({}) }
}));
jest.mock('../../client/scripts/controllers/filter-controller', () => ({
  FilterController: { getInstance: () => mockFilter }
}));
jest.mock('../../client/scripts/controllers/directions-controller', () => ({
  DirectionsController: { getInstance: () => mockDirections }
}));
jest.mock('../../client/scripts/renderers/route-renderer', () => ({
  RouteRenderer: { getInstance: () => ({}) }
}));
jest.mock('../../client/scripts/trackers/vehicle-tracker', () => ({
  VehicleTracker: { getInstance: () => mockTracker }
}));

const attempts: Array<{
  success: PositionCallback;
  error: PositionErrorCallback;
}> = [];
const geolocation = {
  watchPosition: jest.fn(
    (success: PositionCallback, error: PositionErrorCallback) => {
      attempts.push({ success, error });
      return attempts.length;
    }
  ),
  clearWatch: jest.fn(),
  getCurrentPosition: jest.fn()
};
const error = (code: number) =>
  ({ code, message: 'Provider detail' }) as GeolocationPositionError;
const fix = (lat = 40.45, lng = -79.95) =>
  ({
    coords: { latitude: lat, longitude: lng, accuracy: 12 },
    timestamp: Date.now()
  }) as GeolocationPosition;
let requestUserLocation: (retry?: boolean) => void;

beforeAll(async () => {
  Object.defineProperty(navigator, 'geolocation', {
    configurable: true,
    value: geolocation
  });
  const addListener = document.addEventListener.bind(document);
  const ready = jest
    .spyOn(document, 'addEventListener')
    .mockImplementation((type, listener, options) => {
      if (type !== 'DOMContentLoaded') addListener(type, listener, options);
    });
  ({ requestUserLocation } = await import('../../client/scripts/map'));
  ready.mockRestore();
});

beforeEach(() => {
  document.body.innerHTML =
    '<div class="map-container"></div><button id="recenter-btn">Locate</button>';
  localStorage.clear();
  const state = MapStateManager.getInstance();
  state.resetPlannedLocationToCurrent();
  state.setGpsUnavailable();
  jest.clearAllMocks();
  requestUserLocation(true);
});
afterEach(() => window.dispatchEvent(new Event('pagehide')));

test('a timed-out first fix can recover through the visible retry action', () => {
  attempts.at(-1)!.error(error(3));
  expect(document.body.textContent).toMatch(/took too long/i);
  expect(document.body.textContent).not.toContain('Location Access Denied');
  expect(MapStateManager.getInstance().hasCustomPlannedLocation()).toBe(false);
  const fallback = mockMarkers.at(-1)!;
  const retry = Array.from(document.querySelectorAll('button')).find((button) =>
    /try again/i.test(button.textContent ?? '')
  )!;
  retry.click();
  expect(geolocation.watchPosition).toHaveBeenCalledTimes(2);
  attempts.at(-1)!.success(fix());
  expect(MapStateManager.getInstance().getState()).toMatchObject({
    gpsPermissionGranted: true,
    currentLocation: { lat: 40.45, lng: -79.95 },
    plannedLocationLabel: 'Current Location'
  });
  expect(fallback.remove).toHaveBeenCalled();
  expect(mockMap.setCenter).toHaveBeenLastCalledWith({
    lat: 40.45,
    lng: -79.95
  });
  expect(mockDirections.updatePlannedLocation).toHaveBeenLastCalledWith(null);
  expect(document.getElementById('location-feedback')).toBeNull();
});

test('denial and GPS recovery preserve a deliberately chosen starting point', () => {
  const state = MapStateManager.getInstance();
  state.setPlannedLocation({ lat: 40.46, lng: -79.96 }, 'CMU Campus');
  attempts.at(-1)!.error(error(1));
  expect(state.getState().gpsPermissionGranted).toBe(false);
  expect(mockMap.setCenter).not.toHaveBeenCalled();
  requestUserLocation(true);
  attempts.at(-1)!.success(fix());
  attempts.at(-1)!.success(fix(40.451, -79.951));
  expect(state.getState().plannedLocation).toEqual({ lat: 40.46, lng: -79.96 });
  expect(state.getState().gpsPermissionGranted).toBe(true);
  expect(mockFilter.setUserLocation).toHaveBeenLastCalledWith({
    lat: 40.46,
    lng: -79.96
  });
  expect(mockTracker.updateUserLocation).toHaveBeenLastCalledWith({
    lat: 40.451,
    lng: -79.951
  });
});

test('denial after a successful fix invalidates GPS and a restored page opens a fresh watch', () => {
  attempts.at(-1)!.success(fix());
  attempts.at(-1)!.error(error(1));
  expect(MapStateManager.getInstance().getState()).toMatchObject({
    gpsPermissionGranted: false,
    currentLocation: null
  });
  expect(mockDirections.updateUserLocation).toHaveBeenLastCalledWith(null);
  expect(mockTracker.updateUserLocation).toHaveBeenLastCalledWith(null);
  expect(mockFilter.setUserLocation).toHaveBeenLastCalledWith({
    lat: 40.4433,
    lng: -79.9436
  });
  expect(mockDirections.updatePlannedLocation).toHaveBeenLastCalledWith({
    lat: 40.4433,
    lng: -79.9436
  });
  window.dispatchEvent(new Event('pagehide'));
  const stale = attempts.at(-1)!;
  stale.success(fix(40.5, -80));
  expect(MapStateManager.getInstance().getState().currentLocation).toBeNull();
  window.dispatchEvent(
    new PageTransitionEvent('pageshow', { persisted: true })
  );
  attempts.at(-1)!.success(fix());
  expect(MapStateManager.getInstance().getState().gpsPermissionGranted).toBe(
    true
  );
});

test('returning after a failed request retries without requiring a full reload', () => {
  attempts.at(-1)!.error(error(2));
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    value: 'visible'
  });
  document.dispatchEvent(new Event('visibilitychange'));
  expect(geolocation.watchPosition).toHaveBeenCalledTimes(2);
  attempts.at(-1)!.success(fix());
  expect(document.getElementById('location-feedback')).toBeNull();
});

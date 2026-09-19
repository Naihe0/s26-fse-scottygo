/** @jest-environment jsdom */

import { DirectionsController } from '../../client/scripts/controllers/directions-controller';
import {
  requestWalkingDirections,
  IDirectionsResult
} from '../../client/scripts/services/walking-directions.service';
import type { IMapProvider, IMapPolyline } from '../../common/map.interface';
import type { IStop } from '../../common/transit.interface';

const mockClearRoutes = jest.fn();
const mockStopPolling = jest.fn();
jest.mock('../../client/scripts/renderers/route-renderer', () => ({
  RouteRenderer: { getInstance: () => ({ clearAllRoutes: mockClearRoutes }) }
}));
jest.mock('../../client/scripts/trackers/vehicle-tracker', () => ({
  VehicleTracker: { getInstance: () => ({ stopPolling: mockStopPolling }) }
}));
jest.mock('../../client/scripts/utils/map-popup', () => ({
  closeMapPopup: jest.fn()
}));
jest.mock('../../client/scripts/services/walking-directions.service', () => ({
  requestWalkingDirections: jest.fn()
}));

const request = jest.mocked(requestWalkingDirections);
const origin = { lat: 40.44, lng: -79.94 };
const stop: IStop = {
  stopId: 'test-stop',
  stopName: 'Test stop',
  lat: 40.45,
  lon: -79.94,
  dtradd: [],
  dtrrem: []
};
const route: IDirectionsResult = {
  polyline: [origin, { lat: stop.lat, lng: stop.lon }],
  durationSeconds: 600,
  distanceMeters: 1100,
  warnings: ['Use caution on walking routes.']
};

function deferredRoute() {
  let resolve!: (value: IDirectionsResult) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<IDirectionsResult>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('Walking directions lifecycle', () => {
  let controller: DirectionsController;
  let polyline: IMapPolyline;
  const addPolyline = jest.fn();
  const toast = jest.fn();
  const loading = jest.fn();
  const panel = jest.fn();
  const restoreMap = jest.fn();
  let testNumber = 0;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(Date.UTC(2026, 8, 19) + testNumber++ * 1_000_000);
    jest.clearAllMocks();
    request.mockReset();
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    polyline = {
      id: 'walk',
      remove: jest.fn(),
      setVisible: jest.fn(),
      onClick: jest.fn()
    };
    addPolyline.mockReturnValue(polyline);
    controller = DirectionsController.getInstance();
    controller.initialize({ addPolyline } as unknown as IMapProvider);
    controller.updatePlannedLocation(origin);
    controller.updateUserLocation(origin);
    controller.setToastCallback(toast);
    controller.setLoadingCallback(loading);
    controller.setInfoPanelCallback(panel);
    controller.setExitCallback(restoreMap);
  });

  afterEach(() => {
    controller.exitDirections();
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  test('cleared GPS cannot start directions from a stale fix; a new fix restores the origin', async () => {
    controller.updatePlannedLocation(null);
    controller.updateUserLocation(null);
    const warning = jest
      .spyOn(console, 'warn')
      .mockImplementation(() => undefined);
    await expect(controller.startDirections(stop)).resolves.toBe(false);
    expect(request).not.toHaveBeenCalled();
    expect(toast).toHaveBeenCalledWith(
      'Choose a starting location before requesting directions.'
    );

    jest.advanceTimersByTime(600);
    const recovered = { lat: 40.43, lng: -79.95 };
    controller.updateUserLocation(recovered);
    request.mockResolvedValue(route);
    await expect(controller.startDirections(stop)).resolves.toBe(true);
    expect(request.mock.calls[0][0]).toEqual(recovered);
    warning.mockRestore();
  });

  test('clearing GPS during active directions does not run arrival or deviation checks', async () => {
    controller.updatePlannedLocation(null);
    request.mockResolvedValue(route);
    await controller.startDirections(stop);
    expect(() => controller.updateUserLocation(null)).not.toThrow();
    expect(controller.isActive).toBe(true);
    expect(controller.targetStop).toEqual(stop);
    expect(request).toHaveBeenCalledTimes(1);
    expect(restoreMap).not.toHaveBeenCalled();
    expect(toast).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(1);
  });

  test('an explicit planned origin remains usable after GPS is cleared', async () => {
    const planned = { lat: 40.46, lng: -79.96 };
    controller.updatePlannedLocation(planned);
    controller.updateUserLocation(null);
    request.mockResolvedValue(route);
    await expect(controller.startDirections(stop)).resolves.toBe(true);
    expect(request.mock.calls[0][0]).toEqual(planned);
  });

  test.each([
    ['denial', new Error('REQUEST_DENIED')],
    ['timeout', new DOMException('Request timed out', 'TimeoutError')],
    ['provider abort', new DOMException('Request aborted', 'AbortError')]
  ])(
    'restores the map after initial %s instead of leaving directions active',
    async (_name, error) => {
      request.mockRejectedValue(error);

      await expect(controller.startDirections(stop)).resolves.toBe(false);

      expect(controller.isActive).toBe(false);
      expect(controller.targetStop).toBeNull();
      expect(restoreMap).toHaveBeenCalledTimes(1);
      expect(toast).toHaveBeenCalledTimes(1);
      expect(loading.mock.calls).toEqual([[true], [false]]);
      expect(panel).toHaveBeenLastCalledWith(null);
      expect(addPolyline).not.toHaveBeenCalled();
      expect(jest.getTimerCount()).toBe(0);
    }
  );

  test('can exit while loading; a late response cannot reactivate the map', async () => {
    const pending = deferredRoute();
    request.mockReturnValue(pending.promise);
    const started = controller.startDirections(stop);
    const signal = request.mock.calls[0][2];

    expect(loading).toHaveBeenCalledWith(true);
    controller.exitDirections();
    expect(signal.aborted).toBe(true);
    pending.resolve(route);

    await expect(started).resolves.toBe(false);
    expect(controller.isActive).toBe(false);
    expect(addPolyline).not.toHaveBeenCalled();
    expect(restoreMap).toHaveBeenCalledTimes(1);
    expect(toast).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
  });

  test('ignores an old completion after a replacement route succeeds', async () => {
    const oldRequest = deferredRoute();
    request
      .mockReturnValueOnce(oldRequest.promise)
      .mockResolvedValueOnce(route);
    const oldStart = controller.startDirections(stop);
    const oldSignal = request.mock.calls[0][2];
    jest.advanceTimersByTime(600);
    const nextStop = { ...stop, stopId: 'next-stop' };

    await expect(controller.startDirections(nextStop)).resolves.toBe(true);
    oldRequest.resolve(route);
    await expect(oldStart).resolves.toBe(false);

    expect(oldSignal.aborted).toBe(true);
    expect(controller.targetStop).toBe(nextStop);
    expect(controller.isActive).toBe(true);
    expect(addPolyline).toHaveBeenCalledTimes(1);
    expect(polyline.remove).not.toHaveBeenCalled();
    expect(restoreMap).not.toHaveBeenCalled();
    expect(panel).toHaveBeenCalledTimes(1);
    expect(panel).toHaveBeenLastCalledWith(
      expect.objectContaining({ warnings: route.warnings })
    );
    expect(jest.getTimerCount()).toBe(1);
  });

  test('keeps the displayed route and exit control when rerouting fails', async () => {
    request
      .mockResolvedValueOnce(route)
      .mockRejectedValueOnce(new Error('REQUEST_DENIED'));
    await controller.startDirections(stop);
    jest.advanceTimersByTime(45_000);

    controller.updateUserLocation({ lat: 40.44, lng: -79.95 });
    await jest.advanceTimersByTimeAsync(0);

    expect(request).toHaveBeenCalledTimes(2);
    expect(controller.isActive).toBe(true);
    expect(polyline.remove).not.toHaveBeenCalled();
    expect(panel).toHaveBeenCalledTimes(1);
    expect(restoreMap).not.toHaveBeenCalled();
    expect(toast).toHaveBeenCalledWith(
      expect.stringContaining('Keeping your current route')
    );
    controller.exitDirections();
    expect(polyline.remove).toHaveBeenCalledTimes(1);
    expect(restoreMap).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });

  test('preserves the walking path and coalesces repeated GPS deviations', async () => {
    request.mockResolvedValue(route);
    await controller.startDirections(stop);

    for (let i = 0; i < 20; i++) {
      controller.updateUserLocation({ lat: 40.44, lng: -79.95 });
    }
    expect(jest.getTimerCount()).toBe(2); // One periodic + one deferred reroute.
    await jest.advanceTimersByTimeAsync(44_999);
    expect(request).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1);
    expect(request).toHaveBeenCalledTimes(2);
    controller.updateUserLocation({ lat: 40.44, lng: -79.95 });
    expect(jest.getTimerCount()).toBe(2);
    controller.exitDirections();
    expect(jest.getTimerCount()).toBe(0);
    await jest.advanceTimersByTimeAsync(120_000);
    expect(request).toHaveBeenCalledTimes(2);
  });
});

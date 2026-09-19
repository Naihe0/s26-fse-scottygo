/** @jest-environment jsdom */

import { VehicleTracker } from '../../client/scripts/trackers/vehicle-tracker';
import {
  transitApiService,
  type IVehicleResult
} from '../../client/scripts/services/transit-api.service';
import type { IMapMarker, IMapProvider } from '../../common/map.interface';
import type { IVehicle } from '../../common/transit.interface';
import { showToast } from '../../client/scripts/utils/toast';

const mockSetActiveVehicles = jest.fn();
jest.mock('../../client/scripts/state/map-state', () => ({
  MapStateManager: {
    getInstance: () => ({
      getState: () => ({
        selectedDirections: { inbound: true, outbound: true }
      }),
      setActiveVehicles: mockSetActiveVehicles
    })
  }
}));
jest.mock('../../client/scripts/services/transit-api.service', () => ({
  transitApiService: { getVehicles: jest.fn() }
}));
jest.mock('../../client/scripts/utils/bus-icon', () => ({
  createBusIcon: () => ({
    url: 'mock-bus-icon',
    anchor: { x: 0, y: 0 },
    size: { width: 20, height: 20 }
  })
}));
jest.mock('../../client/scripts/utils/map-popup', () => ({
  closeMapPopup: jest.fn()
}));
jest.mock('../../client/scripts/utils/toast', () => ({ showToast: jest.fn() }));

const getVehicles = jest.mocked(transitApiService.getVehicles);

function vehicle(vid: string, routeId = '61C'): IVehicle {
  return {
    vid,
    routeId,
    lat: 40.44,
    lon: -79.94,
    heading: 180,
    source: 'live',
    lastUpdate: '2026-09-19T12:00:00Z',
    isDetoured: false
  };
}

function deferredVehicles() {
  let resolve!: (value: IVehicleResult) => void;
  const promise = new Promise<IVehicleResult>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe('vehicle polling cancellation', () => {
  let tracker: VehicleTracker;
  let addMarker: jest.Mock<IMapMarker>;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    getVehicles.mockReset().mockResolvedValue(null);
    addMarker = jest.fn(() => ({
      id: 'mock-marker',
      setPosition: jest.fn(),
      animatePosition: jest.fn(),
      setIcon: jest.fn(),
      setVisible: jest.fn(),
      onClick: jest.fn(),
      remove: jest.fn()
    }));
    tracker = VehicleTracker.getInstance();
    tracker.initialize({
      getZoom: () => 14,
      onZoomChanged: jest.fn(),
      addMarker
    } as unknown as IMapProvider);
  });

  afterEach(() => {
    tracker.stopPolling();
    expect(jest.getTimerCount()).toBe(0);
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  test('a stopped single-route response cannot restore markers, state, or status toasts', async () => {
    const pending = deferredVehicles();
    getVehicles.mockReturnValueOnce(pending.promise);
    tracker.startPolling('61C');
    tracker.stopPolling();
    pending.resolve({ vehicles: [vehicle('cancelled')], source: 'static' });
    await jest.advanceTimersByTimeAsync(0);

    expect(addMarker).not.toHaveBeenCalled();
    expect(mockSetActiveVehicles).not.toHaveBeenCalled();
    expect(showToast).not.toHaveBeenCalled();
    expect(tracker.getVehiclePositions()).toEqual([]);
    expect(jest.getTimerCount()).toBe(0);
  });

  test('stopping a pending multi-route poll prevents remaining requests and rendering', async () => {
    const pending = deferredVehicles();
    getVehicles.mockReturnValueOnce(pending.promise);
    tracker.startMultiRoutePolling(['61C', '71A']);
    tracker.stopPolling();
    pending.resolve({ vehicles: [vehicle('cancelled')] });
    await jest.advanceTimersByTimeAsync(0);

    expect(getVehicles).toHaveBeenCalledTimes(1);
    expect(addMarker).not.toHaveBeenCalled();
    expect(tracker.getVehiclePositions()).toEqual([]);
    expect(jest.getTimerCount()).toBe(0);
  });

  test('restarting the same single route ignores the older result after the fresh markers render', async () => {
    const pending = deferredVehicles();
    const currentVehicle = vehicle('current');
    getVehicles
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValueOnce({ vehicles: [currentVehicle] });
    tracker.startPolling('61C');
    tracker.startPolling('61C');
    await jest.advanceTimersByTimeAsync(0);
    const marker = addMarker.mock.results[0].value;

    pending.resolve({ vehicles: [vehicle('stale')] });
    await jest.advanceTimersByTimeAsync(0);

    expect(addMarker).toHaveBeenCalledTimes(1);
    expect(addMarker).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Bus current' })
    );
    expect(marker.remove).not.toHaveBeenCalled();
    expect(mockSetActiveVehicles).toHaveBeenCalledTimes(1);
    expect(mockSetActiveVehicles).toHaveBeenCalledWith([currentVehicle]);
    expect(jest.getTimerCount()).toBe(1);
  });

  test('restarting multi-route polling ignores an earlier response for the same route', async () => {
    const pending = deferredVehicles();
    getVehicles
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValueOnce({ vehicles: [vehicle('current')] });
    tracker.startMultiRoutePolling(['61C']);
    tracker.startMultiRoutePolling(['61C']);
    await jest.advanceTimersByTimeAsync(0);
    const marker = addMarker.mock.results[0].value;

    pending.resolve({ vehicles: [vehicle('stale')] });
    await jest.advanceTimersByTimeAsync(0);

    expect(addMarker).toHaveBeenCalledTimes(1);
    expect(addMarker).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Bus current' })
    );
    expect(marker.remove).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(1);
  });

  test('switching to multi-route polling cancels the former single-route request and interval', async () => {
    const pending = deferredVehicles();
    getVehicles
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValue({ vehicles: [vehicle('current', '71A')] });
    tracker.startPolling('61C');
    tracker.startMultiRoutePolling(['71A']);
    await jest.advanceTimersByTimeAsync(0);
    pending.resolve({ vehicles: [vehicle('cancelled')] });
    await jest.advanceTimersByTimeAsync(30_000);

    expect(getVehicles.mock.calls.map(([routeId]) => routeId)).toEqual([
      '61C',
      '71A',
      '71A'
    ]);
    expect(addMarker).toHaveBeenCalledTimes(1);
    expect(mockSetActiveVehicles).not.toHaveBeenCalled();
    expect(tracker.getCurrentRouteId()).toBeNull();
    expect(jest.getTimerCount()).toBe(1);
  });

  test('an active multi-route poll renders every route together after all responses finish', async () => {
    const pending = deferredVehicles();
    getVehicles
      .mockResolvedValueOnce({ vehicles: [vehicle('first')] })
      .mockReturnValueOnce(pending.promise);
    tracker.startMultiRoutePolling(['61C', '71A']);
    await jest.advanceTimersByTimeAsync(0);
    expect(addMarker).not.toHaveBeenCalled();

    pending.resolve({ vehicles: [vehicle('second', '71A')] });
    await jest.advanceTimersByTimeAsync(0);

    expect(addMarker.mock.calls.map(([options]) => options.title)).toEqual([
      'Bus first',
      'Bus second'
    ]);
    expect(tracker.getVehiclePositions()).toHaveLength(2);
  });
});

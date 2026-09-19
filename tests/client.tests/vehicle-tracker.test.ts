/** @jest-environment jsdom */

import { VehicleTracker } from '../../client/scripts/trackers/vehicle-tracker';
import {
  transitApiService,
  type IServiceHealth,
  type IVehicleResult
} from '../../client/scripts/services/transit-api.service';
import type { IMapMarker, IMapProvider } from '../../common/map.interface';
import type { IVehicle } from '../../common/transit.interface';
import { dismissPopup } from '../../client/scripts/utils/map-popup';

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
  transitApiService: { getVehicles: jest.fn(), getHealth: jest.fn() }
}));
jest.mock('../../client/scripts/utils/bus-icon', () => ({
  createBusIcon: () => ({
    url: 'mock-bus-icon',
    anchor: { x: 0, y: 0 },
    size: { width: 20, height: 20 }
  })
}));
jest.mock('../../client/scripts/utils/map-popup', () => ({
  dismissPopup: jest.fn()
}));
jest.mock('../../client/scripts/utils/toast', () => ({ showToast: jest.fn() }));

const getVehicles = jest.mocked(transitApiService.getVehicles);
const getHealth = jest.mocked(transitApiService.getHealth);
const feed = { healthy: true, consecutiveFailures: 0, error: null };
const healthy = (): IServiceHealth => ({
  gtfs: { ready: true },
  memory: {},
  vehiclePositions: { ...feed },
  tripUpdates: { ...feed },
  tripshotLiveStatus: { ...feed },
  trueTimeColors: { available: true },
  overall: true
});
function vehicle(vid: string, routeId = '61C', ageMs = 0): IVehicle {
  return {
    vid,
    routeId,
    lat: 40.44,
    lon: -79.94,
    heading: 180,
    source: 'live',
    lastUpdate: new Date(Date.now() - ageMs).toISOString(),
    isDetoured: false
  };
}
function deferredVehicles() {
  let resolve!: (value: IVehicleResult | null) => void;
  const promise = new Promise<IVehicleResult | null>((reply) => {
    resolve = reply;
  });
  return { promise, resolve };
}

describe('live vehicle freshness and polling lifecycle', () => {
  let tracker: VehicleTracker;
  let addMarker: jest.Mock<IMapMarker>;
  const status = () =>
    document.querySelector<HTMLElement>('.live-tracking-status')!;
  const tick = (ms = 0) => jest.advanceTimersByTimeAsync(ms);
  const hidden = (value: boolean) => {
    Object.defineProperty(document, 'hidden', { configurable: true, value });
    document.dispatchEvent(new Event('visibilitychange'));
  };

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-09-19T12:00:00Z'));
    jest.clearAllMocks();
    jest.mocked(dismissPopup).mockReset();
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    document.body.innerHTML = '<div class="map-container"></div>';
    Object.defineProperty(document, 'hidden', {
      configurable: true,
      value: false
    });
    localStorage.setItem('token', 'test-session');
    getVehicles.mockReset().mockResolvedValue({ vehicles: [] });
    getHealth.mockReset().mockResolvedValue(healthy());
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
    window.dispatchEvent(new Event('pageshow'));
  });
  afterEach(() => {
    tracker.stopPolling();
    expect(jest.getTimerCount()).toBe(0);
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  test('fresh live buses render with accessible persistent status', async () => {
    getVehicles.mockResolvedValue({ vehicles: [vehicle('fresh')] });
    tracker.startPolling('61C');
    expect(status().dataset.state).toBe('loading');
    await tick();
    expect(addMarker).toHaveBeenCalledTimes(1);
    expect(status().dataset.state).toBe('live');
    expect(status().getAttribute('role')).toBe('status');
    expect(status().getAttribute('aria-live')).toBe('polite');
    expect(mockSetActiveVehicles).toHaveBeenLastCalledWith([vehicle('fresh')]);
  });

  test('only a successful healthy empty response says there are no active buses', async () => {
    tracker.startPolling('61C');
    await tick();
    expect(status().dataset.state).toBe('empty');
    const failed = healthy();
    failed.vehiclePositions.healthy = false;
    getHealth.mockResolvedValue(failed);
    await tick(30_000);
    expect(status().dataset.state).toBe('unavailable');
    expect(status().textContent).not.toContain('No active');
  });

  test.each(['positions', 'health', 'provider', 'scheduled'])(
    'removes previous markers when %s becomes unavailable',
    async (failure) => {
      getVehicles.mockResolvedValue({ vehicles: [vehicle('old')] });
      tracker.startPolling('61C');
      await tick();
      const marker = addMarker.mock.results[0].value;
      if (failure === 'positions') getVehicles.mockResolvedValue(null);
      if (failure === 'health') getHealth.mockResolvedValue(null);
      if (failure === 'provider') {
        const failed = healthy();
        failed.vehiclePositions.healthy = false;
        getHealth.mockResolvedValue(failed);
      }
      if (failure === 'scheduled')
        getVehicles.mockResolvedValue({
          vehicles: [vehicle('old')],
          source: 'static'
        });
      await tick(30_000);
      expect(marker.remove).toHaveBeenCalled();
      expect(tracker.getVehiclePositions()).toEqual([]);
      expect(mockSetActiveVehicles).toHaveBeenLastCalledWith([]);
      expect(status().dataset.state).toBe('unavailable');
    }
  );

  test.each(['expired', 'invalid', 'future', 'scheduled', 'coordinates'])(
    'never presents %s positions as live',
    async (kind) => {
      const stale = vehicle('stale', '61C', 90_000);
      if (kind === 'invalid') stale.lastUpdate = 'not-a-date';
      if (kind === 'future')
        stale.lastUpdate = new Date(Date.now() + 31_000).toISOString();
      if (kind === 'scheduled') {
        stale.lastUpdate = new Date().toISOString();
        stale.source = 'static';
      }
      if (kind === 'coordinates') {
        stale.lastUpdate = new Date().toISOString();
        stale.lat = NaN;
      }
      getVehicles.mockResolvedValue({ vehicles: [stale] });
      tracker.startPolling('61C');
      await tick();
      expect(addMarker).not.toHaveBeenCalled();
      expect(status().dataset.state).toBe('delayed');
      expect(status().textContent).not.toContain('No active');
    }
  );

  test('expiry removes a live marker and its bus popup before the next network poll', async () => {
    getVehicles.mockResolvedValue({
      vehicles: [vehicle('aging', '61C', 80_000)]
    });
    tracker.startPolling('61C');
    await tick();
    const marker = addMarker.mock.results[0].value;
    await tick(10_000);
    expect(getVehicles).toHaveBeenCalledTimes(1);
    expect(marker.remove).toHaveBeenCalled();
    expect(status().dataset.state).toBe('delayed');
    expect(mockSetActiveVehicles).toHaveBeenLastCalledWith([]);
    expect(
      jest.mocked(dismissPopup).mock.calls.every(([type]) => type === 'bus')
    ).toBe(true);
  });

  test.each(['route', 'stop'] as const)(
    'vehicle cleanup preserves an open %s popup and dismisses its own docked popup',
    async (type) => {
      const popups = jest.requireActual<
        typeof import('../../client/scripts/utils/map-popup')
      >('../../client/scripts/utils/map-popup');
      popups.dismissPopup();
      jest.mocked(dismissPopup).mockImplementation(popups.dismissPopup);
      tracker.startPolling('61C');
      await tick();
      const container = document.querySelector('.map-container')!;
      const bus = popups.createMapPopup(
        'bus',
        'directions_bus',
        'Old bus'
      ).popup;
      container.appendChild(bus);
      popups.registerActivePopup('bus', 'Old bus', jest.fn());
      popups.prepareForNewPopup(type);
      const selected = popups.createMapPopup(
        type,
        'place',
        'Selected view'
      ).popup;
      container.appendChild(selected);
      popups.registerActivePopup(type, 'Selected view', jest.fn());
      tracker.stopPolling();
      expect(document.getElementById('map-popup')).toBe(selected);
      expect(document.body.textContent).not.toContain('Old bus');
      popups.dismissPopup();
    }
  );

  test('mixed providers retain fresh buses and explain partial tracking with one health request', async () => {
    const health = healthy();
    health.vehiclePositions.healthy = false;
    getHealth.mockResolvedValue(health);
    getVehicles.mockImplementation(async (routeId) => ({
      vehicles: [vehicle(routeId, routeId)]
    }));
    tracker.startMultiRoutePolling(['61C', 'CMU-1', 'CMU-1']);
    await tick();
    expect(getHealth).toHaveBeenCalledTimes(1);
    expect(getVehicles).toHaveBeenCalledTimes(2);
    expect(addMarker).toHaveBeenCalledTimes(1);
    expect(addMarker).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Bus CMU-1' })
    );
    expect(status().dataset.state).toBe('partial');
  });

  test('multi-route results are rendered together and failures remove only unavailable routes', async () => {
    const pending = deferredVehicles();
    getVehicles
      .mockResolvedValueOnce({ vehicles: [vehicle('first')] })
      .mockReturnValueOnce(pending.promise);
    tracker.startMultiRoutePolling(['61C', '71A']);
    await tick();
    expect(addMarker).not.toHaveBeenCalled();
    pending.resolve({ vehicles: [vehicle('second', '71A')] });
    await tick();
    expect(addMarker).toHaveBeenCalledTimes(2);
    getVehicles
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ vehicles: [vehicle('second', '71A')] });
    await tick(30_000);
    expect(tracker.getVehiclePositions()).toHaveLength(1);
    expect(status().dataset.state).toBe('partial');
  });

  test('slow requests have a deadline, cannot overlap, and cannot render after timeout', async () => {
    const pending = deferredVehicles();
    getVehicles.mockReturnValueOnce(pending.promise);
    tracker.startPolling('61C');
    const signal = getVehicles.mock.calls[0][2]!;
    await tick(14_999);
    expect(getVehicles).toHaveBeenCalledTimes(1);
    await tick(1);
    expect(signal.aborted).toBe(true);
    expect(status().dataset.state).toBe('unavailable');
    pending.resolve({ vehicles: [vehicle('too-late')] });
    await tick(29_999);
    expect(addMarker).not.toHaveBeenCalled();
    expect(getVehicles).toHaveBeenCalledTimes(1);
    await tick(1);
    expect(getVehicles).toHaveBeenCalledTimes(2);
  });

  test('hiding the tab aborts work, clears vehicles and makes no background requests; resuming refreshes immediately', async () => {
    getVehicles.mockResolvedValueOnce({ vehicles: [vehicle('visible')] });
    tracker.startPolling('61C');
    await tick();
    const pending = deferredVehicles();
    getVehicles.mockReturnValueOnce(pending.promise);
    await tick(30_000);
    const signal = getVehicles.mock.calls[1][2]!;
    hidden(true);
    expect(signal.aborted).toBe(true);
    expect(tracker.getVehiclePositions()).toEqual([]);
    pending.resolve({ vehicles: [vehicle('hidden')] });
    await tick(120_000);
    expect(getVehicles).toHaveBeenCalledTimes(2);
    expect(jest.getTimerCount()).toBe(0);
    hidden(false);
    await tick();
    expect(getVehicles).toHaveBeenCalledTimes(3);
    expect(getVehicles.mock.calls[2][0]).toBe('61C');
    expect(status().dataset.state).toBe('empty');
  });

  test('pagehide and pageshow preserve selected routes but stop prevents a later resume', async () => {
    tracker.startMultiRoutePolling(['61C', '71A']);
    await tick();
    window.dispatchEvent(new Event('pagehide'));
    await tick(60_000);
    expect(getVehicles).toHaveBeenCalledTimes(2);
    window.dispatchEvent(new Event('pageshow'));
    await tick();
    expect(getVehicles).toHaveBeenCalledTimes(4);
    hidden(true);
    tracker.stopPolling();
    hidden(false);
    await tick();
    expect(getVehicles).toHaveBeenCalledTimes(4);
    expect(status().hidden).toBe(true);
  });

  test.each(['stop', 'restart', 'multi', 'account'])(
    'a pending response cannot repopulate an obsolete %s session',
    async (action) => {
      const pending = deferredVehicles();
      getVehicles.mockReturnValueOnce(pending.promise);
      tracker.startPolling('61C');
      if (action === 'stop') tracker.stopPolling();
      if (action === 'restart') tracker.startPolling('61C');
      if (action === 'multi') tracker.startMultiRoutePolling(['71A']);
      if (action === 'account') localStorage.setItem('token', 'new-session');
      pending.resolve({ vehicles: [vehicle('obsolete')] });
      await tick();
      expect(addMarker).not.toHaveBeenCalled();
      expect(tracker.getVehiclePositions()).toEqual([]);
      if (action === 'stop' || action === 'account') {
        expect(status().hidden).toBe(true);
        expect(jest.getTimerCount()).toBe(0);
      }
    }
  );

  test('a multi-route response from an earlier restart cannot replace fresh markers', async () => {
    const pending = deferredVehicles();
    getVehicles
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValueOnce({ vehicles: [vehicle('current')] });
    tracker.startMultiRoutePolling(['61C']);
    tracker.startMultiRoutePolling(['61C']);
    await tick();
    pending.resolve({ vehicles: [vehicle('obsolete')] });
    await tick();
    expect(addMarker).toHaveBeenCalledTimes(1);
    expect(addMarker).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Bus current' })
    );
  });
});

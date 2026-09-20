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
import { showToast } from '../../client/scripts/utils/toast';
import { focusNearby } from '../../client/scripts/utils/map-focus';
import type { VehicleMotionEstimate } from '../../client/scripts/services/vehicle-motion';

const mockEstimates = new Map<string, VehicleMotionEstimate>();
const mockMotion = {
  setRouteGeometry: jest.fn(),
  ingest: jest.fn(),
  pause: jest.fn((vid: string, position: { lat: number; lng: number }) => {
    const current = mockEstimates.get(vid);
    if (current)
      mockEstimates.set(vid, { ...current, position, moving: false });
  }),
  remove: jest.fn(),
  clear: jest.fn(),
  estimate: jest.fn((vid: string) => mockEstimates.get(vid) ?? null),
  hasActiveMotion: jest.fn(() => mockEstimates.size > 0)
};
jest.mock('../../client/scripts/services/vehicle-motion', () => ({
  VehicleMotionEstimator: jest.fn(() => mockMotion)
}));
jest.mock('../../client/scripts/utils/map-focus', () => ({
  focusNearby: jest.fn()
}));

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
  ...jest.requireActual('../../client/scripts/utils/map-popup'),
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
  const frames = new Map<number, FrameRequestCallback>();
  let frameId = 0;
  let motionChanged: () => void = () => undefined;
  const media = {
    matches: false,
    addEventListener: jest.fn((_event: string, callback: () => void) => {
      motionChanged = callback;
    })
  };
  const runFrame = (timestamp: number) => {
    const callbacks = [...frames.values()];
    frames.clear();
    callbacks.forEach((callback) => callback(timestamp));
  };
  const estimate = (
    bus: IVehicle,
    lat: number,
    estimated = true
  ): VehicleMotionEstimate => ({
    position: { lat, lng: bus.lon },
    rawPosition: { lat: bus.lat, lng: bus.lon },
    heading: 180,
    estimated,
    moving: true,
    confidence: 0.8,
    sourceTimestamp: Date.parse(bus.lastUpdate),
    ageMs: 10_000,
    freshness: 'fresh'
  });
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
    mockEstimates.clear();
    frames.clear();
    media.matches = false;
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: () => media
    });
    jest
      .spyOn(window, 'requestAnimationFrame')
      .mockImplementation((callback) => {
        frames.set(++frameId, callback);
        return frameId;
      });
    jest.spyOn(window, 'cancelAnimationFrame').mockImplementation((id) => {
      frames.delete(id);
    });
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
      setTitle: jest.fn(),
      onClick: jest.fn(),
      remove: jest.fn()
    }));
    tracker = VehicleTracker.getInstance();
    tracker.setAdminProximityBypass(false);
    tracker.updateUserLocation(null);
    tracker.initialize({
      getZoom: () => 14,
      onZoomChanged: jest.fn(),
      addMarker
    } as unknown as IMapProvider);
    window.dispatchEvent(new Event('pageshow'));
  });
  afterEach(() => {
    tracker.stopPolling();
    expect(frames.size).toBe(0);
    expect(jest.getTimerCount()).toBe(0);
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  test.each([false, true])(
    'an open bus popup cannot report with cleared GPS (admin bypass: %s)',
    async (isAdmin) => {
      const report = jest.fn();
      document.addEventListener('busReport', report);
      try {
        tracker.setAdminProximityBypass(isAdmin);
        tracker.updateUserLocation({ lat: 40.44, lng: -79.94 });
        getVehicles.mockResolvedValue({ vehicles: [vehicle('reportable')] });
        tracker.startPolling('61C');
        await tick();
        const marker = addMarker.mock.results[0].value;
        jest.mocked(marker.onClick).mock.calls[0][0]();
        const reportButton = document.querySelector<HTMLButtonElement>(
          '.map-popup__action-btn--report'
        )!;
        reportButton.click();
        expect(report).toHaveBeenCalledTimes(1);

        tracker.updateUserLocation(null);
        reportButton.click();
        expect(report).toHaveBeenCalledTimes(1);
        expect(showToast).toHaveBeenCalledWith(
          expect.stringContaining('Location access is required')
        );

        tracker.updateUserLocation({ lat: 40.4401, lng: -79.94 });
        reportButton.click();
        expect(report).toHaveBeenCalledTimes(2);
        expect((report.mock.calls[1][0] as CustomEvent).detail.lat).toBe(
          40.4401
        );
      } finally {
        document.removeEventListener('busReport', report);
      }
    }
  );

  test('fresh live buses render with accessible persistent status', async () => {
    getVehicles.mockResolvedValue({ vehicles: [vehicle('fresh')] });
    tracker.startPolling('61C');
    expect(status().dataset.state).toBe('loading');
    await tick();
    expect(addMarker).toHaveBeenCalledTimes(1);
    expect(status().dataset.state).toBe('live');
    expect(status().querySelector('[role="status"]')).not.toBeNull();
    expect(
      status().querySelector('[role="status"]')?.getAttribute('aria-live')
    ).toBe('polite');
    expect(mockSetActiveVehicles).toHaveBeenLastCalledWith([vehicle('fresh')]);
    expect(frames.size).toBe(0);
    const rawUpdates = mockSetActiveVehicles.mock.calls.length;
    await tick(1000);
    expect(mockSetActiveVehicles).toHaveBeenCalledTimes(rawUpdates);
  });

  test('one shared frame loop moves the existing markers while raw reports remain untouched', async () => {
    const buses = [vehicle('a'), vehicle('b')];
    buses.forEach((bus) => mockEstimates.set(bus.vid, estimate(bus, 40.441)));
    getVehicles.mockResolvedValue({ vehicles: buses });
    tracker.startPolling('61C');
    await tick();
    expect(frames.size).toBe(1);
    expect(addMarker).toHaveBeenCalledTimes(2);
    buses.forEach((bus) => mockEstimates.set(bus.vid, estimate(bus, 40.442)));
    runFrame(34);
    expect(frames.size).toBe(1);
    expect(tracker.getVehiclePositions()).toEqual(
      buses.map(() => ({ lat: 40.442, lng: -79.94 }))
    );
    expect(mockSetActiveVehicles).toHaveBeenLastCalledWith(buses);
    addMarker.mock.results.forEach(({ value: marker }) => {
      expect(marker.animatePosition).not.toHaveBeenCalled();
      expect(marker.setTitle).toHaveBeenLastCalledWith(
        expect.stringContaining('Estimated position')
      );
    });
    expect(addMarker).toHaveBeenCalledTimes(2);
  });

  test('correction coordinates are displayed even when not labelled as a forecast', async () => {
    const bus = vehicle('correcting');
    mockEstimates.set(bus.vid, estimate(bus, 40.441, false));
    getVehicles.mockResolvedValue({ vehicles: [bus] });
    tracker.startPolling('61C');
    await tick();
    expect(tracker.getVehiclePositions()).toEqual([
      { lat: 40.441, lng: -79.94 }
    ]);
  });

  test('the frame loop stops at a frozen estimate and resumes after a new moving report', async () => {
    const bus = vehicle('bounded');
    mockEstimates.set(bus.vid, estimate(bus, 40.441));
    getVehicles.mockResolvedValue({ vehicles: [bus] });
    tracker.startPolling('61C');
    await tick();
    mockEstimates.set(bus.vid, { ...estimate(bus, 40.442), moving: false });
    runFrame(34);
    expect(frames.size).toBe(0);
    expect(tracker.getVehiclePositions()).toEqual([
      { lat: 40.442, lng: bus.lon }
    ]);
    mockEstimates.set(bus.vid, estimate(bus, 40.443));
    await tick(10_000);
    expect(frames.size).toBe(1);
  });

  test('successive GPS reports slide one existing marker through correction to its new position', async () => {
    const first = vehicle('same-bus');
    mockEstimates.set(first.vid, estimate(first, 40.441));
    getVehicles.mockResolvedValueOnce({ vehicles: [first] });
    tracker.startPolling('61C');
    await tick();
    const marker = addMarker.mock.results[0].value;
    const second = {
      ...first,
      lat: 40.442,
      lastUpdate: new Date(Date.now() + 10_000).toISOString()
    };
    mockEstimates.set(first.vid, estimate(second, 40.4415, false));
    getVehicles.mockResolvedValueOnce({ vehicles: [second] });
    await tick(10_000);
    expect(marker.setPosition).toHaveBeenLastCalledWith({
      lat: 40.4415,
      lng: first.lon
    });
    mockEstimates.set(first.vid, estimate(second, second.lat, false));
    runFrame(10_034);
    expect(marker.setPosition).toHaveBeenLastCalledWith({
      lat: second.lat,
      lng: first.lon
    });
    expect(addMarker).toHaveBeenCalledTimes(1);
    expect(marker.remove).not.toHaveBeenCalled();
    expect(mockSetActiveVehicles).toHaveBeenLastCalledWith([second]);
  });

  test('bus focus uses the displayed position after its popup is attached', async () => {
    const bus = vehicle('focused');
    mockEstimates.set(bus.vid, estimate(bus, 40.441));
    getVehicles.mockResolvedValue({ vehicles: [bus] });
    jest.mocked(focusNearby).mockImplementation(() => {
      expect(document.querySelector('.bus-position-state')?.textContent).toBe(
        'Estimated · GPS 0s ago'
      );
    });
    tracker.startPolling('61C');
    await tick();
    jest.mocked(addMarker.mock.results[0].value.onClick).mock.calls[0][0]();
    expect(focusNearby).toHaveBeenCalledWith(expect.anything(), {
      lat: 40.441,
      lng: -79.94
    });
    jest.mocked(focusNearby).mockReset();
  });

  test('a predicted location never grants report proximity', async () => {
    const bus = vehicle('far');
    mockEstimates.set(bus.vid, estimate(bus, 40.46));
    getVehicles.mockResolvedValue({ vehicles: [bus] });
    tracker.updateUserLocation({ lat: 40.46, lng: -79.94 });
    tracker.startPolling('61C');
    await tick();
    jest.mocked(addMarker.mock.results[0].value.onClick).mock.calls[0][0]();
    document
      .querySelector<HTMLButtonElement>('.map-popup__action-btn--report')!
      .click();
    expect(showToast).toHaveBeenCalledWith(
      'You need to be near this bus to submit a report.'
    );
  });

  test('bus cards keep GPS details collapsed and preserve disclosure across updates', async () => {
    const bus = {
      ...vehicle('concise'),
      speed: 5,
      currentStopId: '123',
      currentStatus: 'IN_TRANSIT_TO' as const
    };
    mockEstimates.set(bus.vid, estimate(bus, 40.441));
    getVehicles.mockResolvedValue({ vehicles: [bus] });
    tracker.startPolling('61C');
    await tick();
    jest.mocked(addMarker.mock.results[0].value.onClick).mock.calls[0][0]();

    const details =
      document.querySelector<HTMLDetailsElement>('.bus-popup__more')!;
    expect(details.open).toBe(false);
    expect(document.querySelector('.bus-position-state')?.textContent).toBe(
      'Estimated · GPS 0s ago'
    );
    expect(document.querySelector('.bus-popup__next-stop')?.textContent).toBe(
      'Next stop #123'
    );
    expect(details.querySelector('.bus-reported-speed')?.textContent).toBe(
      '11.2 mph'
    );
    expect(details.textContent).toContain('PRT live GPS');
    expect(
      details.querySelector('.bus-position-explanation')?.textContent
    ).toContain('estimated along the route');
    expect(
      document.querySelector('.map-popup__action-btn--check')?.textContent
    ).toContain('Alerts');

    details.querySelector('summary')!.click();
    await tick(1000);
    expect(details.open).toBe(true);
    expect(document.querySelector('.bus-position-state')?.textContent).toBe(
      'Estimated · GPS 1s ago'
    );
    expect(details.querySelector('.map-popup__updated-time')?.textContent).toBe(
      '1s ago'
    );
    details.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(details.open).toBe(false);
    expect(document.activeElement).toBe(details.querySelector('summary'));
  });

  test('bus cards omit missing stop details from their compact view', async () => {
    getVehicles.mockResolvedValue({ vehicles: [vehicle('unknown-stop')] });
    tracker.startPolling('61C');
    await tick();
    jest.mocked(addMarker.mock.results[0].value.onClick).mock.calls[0][0]();
    expect(
      document.querySelector<HTMLElement>('.bus-popup__next-stop')?.hidden
    ).toBe(true);
    expect(document.querySelector('.bus-reported-stop')?.textContent).toBe(
      'Not reported'
    );
  });

  test('reduced motion immediately returns to raw position and cancels the frame loop', async () => {
    const bus = vehicle('quiet');
    mockEstimates.set(bus.vid, estimate(bus, 40.441));
    getVehicles.mockResolvedValue({ vehicles: [bus] });
    tracker.startPolling('61C');
    await tick();
    const obsolete = [...frames.values()][0];
    media.matches = true;
    motionChanged();
    expect(frames.size).toBe(0);
    expect(tracker.getVehiclePositions()).toEqual([
      { lat: 40.44, lng: -79.94 }
    ]);
    obsolete(34);
    expect(frames.size).toBe(0);
    media.matches = false;
    motionChanged();
    expect(frames.size).toBe(1);
  });

  test('an old frame cannot revive after route cleanup or replace the new loop', async () => {
    const bus = vehicle('old');
    mockEstimates.set(bus.vid, estimate(bus, 40.441));
    getVehicles.mockResolvedValue({ vehicles: [bus] });
    tracker.startPolling('61C');
    await tick();
    const obsolete = [...frames.values()][0];
    tracker.startPolling('71A');
    await tick();
    expect(frames.size).toBe(1);
    obsolete(34);
    expect(frames.size).toBe(1);
    tracker.stopPolling();
    obsolete(68);
    expect(frames.size).toBe(0);
    expect(mockMotion.remove).toHaveBeenCalledTimes(0);
    expect(mockMotion.clear).toHaveBeenCalled();
  });

  test('unavailable health freezes prediction and disables stale reports even for administrators', async () => {
    const bus = vehicle('outage');
    mockEstimates.set(bus.vid, estimate(bus, 40.441));
    getVehicles.mockResolvedValue({ vehicles: [bus] });
    tracker.setAdminProximityBypass(true);
    tracker.updateUserLocation({ lat: bus.lat, lng: bus.lon });
    tracker.startPolling('61C');
    await tick();
    jest.mocked(addMarker.mock.results[0].value.onClick).mock.calls[0][0]();
    getHealth.mockResolvedValue(null);
    await tick(10_000);
    expect(frames.size).toBe(0);
    expect(tracker.getVehiclePositions()).toEqual([
      { lat: 40.441, lng: bus.lon }
    ]);
    const button = document.querySelector<HTMLButtonElement>(
      '.map-popup__action-btn--report'
    )!;
    expect(button.disabled).toBe(true);
    button.dispatchEvent(new Event('click'));
    expect(showToast).toHaveBeenCalledWith(
      'Wait for a fresh bus location before submitting a report.'
    );
    expect(document.querySelector('.bus-position-state')?.textContent).toBe(
      'Delayed · GPS 10s ago'
    );
  });

  test('successful healthy empty results remove a retained bus immediately', async () => {
    getVehicles.mockResolvedValueOnce({ vehicles: [vehicle('gone')] });
    tracker.startPolling('61C');
    await tick();
    await tick(10_000);
    expect(addMarker.mock.results[0].value.remove).toHaveBeenCalledTimes(1);
    expect(status().dataset.state).toBe('empty');
    expect(mockMotion.remove).toHaveBeenCalledWith('gone');
  });

  test('missing timestamps are honest, non-reportable and expire despite repeated payloads', async () => {
    const bus = { ...vehicle('unknown'), lastUpdate: '' };
    getVehicles.mockResolvedValue({ vehicles: [bus] });
    tracker.startPolling('61C');
    await tick();
    const marker = addMarker.mock.results[0].value;
    jest.mocked(marker.onClick).mock.calls[0][0]();
    expect(document.querySelector('.bus-position-state')?.textContent).toBe(
      'Delayed · GPS age unknown'
    );
    expect(
      document.querySelector<HTMLButtonElement>(
        '.map-popup__action-btn--report'
      )?.disabled
    ).toBe(true);
    expect(mockMotion.estimate).not.toHaveBeenCalled();
    jest.setSystemTime(Date.now() + 899_000);
    await tick(1000);
    expect(marker.remove).toHaveBeenCalledTimes(1);
    await tick(20_000);
    expect(addMarker).toHaveBeenCalledTimes(1);
    expect(tracker.getVehiclePositions()).toEqual([]);
    expect(status().dataset.state).toBe('delayed');
  });

  test('older and duplicate measurement coordinates cannot move a bus backward', async () => {
    const bus = vehicle('ordered');
    getVehicles.mockResolvedValueOnce({ vehicles: [bus] });
    tracker.startPolling('61C');
    await tick();
    getVehicles.mockResolvedValueOnce({
      vehicles: [{ ...bus, lat: 40.46, speed: 0, currentStatus: 'STOPPED_AT' }]
    });
    await tick(10_000);
    expect(mockSetActiveVehicles).toHaveBeenLastCalledWith([
      expect.objectContaining({
        lat: bus.lat,
        speed: 0,
        currentStatus: 'STOPPED_AT'
      })
    ]);
    getVehicles.mockResolvedValueOnce({
      vehicles: [
        {
          ...bus,
          lat: 40.43,
          lastUpdate: new Date(Date.now() - 1_000_000).toISOString()
        }
      ]
    });
    await tick(10_000);
    expect(tracker.getVehiclePositions()).toEqual([
      { lat: bus.lat, lng: bus.lon }
    ]);
    expect(addMarker.mock.results[0].value.remove).not.toHaveBeenCalled();
  });

  test('an invalid future timestamp never turns into a fresh fix merely as the clock catches up', async () => {
    const bus = {
      ...vehicle('future'),
      lastUpdate: new Date(Date.now() + 31_000).toISOString()
    };
    getVehicles.mockResolvedValue({ vehicles: [bus] });
    tracker.startPolling('61C');
    await tick();
    await tick(32_000);
    jest.mocked(addMarker.mock.results[0].value.onClick).mock.calls[0][0]();
    expect(status().dataset.state).toBe('delayed');
    expect(
      document.querySelector('.map-popup__updated-time')?.textContent
    ).toBe('Update time unavailable');
    expect(mockMotion.estimate).not.toHaveBeenCalled();
  });

  test('geometry is forwarded without inventing or copying live positions', () => {
    const patterns = [
      { direction: 'OUTBOUND', path: [{ lat: 40.44, lng: -79.94 }] }
    ];
    tracker.setRouteGeometry('61C', patterns, []);
    expect(mockMotion.setRouteGeometry).toHaveBeenCalledWith(
      '61C',
      patterns,
      []
    );
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
    'retains labelled previous markers when %s becomes unavailable',
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
      expect(marker.remove).not.toHaveBeenCalled();
      expect(tracker.getVehiclePositions()).toEqual([
        { lat: 40.44, lng: -79.94 }
      ]);
      expect(mockSetActiveVehicles.mock.lastCall?.[0]).toHaveLength(1);
      expect(marker.setTitle).toHaveBeenLastCalledWith(
        expect.stringContaining('Delayed position')
      );
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
      expect(addMarker).toHaveBeenCalledTimes(
        ['scheduled', 'coordinates'].includes(kind) ? 0 : 1
      );
      expect(status().dataset.state).toBe('delayed');
      expect(status().textContent).not.toContain('No active');
    }
  );

  test('aging turns a live marker delayed before retaining it for at most fifteen minutes', async () => {
    getVehicles.mockResolvedValue({
      vehicles: [vehicle('aging', '61C', 80_000)]
    });
    tracker.startPolling('61C');
    await tick();
    const marker = addMarker.mock.results[0].value;
    await tick(10_000);
    expect(getVehicles).toHaveBeenCalledTimes(2);
    expect(marker.remove).not.toHaveBeenCalled();
    expect(status().dataset.state).toBe('delayed');
    jest.setSystemTime(Date.now() + 809_000);
    await tick(1000);
    expect(marker.remove).toHaveBeenCalledTimes(1);
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
    expect(addMarker).toHaveBeenCalledTimes(2);
    expect(addMarker).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Bus CMU-1' })
    );
    expect(status().dataset.state).toBe('partial');
  });

  test('multi-route results retain a delayed bus for a failed route alongside a healthy route', async () => {
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
    await tick(10_000);
    expect(tracker.getVehiclePositions()).toHaveLength(2);
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
    await tick(9_999);
    expect(addMarker).not.toHaveBeenCalled();
    expect(getVehicles).toHaveBeenCalledTimes(1);
    await tick(1);
    expect(getVehicles).toHaveBeenCalledTimes(2);
  });

  test('hiding the tab aborts work, retains raw positions and makes no background requests; resuming refreshes immediately', async () => {
    getVehicles.mockResolvedValueOnce({ vehicles: [vehicle('visible')] });
    tracker.startPolling('61C');
    await tick();
    const pending = deferredVehicles();
    getVehicles.mockReturnValueOnce(pending.promise);
    await tick(10_000);
    const signal = getVehicles.mock.calls[1][2]!;
    hidden(true);
    expect(signal.aborted).toBe(true);
    expect(tracker.getVehiclePositions()).toEqual([
      { lat: 40.44, lng: -79.94 }
    ]);
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

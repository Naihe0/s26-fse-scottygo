/** @jest-environment jsdom */

import { VehicleTracker } from '../../client/scripts/trackers/vehicle-tracker';
import { transitApiService } from '../../client/scripts/services/transit-api.service';
import type { IMapMarker, IMapProvider } from '../../common/map.interface';
import type { IVehicle } from '../../common/transit.interface';

const rawVehicles = jest.fn();
jest.mock('../../client/scripts/state/map-state', () => ({
  MapStateManager: {
    getInstance: () => ({
      getState: () => ({
        selectedDirections: { inbound: true, outbound: true }
      }),
      setActiveVehicles: (vehicles: IVehicle[]) => rawVehicles(vehicles)
    })
  }
}));
jest.mock('../../client/scripts/services/transit-api.service', () => ({
  transitApiService: { getVehicles: jest.fn(), getHealth: jest.fn() }
}));
jest.mock('../../client/scripts/utils/bus-icon', () => ({
  createBusIcon: () => ({
    url: 'test-bus-icon',
    anchor: { x: 0, y: 0 },
    size: { width: 20, height: 20 }
  })
}));
jest.mock('../../client/scripts/utils/map-focus', () => ({
  focusNearby: jest.fn()
}));

describe('route motion through the real vehicle tracker', () => {
  let tracker: VehicleTracker;
  let addMarker: jest.Mock;
  let bus: IVehicle;
  const healthy = {
    gtfs: { ready: true },
    memory: {},
    vehiclePositions: { healthy: true, consecutiveFailures: 0, error: null },
    tripUpdates: { healthy: true, consecutiveFailures: 0, error: null },
    tripshotLiveStatus: { healthy: true, consecutiveFailures: 0, error: null },
    trueTimeColors: { available: true },
    overall: true
  };

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-09-20T12:00:00Z'));
    jest.clearAllMocks();
    // The shared one-second tracker timer exercises the real estimator here;
    // frame scheduling and cancellation are covered by vehicle-tracker.test.ts.
    jest.spyOn(window, 'requestAnimationFrame').mockReturnValue(1);
    jest
      .spyOn(window, 'cancelAnimationFrame')
      .mockImplementation(() => undefined);
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    document.body.innerHTML = '<div class="map-container"></div>';
    Object.defineProperty(document, 'hidden', {
      configurable: true,
      value: false
    });
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: () => ({ matches: false, addEventListener: jest.fn() })
    });
    localStorage.setItem('token', 'local-motion-test');
    bus = {
      vid: 'moving-delayed',
      routeId: '61C',
      tripId: 'trip',
      shapeId: 'north',
      direction: 'OUTBOUND',
      lat: 40.44,
      lon: -79.94,
      heading: 0,
      speed: 6.7,
      source: 'live',
      isDetoured: false,
      lastUpdate: new Date(Date.now() - 85_000).toISOString()
    };
    jest.mocked(transitApiService.getHealth).mockResolvedValue(healthy);
    jest.mocked(transitApiService.getVehicles).mockResolvedValue({
      source: 'live',
      vehicles: [bus]
    });
    addMarker = jest.fn(() => ({
      id: 'single-bus',
      setPosition: jest.fn(),
      animatePosition: jest.fn(),
      setIcon: jest.fn(),
      setTitle: jest.fn(),
      setVisible: jest.fn(),
      onClick: jest.fn(),
      remove: jest.fn()
    }));
    tracker = VehicleTracker.getInstance();
    tracker.initialize({
      getZoom: () => 17,
      onZoomChanged: jest.fn(),
      addMarker
    } as unknown as IMapProvider);
    tracker.setRouteGeometry(
      '61C',
      [
        {
          shapeId: 'north',
          direction: 'OUTBOUND',
          path: [
            { lat: 40.43, lng: -79.94 },
            { lat: 40.45, lng: -79.94 },
            { lat: 40.48, lng: -79.94 }
          ]
        }
      ],
      []
    );
    tracker.startPolling('61C');
  });

  afterEach(() => {
    tracker.stopPolling();
    expect(jest.getTimerCount()).toBe(0);
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  test('an 85-second-old credible fix moves every second across the freshness threshold', async () => {
    await jest.advanceTimersByTimeAsync(0);
    let previous = tracker.getVehiclePositions()[0].lat;
    for (let second = 0; second < 20; second++) {
      await jest.advanceTimersByTimeAsync(1000);
      const current = tracker.getVehiclePositions()[0].lat;
      expect(current).toBeGreaterThan(previous);
      previous = current;
    }
    expect(addMarker).toHaveBeenCalledTimes(1);
    expect(rawVehicles).toHaveBeenLastCalledWith([bus]);
    const marker = addMarker.mock.results[0].value as IMapMarker;
    expect(marker.setTitle).toHaveBeenLastCalledWith(
      expect.stringContaining('Estimated position')
    );
    jest.mocked(marker.onClick).mock.calls[0][0]();
    expect(
      document.querySelector<HTMLButtonElement>(
        '.map-popup__action-btn--report'
      )?.disabled
    ).toBe(true);
  });

  test('duplicate cached replies cannot keep a bus moving indefinitely or reset it backward', async () => {
    await jest.advanceTimersByTimeAsync(0);
    const startingPosition = tracker.getVehiclePositions()[0];
    await jest.advanceTimersByTimeAsync(181_000);
    const stopped = tracker.getVehiclePositions()[0];
    expect(stopped.lat).toBeGreaterThan(startingPosition.lat);
    await jest.advanceTimersByTimeAsync(20_000);
    expect(tracker.getVehiclePositions()[0]).toEqual(stopped);
    expect(addMarker).toHaveBeenCalledTimes(1);
    expect(addMarker.mock.results[0].value.setTitle).toHaveBeenLastCalledWith(
      expect.stringContaining('Delayed position')
    );
    expect(rawVehicles).toHaveBeenLastCalledWith([bus]);
  });

  test('a distinct GPS fix corrects the existing marker and continues its journey', async () => {
    await jest.advanceTimersByTimeAsync(0);
    await jest.advanceTimersByTimeAsync(19_000);
    const updated = {
      ...bus,
      lat: bus.lat + (6.7 * 20) / 111_195,
      lastUpdate: new Date(Date.parse(bus.lastUpdate) + 20_000).toISOString()
    };
    jest.mocked(transitApiService.getVehicles).mockResolvedValue({
      source: 'live',
      vehicles: [updated]
    });
    await jest.advanceTimersByTimeAsync(4000);
    const corrected = tracker.getVehiclePositions()[0];
    await jest.advanceTimersByTimeAsync(1000);
    expect(tracker.getVehiclePositions()[0].lat).toBeGreaterThan(corrected.lat);
    expect(addMarker).toHaveBeenCalledTimes(1);
    expect(rawVehicles).toHaveBeenLastCalledWith([updated]);
  });

  test('a provider outage freezes the displayed point until a distinct recovery fix arrives', async () => {
    await jest.advanceTimersByTimeAsync(10_000);
    jest.mocked(transitApiService.getHealth).mockResolvedValue(null);
    await jest.advanceTimersByTimeAsync(10_000);
    const frozen = tracker.getVehiclePositions()[0];
    expect(frozen.lat).toBeGreaterThan(bus.lat);
    await jest.advanceTimersByTimeAsync(5000);
    expect(tracker.getVehiclePositions()[0]).toEqual(frozen);
    jest.mocked(transitApiService.getHealth).mockResolvedValue(healthy);
    await jest.advanceTimersByTimeAsync(5000);
    // The old cached report is not evidence that the bus has resumed moving.
    expect(tracker.getVehiclePositions()[0]).toEqual(frozen);
    const updated = {
      ...bus,
      lat: bus.lat + (6.7 * 40) / 111_195,
      lastUpdate: new Date(Date.parse(bus.lastUpdate) + 40_000).toISOString()
    };
    jest.mocked(transitApiService.getVehicles).mockResolvedValue({
      source: 'live',
      vehicles: [updated]
    });
    await jest.advanceTimersByTimeAsync(15_000);
    const resumed = tracker.getVehiclePositions()[0];
    await jest.advanceTimersByTimeAsync(1000);
    expect(tracker.getVehiclePositions()[0].lat).toBeGreaterThan(resumed.lat);
    expect(addMarker).toHaveBeenCalledTimes(1);
  });
});

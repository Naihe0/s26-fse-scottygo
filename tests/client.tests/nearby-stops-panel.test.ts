/** @jest-environment jsdom */
import { NearbyStopsPanel } from '../../client/scripts/components/nearby-stops-panel';
import '../../client/scripts/components/nearby-stops-panel';
import { MapStateManager } from '../../client/scripts/state/map-state';
import { transitApiService } from '../../client/scripts/services/transit-api.service';
import type {
  INearbyStop,
  INearbyStopsPayload,
  IPrediction
} from '../../common/transit.interface';

jest.mock('../../client/scripts/services/transit-api.service', () => ({
  transitApiService: {
    getNearbyStops: jest.fn(),
    getPredictionsResult: jest.fn()
  }
}));
const nearby = jest.mocked(transitApiService.getNearbyStops);
const arrivals = jest.mocked(transitApiService.getPredictionsResult);
const state = MapStateManager.getInstance();

async function flush(): Promise<void> {
  for (let i = 0; i < 30; i++) await Promise.resolve();
}
function stop(id: string, distance = 100): INearbyStop {
  return {
    stop: {
      stopId: id,
      stopName: `Stop ${id}`,
      lat: 40.44,
      lon: -79.94,
      routes: ['61C'],
      dtradd: [],
      dtrrem: []
    },
    distanceMeters: distance,
    walkMinutesEstimate: 2,
    routesServingStop: ['61C']
  };
}
function payload(stops: INearbyStop[]): INearbyStopsPayload {
  return {
    center: { lat: 40.44, lon: -79.94 },
    radiusMeters: 667,
    expandedRadiusApplied: false,
    stops
  };
}
function prediction(overrides: Partial<IPrediction> = {}): IPrediction {
  return {
    stopId: 'a',
    routeId: '61C',
    vid: '100',
    predictedArrivalTime: Date.now() + 3 * 60_000,
    minutes: 3,
    isDelayed: false,
    ...overrides
  };
}

describe('Nearby stop discovery and arrival comparisons', () => {
  let panel: NearbyStopsPanel;
  const onSelectStop = jest.fn();
  beforeEach(() => {
    jest.useFakeTimers();
    Object.defineProperty(document, 'hidden', {
      configurable: true,
      value: false
    });
    jest.clearAllMocks();
    state.resetFilters();
    nearby.mockResolvedValue(payload([stop('a')]));
    arrivals.mockResolvedValue([]);
    document.body.innerHTML = '<nearby-stops-panel></nearby-stops-panel>';
    panel = document.querySelector('nearby-stops-panel')!;
    panel.configure({
      getCenter: () => ({ lat: 40.45, lng: -79.95 }),
      getOrigin: () => ({
        position: { lat: 40.44, lng: -79.94 },
        label: 'Your location'
      }),
      onSelectStop
    });
  });
  afterEach(() => {
    document.body.innerHTML = '';
    jest.useRealTimers();
  });
  function click(selector: string): void {
    panel.querySelector<HTMLButtonElement>(selector)!.click();
  }
  async function open(): Promise<void> {
    panel.open();
    await flush();
  }

  test('lists stops nearest first, deduplicates IDs and respects the requested range', async () => {
    nearby.mockResolvedValue(
      payload([
        stop('far', 700),
        stop('b', 600),
        stop('a', 100),
        stop('a', 100)
      ])
    );
    await open();
    expect(
      [...panel.querySelectorAll<HTMLElement>('[data-stop-id]')].map(
        (item) => item.dataset.stopId
      )
    ).toEqual(['a', 'b']);
    expect(panel.textContent).toContain('100 m · ~2 min walk');
    expect(panel.textContent).toContain('600 m · ~9 min walk');
    expect(panel.textContent).toContain('2 stops within about 10 minutes');
    expect(panel.querySelector('.nearby-stops__origin')?.textContent).toBe(
      'Your location'
    );
  });

  test('queries 5, 10 and 15 minute ranges without changing location state', async () => {
    const before = state.getState();
    await open();
    expect(nearby.mock.calls[0][3]?.radiusMeters).toBe(667);
    click('[data-range="5"]');
    await flush();
    expect(nearby.mock.lastCall?.[3]?.radiusMeters).toBe(333);
    click('[data-range="15"]');
    await flush();
    expect(nearby.mock.lastCall?.[3]?.radiusMeters).toBe(1000);
    expect(state.getState().currentLocation).toEqual(before.currentLocation);
    expect(state.getState().plannedLocation).toEqual(before.plannedLocation);
    expect(state.getState().gpsPermissionGranted).toBe(
      before.gpsPermissionGranted
    );
  });

  test('Search this area uses map center and starting point restores the planning origin', async () => {
    await open();
    click('[data-action="area"]');
    await flush();
    expect(nearby.mock.lastCall?.slice(0, 2)).toEqual([40.45, -79.95]);
    expect(panel.querySelector('.nearby-stops__origin')?.textContent).toBe(
      'Current map area'
    );
    click('[data-action="origin"]');
    await flush();
    expect(nearby.mock.lastCall?.slice(0, 2)).toEqual([40.44, -79.94]);
  });

  test('missing or invalid GPS uses a clearly labeled campus area', async () => {
    panel.configure({
      getCenter: () => ({ lat: 0, lng: 0 }),
      getOrigin: () => null,
      onSelectStop
    });
    await open();
    expect(panel.querySelector('.nearby-stops__origin')?.textContent).toBe(
      'CMU Campus · default area'
    );
    expect(nearby.mock.lastCall?.slice(0, 2)).toEqual([40.4433, -79.9436]);
  });

  test('selected-route comparison can be widened without changing map filters', async () => {
    state.updateFilter('selectedRouteId', '61C');
    await open();
    expect(nearby.mock.lastCall?.[3]?.routeId).toBe('61C');
    expect(arrivals.mock.lastCall?.[1]).toBe('61C');
    click('[data-scope="all"]');
    await flush();
    expect(nearby.mock.lastCall?.[3]?.routeId).toBeUndefined();
    expect(state.getState().selectedRouteId).toBe('61C');
    expect(
      panel.querySelector('[data-scope="all"]')?.getAttribute('aria-pressed')
    ).toBe('true');
  });

  test('respects both transit systems and does not query when both are off', async () => {
    await open();
    expect(nearby.mock.lastCall?.[2]).toBe('PRT');
    state.updateFilter('selectedSystems', { prt: false, cmu: true });
    await flush();
    expect(nearby.mock.lastCall?.[2]).toBe('CMU');
    state.updateFilter('selectedSystems', { prt: true, cmu: true });
    await flush();
    expect(nearby.mock.lastCall?.[2]).toBeUndefined();
    const calls = nearby.mock.calls.length;
    state.updateFilter('selectedSystems', { prt: false, cmu: false });
    await flush();
    expect(nearby).toHaveBeenCalledTimes(calls);
    expect(panel.textContent).toContain('Turn on PRT or CMU');
  });

  test('selecting a list item closes discovery and opens the exact stop', async () => {
    await open();
    click('[data-stop-id="a"]');
    await flush();
    expect(onSelectStop).toHaveBeenCalledWith(stop('a').stop);
    expect(panel.querySelector('dialog')?.open).toBe(false);
    expect(
      panel
        .querySelector('.nearby-stops__launch')
        ?.getAttribute('aria-expanded')
    ).toBe('false');
  });

  test('failed discovery has an in-place retry distinct from no nearby stops', async () => {
    nearby.mockResolvedValueOnce(null).mockResolvedValueOnce(payload([]));
    await open();
    expect(panel.textContent).toContain('Nearby stops could not load');
    expect(
      panel.querySelector<HTMLButtonElement>('.nearby-stops__retry')?.hidden
    ).toBe(false);
    click('.nearby-stops__retry');
    await flush();
    expect(panel.textContent).toContain('No stops in this range');
    expect(
      panel.querySelector<HTMLButtonElement>('.nearby-stops__retry')?.hidden
    ).toBe(true);
  });

  test('closing aborts pending discovery and ignores its late result', async () => {
    let resolve!: (value: INearbyStopsPayload) => void;
    nearby.mockReturnValue(
      new Promise((done) => {
        resolve = done;
      })
    );
    panel.open();
    const signal = nearby.mock.lastCall?.[3]?.signal;
    panel.close();
    expect(signal?.aborted).toBe(true);
    resolve(payload([stop('old')]));
    await flush();
    expect(panel.querySelector('[data-stop-id]')).toBeNull();
    expect(arrivals).not.toHaveBeenCalled();
  });

  test('new range wins over a delayed older request', async () => {
    let resolve!: (value: INearbyStopsPayload) => void;
    nearby.mockReturnValueOnce(
      new Promise((done) => {
        resolve = done;
      })
    );
    panel.open();
    const signal = nearby.mock.lastCall?.[3]?.signal;
    click('[data-range="5"]');
    await flush();
    expect(signal?.aborted).toBe(true);
    resolve(payload([stop('old')]));
    await flush();
    expect(panel.querySelector('[data-stop-id="a"]')).not.toBeNull();
    expect(panel.querySelector('[data-stop-id="old"]')).toBeNull();
  });

  test('compares at most five stops with at most three arrival requests in flight', async () => {
    nearby.mockResolvedValue(
      payload(
        ['a', 'b', 'c', 'd', 'e', 'f'].map((id, index) => stop(id, 100 + index))
      )
    );
    const pending: ((value: IPrediction[] | null) => void)[] = [];
    arrivals.mockImplementation(
      () =>
        new Promise((resolve) => {
          pending.push(resolve);
        })
    );
    await open();
    expect(arrivals).toHaveBeenCalledTimes(3);
    pending[0](null);
    await flush();
    expect(arrivals).toHaveBeenCalledTimes(4);
    pending[1]([prediction()]);
    await flush();
    expect(arrivals).toHaveBeenCalledTimes(5);
    pending.slice(2).forEach((resolve) => resolve([]));
    await flush();
    expect(arrivals).toHaveBeenCalledTimes(5);
    expect(
      panel.querySelector('[data-arrival-stop="a"]')?.textContent
    ).toContain('Arrival unavailable');
    expect(
      panel.querySelector('[data-arrival-stop="b"]')?.textContent
    ).toContain('Route 61C · 3 min');
    expect(panel.querySelector('[data-arrival-stop="f"]')?.textContent).toBe(
      'Tap for arrivals'
    );
  });

  test('scheduled and delayed predictions are labeled, expired arrivals are excluded', async () => {
    arrivals.mockResolvedValue([
      prediction({ predictedArrivalTime: Date.now() - 60_000 }),
      prediction({ vid: 'Scheduled', isDelayed: true })
    ]);
    await open();
    expect(panel.querySelector('[data-arrival-stop="a"]')?.textContent).toBe(
      'Route 61C · 3 min · scheduled · delayed'
    );
  });

  test('polls only while open and foreground, aborting predictions when closed', async () => {
    await open();
    jest.advanceTimersByTime(30_000);
    await flush();
    expect(arrivals).toHaveBeenCalledTimes(2);
    Object.defineProperty(document, 'hidden', {
      configurable: true,
      value: true
    });
    document.dispatchEvent(new Event('visibilitychange'));
    jest.advanceTimersByTime(60_000);
    await flush();
    expect(arrivals).toHaveBeenCalledTimes(2);
    Object.defineProperty(document, 'hidden', {
      configurable: true,
      value: false
    });
    document.dispatchEvent(new Event('visibilitychange'));
    await flush();
    expect(arrivals).toHaveBeenCalledTimes(3);
    arrivals.mockReturnValue(new Promise(() => undefined));
    jest.advanceTimersByTime(30_000);
    await flush();
    const signal = arrivals.mock.lastCall?.[2];
    panel.close();
    expect(signal?.aborted).toBe(true);
    jest.advanceTimersByTime(90_000);
    await flush();
    expect(arrivals).toHaveBeenCalledTimes(4);
  });

  test('live vehicle state changes do not restart discovery', async () => {
    await open();
    state.setActiveVehicles([]);
    state.setActiveVehicles([]);
    await flush();
    expect(nearby).toHaveBeenCalledTimes(1);
  });

  test('Escape closes the panel and restores its launcher focus', async () => {
    await open();
    expect(document.activeElement).toBe(
      panel.querySelector('.nearby-stops__close')
    );
    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })
    );
    expect(panel.querySelector('dialog')?.open).toBe(false);
    expect(document.activeElement).toBe(
      panel.querySelector('.nearby-stops__launch')
    );
  });

  test('agency names and planning labels are rendered as text', async () => {
    const unsafe = stop('a');
    unsafe.stop.stopName = '<img src=x onerror=alert(1)>';
    nearby.mockResolvedValue(payload([unsafe]));
    await open();
    expect(panel.querySelector('img')).toBeNull();
    expect(panel.textContent).toContain('<img src=x onerror=alert(1)>');
  });
});

/** @jest-environment jsdom */
import { MapNavigationCoordinator } from '../../client/scripts/state/map-navigation';
import { MapStateManager } from '../../client/scripts/state/map-state';
import { URLSyncManager } from '../../client/scripts/state/url-sync';

const state = MapStateManager.getInstance();
const sync = URLSyncManager.getInstance();
const deferred = <T>() => {
  let resolve!: (result: T) => void;
  const promise = new Promise<T>((reply) => {
    resolve = reply;
  });
  return { promise, resolve };
};
const flush = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
};

describe('map navigation ownership and history', () => {
  let active: boolean;
  let session: number;
  let coordinator: MapNavigationCoordinator;
  let unsubscribe: () => void;
  const rendered = jest.fn();
  const controls = jest.fn();
  const popup = jest.fn().mockResolvedValue(undefined);
  const error = jest.fn();
  const render = jest.fn();

  beforeEach(async () => {
    jest.clearAllMocks();
    state.resetFilters();
    localStorage.setItem('token', 'session');
    history.replaceState(null, '', '/map#/map');
    sync.restoreStateFromURL();
    active = false;
    session = 0;
    render.mockReset().mockImplementation(async (current: () => boolean) => {
      if (current()) rendered(state.getState().selectedRouteId);
      return true;
    });
    coordinator = new MapNavigationCoordinator({
      getState: () => state.getState(),
      updateFilters: (filters) => state.updateFilters(filters),
      resetFilters: () => state.resetFilters(),
      writeURL: (mode) => sync.updateURL(state.getState(), mode),
      synchronizeControls: () => controls(state.getState()),
      invalidateRendering: jest.fn(),
      directionsActive: () => active,
      directionsSession: () => session,
      render: (guard) => render(guard),
      showRouteInfo: popup,
      onError: error
    });
    unsubscribe = sync.onRestore(() => {
      void coordinator.restore();
    });
    await coordinator.start();
    jest.clearAllMocks();
  });
  afterEach(() => {
    coordinator.stop();
    unsubscribe();
  });

  test('committed selections make history entries and browser navigation restores controls and rendering once', async () => {
    const initialLength = history.length;
    await coordinator.commit({ selectedRouteId: '61A' });
    await coordinator.commit({
      selectedRouteId: '61B',
      selectedDirections: { inbound: false, outbound: true }
    });
    expect(history.length).toBe(initialLength + 2);
    // Browser traversal emits both popstate and hashchange for a hash entry.
    history.replaceState(null, '', '#/map?r=61A');
    window.dispatchEvent(new PopStateEvent('popstate'));
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    await flush();
    expect(rendered.mock.calls.map(([route]) => route)).toEqual([
      '61A',
      '61B',
      '61A'
    ]);
    expect(controls).toHaveBeenLastCalledWith(
      expect.objectContaining({
        selectedRouteId: '61A',
        selectedDirections: { inbound: true, outbound: true }
      })
    );
    expect(history.length).toBe(initialLength + 2);
  });

  test('an older render cannot complete a newer route selection or open its popup', async () => {
    const old = deferred<boolean>();
    let oldGuard!: () => boolean;
    render.mockImplementationOnce((guard: () => boolean) => {
      oldGuard = guard;
      return old.promise;
    });
    const first = coordinator.commit({ selectedRouteId: '61A' }, true);
    await coordinator.commit({ selectedRouteId: '61B' }, true);
    expect(oldGuard()).toBe(false);
    old.resolve(true);
    await first;
    expect(popup).toHaveBeenCalledTimes(1);
    expect(popup).toHaveBeenCalledWith('61B', expect.any(Function));
    expect(window.location.hash).toBe('#/map?r=61B');
    expect(error).not.toHaveBeenCalled();
  });

  test('clear resets every filter, preserves private planned location, and revokes earlier work', async () => {
    state.setPlannedLocation({ lat: 40.4, lng: -79.9 }, 'My local place');
    const old = deferred<boolean>();
    let oldGuard!: () => boolean;
    render.mockImplementationOnce((guard: () => boolean) => {
      oldGuard = guard;
      return old.promise;
    });
    const first = coordinator.commit({
      selectedRouteId: 'CMU-A',
      selectedSystems: { prt: false, cmu: true },
      selectedDate: new Date(),
      selectedTime: { hour: 8, minute: 0, period: 'AM' },
      selectedDirections: { inbound: false, outbound: false }
    });
    await coordinator.clear();
    expect(oldGuard()).toBe(false);
    old.resolve(true);
    await first;
    expect(state.getState()).toMatchObject({
      selectedRouteId: null,
      selectedDate: null,
      selectedTime: null,
      selectedSystems: { prt: true, cmu: false },
      selectedDirections: { inbound: true, outbound: true },
      plannedLocationLabel: 'My local place'
    });
    expect(window.location.hash).toBe('#/map');
    expect(rendered).toHaveBeenLastCalledWith(null);
  });

  test('history updates desired filters during directions and renders them only on exit', async () => {
    active = true;
    session++;
    history.replaceState(null, '', '#/map?r=71A&s=PRT%2CCMU');
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    await flush();
    expect(render).not.toHaveBeenCalled();
    expect(controls).toHaveBeenCalledWith(
      expect.objectContaining({ selectedRouteId: '71A' })
    );
    active = false;
    session++;
    await coordinator.restore();
    expect(rendered).toHaveBeenCalledWith('71A');
  });

  test.each(['directions', 'stop', 'account', 'page exit'] as const)(
    'late work is discarded after %s changes ownership',
    async (kind) => {
      const pending = deferred<boolean>();
      let guard!: () => boolean;
      render.mockImplementationOnce((current: () => boolean) => {
        guard = current;
        return pending.promise;
      });
      const request = coordinator.commit({ selectedRouteId: '61A' }, true);
      if (kind === 'directions') session += 2;
      if (kind === 'stop') coordinator.cancel();
      if (kind === 'account') localStorage.setItem('token', 'other');
      if (kind === 'page exit') coordinator.stop();
      expect(guard()).toBe(false);
      pending.resolve(false);
      await request;
      expect(popup).not.toHaveBeenCalled();
      expect(error).not.toHaveBeenCalled();
    }
  );

  test('a stalled foreground request releases ownership at its deadline and allows a fresh navigation', async () => {
    jest.useFakeTimers();
    const pending = deferred<boolean>();
    let guard!: () => boolean;
    render.mockImplementationOnce((current: () => boolean) => {
      guard = current;
      return pending.promise;
    });
    const request = coordinator.commit({ selectedRouteId: '61A' }, true);
    await jest.advanceTimersByTimeAsync(30000);
    await request;
    expect(guard()).toBe(false);
    expect(error).toHaveBeenCalledTimes(1);
    await coordinator.commit({ selectedRouteId: '61B' }, true);
    pending.resolve(true);
    await flush();
    expect(popup).toHaveBeenCalledTimes(1);
    expect(popup).toHaveBeenCalledWith('61B', expect.any(Function));
    expect(jest.getTimerCount()).toBe(0);
    jest.useRealTimers();
  });
});

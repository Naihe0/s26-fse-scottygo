/** @jest-environment jsdom */
import {
  clearRecentShortcuts,
  getRiderShortcuts,
  isStopSaved,
  recordRecentRoute,
  recordRecentStop,
  removeShortcut,
  renameShortcut,
  saveFilterView,
  savePlace,
  subscribeRiderShortcuts,
  toggleSavedStop,
  ShortcutFilters
} from '../../client/scripts/utils/rider-shortcuts';

const stop = {
  stopId: '123',
  stopName: 'Forbes & Morewood',
  lat: 40.44,
  lon: -79.94,
  routes: ['61C']
};
const filters: ShortcutFilters = {
  selectedRouteId: '61C',
  selectedSystems: { prt: true, cmu: false },
  selectedDirections: { inbound: true, outbound: false }
};
let account = 0;
const key = () =>
  `scottygo:rider-shortcuts:v2:${encodeURIComponent(`user:${JSON.parse(atob(localStorage.getItem('token')!.split('.')[1])).userId}`)}`;
function signIn(username: string, userId = username): void {
  localStorage.setItem('username', username);
  localStorage.setItem(
    'token',
    `header.${btoa(JSON.stringify({ userId }))}.signature`
  );
}

describe('browser-local account-scoped rider shortcuts', () => {
  beforeEach(() => {
    localStorage.clear();
    signIn(`shortcuts-${++account}`);
  });
  afterEach(() => jest.restoreAllMocks());

  test('toggles a saved stop and stores only validated public fields', () => {
    expect(
      toggleSavedStop({ ...stop, secret: 'not stored' } as typeof stop).saved
    ).toBe(true);
    expect(isStopSaved('123')).toBe(true);
    expect(getRiderShortcuts().stops).toEqual([stop]);
    expect(localStorage.getItem(key())).not.toContain('secret');
    expect(toggleSavedStop(stop).saved).toBe(false);
    expect(getRiderShortcuts().stops).toEqual([]);
  });

  test('enforces caps without silently deleting a rider saved item', () => {
    for (let i = 0; i < 20; i++)
      expect(toggleSavedStop({ ...stop, stopId: `${i}` }).ok).toBe(true);
    expect(toggleSavedStop({ ...stop, stopId: 'extra' }).ok).toBe(false);
    for (let i = 0; i < 8; i++) {
      expect(savePlace(`Place ${i}`, { lat: 40, lng: -80 }).ok).toBe(true);
      expect(saveFilterView(`View ${i}`, filters).ok).toBe(true);
    }
    expect(savePlace('Extra', { lat: 40, lng: -80 }).ok).toBe(false);
    expect(saveFilterView('Extra', filters).ok).toBe(false);
    expect(getRiderShortcuts().stops).toHaveLength(20);
    expect(getRiderShortcuts().places).toHaveLength(8);
    expect(getRiderShortcuts().views).toHaveLength(8);
  });

  test('switching accounts and signing out isolate shortcuts', () => {
    const first = localStorage.getItem('username')!;
    toggleSavedStop(stop);
    signIn(`${first}-other`);
    expect(getRiderShortcuts().stops).toEqual([]);
    savePlace('Work', { lat: 40, lng: -80 });
    localStorage.removeItem('username');
    localStorage.removeItem('token');
    expect(getRiderShortcuts().places).toEqual([]);
    signIn(first);
    expect(getRiderShortcuts().stops).toEqual([stop]);
    expect(getRiderShortcuts().places).toEqual([]);
  });

  test('username renames retain account data and a replacement account cannot reclaim it', () => {
    signIn('alice', 'account-a');
    savePlace('Home', { lat: 40, lng: -80 });
    localStorage.setItem('username', 'alice-renamed');
    expect(getRiderShortcuts().places[0].name).toBe('Home');
    signIn('alice', 'account-b');
    expect(getRiderShortcuts().places).toEqual([]);
    signIn('alice-renamed', 'account-a');
    expect(getRiderShortcuts().places[0].name).toBe('Home');
  });

  test('never reads or migrates username-scoped prototype data', () => {
    signIn('legacy', 'new-owner');
    localStorage.setItem(
      'scottygo:rider-shortcuts:v1:user%3Alegacy',
      JSON.stringify({
        places: [{ id: 'old', name: 'Private home', lat: 40, lng: -80 }]
      })
    );
    expect(getRiderShortcuts().places).toEqual([]);
    expect(localStorage.getItem(key())).toBeNull();
  });

  test('unrecognized session tokens stay temporary and separate', () => {
    localStorage.setItem('token', 'opaque-a');
    savePlace('Temporary', { lat: 40, lng: -80 });
    expect(getRiderShortcuts().places[0].name).toBe('Temporary');
    expect(
      [...Array(localStorage.length)]
        .map((_, index) => localStorage.key(index))
        .filter((item) => item?.startsWith('scottygo:rider-shortcuts'))
    ).toEqual([]);
    localStorage.setItem('token', 'opaque-b');
    expect(getRiderShortcuts().places).toEqual([]);
  });

  test('keeps changes in memory if storage quota or browser policy blocks writes', () => {
    const write = jest
      .spyOn(Storage.prototype, 'setItem')
      .mockImplementation(() => {
        throw new DOMException('Quota exceeded');
      });
    expect(toggleSavedStop(stop).ok).toBe(true);
    expect(savePlace('Home', { lat: 40, lng: -80 }).ok).toBe(true);
    expect(getRiderShortcuts().stops).toEqual([stop]);
    expect(getRiderShortcuts().places[0].name).toBe('Home');
    write.mockRestore();
    renameShortcut('place', getRiderShortcuts().places[0].id, 'Campus');
    expect(JSON.parse(localStorage.getItem(key())!).places[0].name).toBe(
      'Campus'
    );
  });

  test('survives denied reads after a successful write', () => {
    toggleSavedStop(stop);
    jest.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('Blocked');
    });
    expect(getRiderShortcuts().stops).toEqual([stop]);
  });

  test('corrupt payloads and invalid persisted items are safely discarded', () => {
    toggleSavedStop(stop);
    localStorage.setItem(key(), '{ broken');
    expect(getRiderShortcuts().stops).toEqual([]);
    localStorage.setItem(
      key(),
      JSON.stringify({
        stops: [
          null,
          stop,
          stop,
          { ...stop, stopId: 'bad id' },
          { ...stop, stopId: 'new', lat: 91 }
        ],
        places: [{ id: 'p', name: 'Home', lat: 40, lng: -80, token: 'secret' }],
        views: [{ id: 'v', name: 'Invalid', filters: {} }]
      })
    );
    const data = getRiderShortcuts();
    expect(data.stops).toEqual([stop]);
    expect(data.places[0]).not.toHaveProperty('token');
    expect(data.views).toEqual([]);
  });

  test('preset capture excludes GPS, authentication and schedule fields', () => {
    saveFilterView('Morning', {
      ...filters,
      currentLocation: { lat: 1, lng: 2 },
      token: 'secret',
      selectedDate: new Date()
    } as ShortcutFilters);
    expect(getRiderShortcuts().views[0].filters).toEqual(filters);
    const persisted = localStorage.getItem(key())!;
    expect(persisted).not.toMatch(/currentLocation|token|selectedDate|secret/);
  });

  test('recent routes and stops are deduplicated, ordered by latest visit, and bounded', () => {
    for (let i = 0; i < 10; i++) recordRecentRoute(`${i}`);
    recordRecentStop(stop);
    recordRecentRoute('9', 'Nine');
    const recent = getRiderShortcuts().recent;
    expect(recent).toHaveLength(8);
    expect(recent[0]).toEqual({
      id: 'route:9',
      kind: 'route',
      routeId: '9',
      label: 'Nine'
    });
    expect(recent[1].id).toBe('stop:123');
    expect(recent.filter((item) => item.id === 'route:9')).toHaveLength(1);
    removeShortcut('recent', 'route:9');
    expect(getRiderShortcuts().recent).toHaveLength(7);
    clearRecentShortcuts();
    expect(getRiderShortcuts().recent).toEqual([]);
  });

  test('renames and removes places and saved views', () => {
    savePlace('Home', { lat: 40, lng: -80 }, 'Forbes Avenue');
    saveFilterView('Morning', filters);
    const place = getRiderShortcuts().places[0];
    const view = getRiderShortcuts().views[0];
    expect(renameShortcut('place', place.id, 'Campus').ok).toBe(true);
    expect(renameShortcut('view', view.id, 'Evening').ok).toBe(true);
    expect(renameShortcut('view', view.id, '  ').ok).toBe(false);
    expect(getRiderShortcuts().places[0].name).toBe('Campus');
    expect(getRiderShortcuts().views[0].name).toBe('Evening');
    removeShortcut('place', place.id);
    removeShortcut('view', view.id);
    expect(getRiderShortcuts().places).toEqual([]);
    expect(getRiderShortcuts().views).toEqual([]);
  });

  test('invalid new items are rejected without mutating existing shortcuts', () => {
    expect(toggleSavedStop({ ...stop, stopId: '../bad' }).ok).toBe(false);
    expect(savePlace('Home', { lat: Number.NaN, lng: 0 }).ok).toBe(false);
    expect(savePlace(' ', { lat: 40, lng: -80 }).ok).toBe(false);
    recordRecentRoute('<script>');
    expect(getRiderShortcuts()).toEqual({
      stops: [],
      places: [],
      views: [],
      recent: []
    });
  });

  test('returned snapshots cannot mutate the stored shortcuts', () => {
    toggleSavedStop(stop);
    const first = getRiderShortcuts();
    first.stops[0].routes.push('P1');
    first.stops[0].stopName = 'Changed';
    expect(getRiderShortcuts().stops).toEqual([stop]);
  });

  test('subscribers receive current-account updates and can unsubscribe', () => {
    const listener = jest.fn();
    const unsubscribe = subscribeRiderShortcuts(listener);
    toggleSavedStop(stop);
    expect(listener).toHaveBeenCalledTimes(1);
    window.dispatchEvent(new StorageEvent('storage', { key: 'unrelated' }));
    expect(listener).toHaveBeenCalledTimes(1);
    window.dispatchEvent(new StorageEvent('storage', { key: key() }));
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
    removeShortcut('stop', stop.stopId);
    expect(listener).toHaveBeenCalledTimes(2);
  });
});

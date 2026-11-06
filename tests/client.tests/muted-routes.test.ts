/** @jest-environment jsdom */
type Store = typeof import('../../client/scripts/utils/muted-routes');
let store: Store;
const base = Date.UTC(2026, 10, 6);
const key = (id: string) => 'scottygo:route-popups:v2:' + encodeURIComponent('user:' + id);
const token = (id: string, signature = 'signature') => `header.${btoa(JSON.stringify({ userId: id }))}.${signature}`;
const stops: Array<() => void> = [];
function login(id: string): void { localStorage.setItem('token', token(id)); }
function listen() {
  const callback = jest.fn();
  stops.push(store.subscribeRoutePopupPreferences(callback));
  return callback;
}

beforeEach(async () => {
  jest.resetModules();
  jest.useFakeTimers().setSystemTime(base);
  localStorage.clear();
  login('alice');
  Object.defineProperty(document, 'hidden', { configurable: true, value: false });
  store = await import('../../client/scripts/utils/muted-routes');
});
afterEach(() => {
  stops.splice(0).forEach(stop => stop());
  jest.restoreAllMocks();
  jest.useRealTimers();
});

test('mute belongs to the immutable account across logout, username change and token renewal; legacy owner is never guessed', () => {
  localStorage.setItem('scottygo_muted_routes', '["61c"]');
  expect(store.isRouteMuted('61C')).toBe(false);
  store.setRouteMuted(' 61C ', true);
  localStorage.setItem('username', 'renamed');
  localStorage.setItem('token', token('alice', 'renewed'));
  expect(store.isRouteMuted('61c')).toBe(true);
  login('bob');
  expect(store.isRouteMuted('61c')).toBe(false);
  store.setRouteMuted('71D', true);
  localStorage.removeItem('token');
  expect(store.isRouteMuted('71D')).toBe(false);
  login('alice');
  expect(store.isRouteMuted('61c')).toBe(true);
  expect(store.isRouteMuted('71d')).toBe(false);
  expect(localStorage.getItem('scottygo_muted_routes')).toBe('["61c"]');
});

test('a temporary pause expires and notifies exactly once without a new network event', () => {
  const changed = listen();
  store.setRoutePopupPreference('61c', { mode: 'paused', resumeAt: base + 3_600_000 });
  expect(store.getRoutePopupPreference('61C')).toEqual({ mode: 'paused', resumeAt: base + 3_600_000 });
  changed.mockClear();
  jest.advanceTimersByTime(3_599_999);
  expect(store.isRouteMuted('61c')).toBe(true);
  expect(changed).not.toHaveBeenCalled();
  jest.advanceTimersByTime(1);
  expect(store.isRouteMuted('61c')).toBe(false);
  expect(changed.mock.calls).toEqual([['preferences']]);
  expect(jest.getTimerCount()).toBe(0);
});

test('explicit resume cancels the pause timer; multiple paused routes use the next expiry', () => {
  listen();
  store.setRoutePopupPreference('61c', { mode: 'paused', resumeAt: base + 1000 });
  store.setRoutePopupPreference('71d', { mode: 'paused', resumeAt: base + 2000 });
  expect(jest.getTimerCount()).toBe(1);
  store.setRouteMuted('61c', false);
  jest.advanceTimersByTime(1000);
  expect(store.isRouteMuted('71d')).toBe(true);
  jest.advanceTimersByTime(1000);
  expect(store.isRouteMuted('71d')).toBe(false);
});

test('storage updates synchronize this account only and a replaced token is a session event', () => {
  const changed = listen();
  localStorage.setItem(key('alice'), JSON.stringify([['61c', { mode: 'muted' }]]));
  window.dispatchEvent(new StorageEvent('storage', { key: key('alice') }));
  expect(store.isRouteMuted('61c')).toBe(true);
  expect(changed.mock.calls).toEqual([['preferences']]);
  window.dispatchEvent(new StorageEvent('storage', { key: key('bob') }));
  expect(changed).toHaveBeenCalledTimes(1);
  login('bob');
  window.dispatchEvent(new StorageEvent('storage', { key: 'token' }));
  expect(changed).toHaveBeenLastCalledWith('session');
  expect(store.isRouteMuted('61c')).toBe(false);
});

test('hidden pages stop expiry work and foreground recovery recomputes the elapsed pause', () => {
  const changed = listen();
  store.setRoutePopupPreference('61c', { mode: 'paused', resumeAt: base + 1000 });
  Object.defineProperty(document, 'hidden', { configurable: true, value: true });
  document.dispatchEvent(new Event('visibilitychange'));
  expect(jest.getTimerCount()).toBe(0);
  changed.mockClear();
  jest.advanceTimersByTime(5000);
  expect(changed).not.toHaveBeenCalled();
  Object.defineProperty(document, 'hidden', { configurable: true, value: false });
  document.dispatchEvent(new Event('visibilitychange'));
  expect(store.getRoutePopupPreference('61c')).toEqual({ mode: 'enabled' });
  expect(changed).toHaveBeenLastCalledWith('preferences');
});

test('blocked storage preserves page choices and keeps separate accounts isolated', () => {
  const realSet = Storage.prototype.setItem;
  jest.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, name, value) {
    if (name.startsWith('scottygo:route-popups:')) throw new Error('Quota');
    realSet.call(this, name, value);
  });
  store.setRouteMuted('61c', true);
  expect(store.isRouteMuted('61c')).toBe(true);
  login('bob');
  expect(store.isRouteMuted('61c')).toBe(false);
  login('alice');
  expect(store.isRouteMuted('61c')).toBe(true);
  store.setRouteMuted('61c', false);
  expect(store.isRouteMuted('61c')).toBe(false);
});

test('opaque or missing sessions keep no persisted preferences and never share another temporary token’s choices', () => {
  localStorage.setItem('token', 'opaque-a');
  store.setRouteMuted('61c', true);
  localStorage.setItem('token', 'opaque-b');
  expect(store.isRouteMuted('61c')).toBe(false);
  localStorage.setItem('token', 'opaque-a');
  expect(store.isRouteMuted('61c')).toBe(true);
  localStorage.removeItem('token');
  expect(store.isRouteMuted('61c')).toBe(false);
  expect(Object.keys(localStorage).filter(k => k.startsWith('scottygo:route-popups:'))).toEqual([]);
});

test('corrupt preferences, expired pauses and invalid routes cannot create indefinite unwanted pauses', () => {
  localStorage.setItem(key('alice'), JSON.stringify([
    ['61c', { mode: 'paused', resumeAt: base - 1 }],
    ['71d', { mode: 'paused', resumeAt: base + 1e12 }],
    ['ok', { mode: 'muted' }],
    ['<script>', { mode: 'muted' }],
    null
  ]));
  expect(store.isRouteMuted('61c')).toBe(false);
  expect(store.isRouteMuted('71d')).toBe(false);
  expect(store.isRouteMuted('ok')).toBe(true);
  expect(store.isRouteMuted('<script>')).toBe(false);
  store.setRoutePopupPreference('61c', { mode: 'paused', resumeAt: NaN });
  expect(store.isRouteMuted('61c')).toBe(false);
  localStorage.setItem(key('alice'), 'broken');
  expect(() => store.isRouteMuted('61c')).not.toThrow();
});

test('a later write merges another tab’s routes; unsubscribe removes all timer and event work', () => {
  const changed = listen();
  store.setRouteMuted('61c', true);
  localStorage.setItem(key('alice'), JSON.stringify([
    ['61c', { mode: 'muted' }], ['71d', { mode: 'muted' }]
  ]));
  store.setRoutePopupPreference('p1', { mode: 'paused', resumeAt: base + 1000 });
  expect(store.isRouteMuted('71d')).toBe(true);
  stops.splice(0).forEach(stop => stop());
  expect(jest.getTimerCount()).toBe(0);
  changed.mockClear();
  window.dispatchEvent(new StorageEvent('storage', { key: key('alice') }));
  window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
  expect(changed).not.toHaveBeenCalled();
});

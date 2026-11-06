/** @jest-environment jsdom */
interface TestSocket {
  handlers: Map<string, (value?: unknown) => void>;
  emit: jest.Mock;
  disconnect: jest.Mock;
  connect: jest.Mock;
}
const mockSockets: TestSocket[] = [];
jest.mock('socket.io-client', () => ({
  io: () => {
    const connection: TestSocket = {
      handlers: new Map(), emit: jest.fn(), disconnect: jest.fn(), connect: jest.fn()
    };
    mockSockets.push(connection);
    return { ...connection, on: (name: string, callback: (value?: unknown) => void) => connection.handlers.set(name, callback) };
  }
}));
const token = (id: string) => `header.${btoa(JSON.stringify({ userId: id }))}.signature`;
const mutedKey = (id: string) => 'scottygo:route-popups:v2:' + encodeURIComponent('user:' + id);
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
const emitted = (s: TestSocket, event: string, route: string) =>
  s.emit.mock.calls.some(([name, detail]) => name === event && detail.routeId.toLowerCase() === route.toLowerCase());

test('mute, pause expiry and cross-tab resume reconcile actual rooms; removed routes and old-account socket messages stay out', async () => {
  jest.useFakeTimers().setSystemTime(Date.UTC(2026, 10, 6));
  Object.defineProperty(document, 'hidden', { configurable: true, value: false });
  localStorage.clear();
  localStorage.setItem('token', token('alice'));
  let savedRoutes = ['61C'];
  let catalogCalls = 0;
  let releaseCatalog!: (value: unknown) => void;
  const catalog = [{ id: '61C', name: 'McKeesport', system: 'PRT' }, { id: '71D', name: 'Hamilton', system: 'PRT' }];
  const response = (payload: unknown) => ({ ok: true, json: async () => ({ payload }) });
  global.fetch = jest.fn(async (url) => {
    if (String(url) === '/transit/routes') {
      if (++catalogCalls === 1) return new Promise(resolve => { releaseCatalog = resolve; });
      return response(catalog);
    }
    return response((localStorage.getItem('token') === token('bob') ? ['71D'] : savedRoutes).map(routeId => ({ routeId })));
  }) as unknown as typeof fetch;
  const preferences = await import('../../client/scripts/utils/muted-routes');
  preferences.setRouteMuted('61C', true);
  await import('../../client/scripts/components/live-notifications');
  document.dispatchEvent(new Event('DOMContentLoaded'));
  await flush();
  // A quick save while initial catalog loading is pending must retain the other
  // subscriptions, including a currently muted one that may later be resumed.
  savedRoutes.push('71D');
  document.dispatchEvent(new CustomEvent('notifRouteJoin', { detail: { routeId: '71D' } }));
  releaseCatalog(response(catalog));
  await flush();
  const alice = mockSockets[0];
  expect(emitted(alice, 'subscribeRoute', '61C')).toBe(false);
  expect(emitted(alice, 'subscribeRoute', '71D')).toBe(true);

  // A tab initialized while muted must remember its subscription for later resume.
  localStorage.setItem(mutedKey('alice'), '[]');
  window.dispatchEvent(new StorageEvent('storage', { key: mutedKey('alice') }));
  await flush();
  expect(emitted(alice, 'subscribeRoute', '61C')).toBe(true);
  preferences.setRoutePopupPreference('61C', { mode: 'paused', resumeAt: Date.now() + 1000 });
  expect(emitted(alice, 'unsubscribeRoute', '61C')).toBe(true);
  alice.emit.mockClear();
  jest.advanceTimersByTime(1000);
  await flush();
  expect(emitted(alice, 'subscribeRoute', '61C')).toBe(true);

  // An explicit server-side removal must survive a later local preference edit.
  savedRoutes = ['71D'];
  document.dispatchEvent(new CustomEvent('notifRouteLeave', { detail: { routeId: '61C' } }));
  await flush();
  alice.emit.mockClear();
  preferences.setRouteMuted('61C', true);
  preferences.setRouteMuted('61C', false);
  expect(emitted(alice, 'subscribeRoute', '61C')).toBe(false);

  // The bfcache lifecycle releases timers, then resumes the real subscription list.
  preferences.setRoutePopupPreference('61C', { mode: 'paused', resumeAt: Date.now() + 60_000 });
  window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
  expect(jest.getTimerCount()).toBe(0);
  expect(alice.disconnect).toHaveBeenCalled();
  jest.advanceTimersByTime(70_000);
  window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
  await flush();
  const resumed = mockSockets[mockSockets.length - 1];
  resumed.handlers.get('connect')!();
  expect(emitted(resumed, 'subscribeRoute', '71D')).toBe(true);

  // A request completed on the server after the page returned. Reconcile rooms
  // from its authoritative list without reviving the old page's action UI.
  savedRoutes = ['61C'];
  resumed.emit.mockClear();
  document.dispatchEvent(new Event('notifSubscriptionsRefresh'));
  await flush();
  expect(emitted(resumed, 'unsubscribeRoute', '71D')).toBe(true);
  expect(emitted(resumed, 'subscribeRoute', '61C')).toBe(true);

  const received = jest.fn();
  document.addEventListener('scottygo:notification', received);
  localStorage.setItem('token', token('bob'));
  window.dispatchEvent(new StorageEvent('storage', { key: 'token' }));
  await flush();
  const bob = mockSockets[mockSockets.length - 1];
  expect(bob).not.toBe(alice);
  expect(emitted(bob, 'subscribeRoute', '71D')).toBe(true);
  expect(emitted(bob, 'subscribeRoute', '61C')).toBe(false);
  const notice = { routeId: '61C', vid: 'late-old-user', message: 'Old account update', changedFields: [], createdAt: new Date().toISOString() };
  alice.handlers.get('liveNotification')!(notice);
  expect(received).not.toHaveBeenCalled();
  expect(document.querySelector('.live-notif-card')).toBeNull();
  bob.handlers.get('liveNotification')!({ ...notice, routeId: '71D', vid: 'new-user' });
  expect(received).toHaveBeenCalledTimes(1);
  expect(document.querySelector('.live-notif-card')).not.toBeNull();
  window.dispatchEvent(new PageTransitionEvent('pagehide'));
  expect(jest.getTimerCount()).toBe(0);
  document.removeEventListener('scottygo:notification', received);
  jest.useRealTimers();
});

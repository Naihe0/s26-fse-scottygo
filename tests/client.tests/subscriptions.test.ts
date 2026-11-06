/** @jest-environment jsdom */

import { readFileSync } from 'fs';
import { join } from 'path';
jest.mock('../../client/scripts/components/app-header', () => ({}));
jest.mock('../../client/scripts/components/live-notifications', () => ({}));
const mockFetch = jest.fn();
const result = (payload: unknown, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => ({ payload })
});
type SavedRoute = { routeId: string; createdAt: string };
let savedRoutes: SavedRoute[];
let routes: { id: string; name: string; system: 'PRT' | 'CMU' }[];
let pageListeners: Array<[string, EventListenerOrEventListenerObject]>;
let listenSpy: jest.SpyInstance;
async function flush(): Promise<void> {
  for (let i = 0; i < 30; i++) await Promise.resolve();
}
async function boot(): Promise<void> {
  await import('../../client/scripts/subscriptions');
  await flush();
}
function el<T extends HTMLElement = HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}
function openSheet(): HTMLButtonElement {
  el('add-route-btn').click();
  return document.querySelector<HTMLButtonElement>('.result-add-btn')!;
}

const accountToken = (id: string) =>
  `header.${btoa(JSON.stringify({ userId: id }))}.signature`;
const preferenceKey = (id: string) =>
  'scottygo:route-popups:v2:' + encodeURIComponent('user:' + id);
function buttonNamed(text: string): HTMLButtonElement {
  const found = Array.from(document.querySelectorAll('button')).find(
    (button) => button.textContent?.trim() === text && !button.hidden
  );
  if (!found) throw new Error('Missing button: ' + text);
  return found;
}
function popupState(): string {
  return document.querySelector('.card-popup-state')?.textContent || '';
}
function apiError(name: string, message: string, status = 409) {
  return { ok: false, status, json: async () => ({ name, message }) };
}
function cachedPageTransition(type: 'pagehide' | 'pageshow'): void {
  const event = new Event(type);
  Object.defineProperty(event, 'persisted', { value: true });
  window.dispatchEvent(event);
}

describe('saved routes interactions and recovery', () => {
  beforeEach(() => {
    jest.resetModules();
    // Each import represents a separate page. Do not revive prior test pages
    // when a BFCache case dispatches pageshow on this shared JSDOM window.
    pageListeners = [];
    const listen = window.addEventListener.bind(window);
    listenSpy = jest
      .spyOn(window, 'addEventListener')
      .mockImplementation((type, listener, options) => {
        if (type === 'pagehide' || type === 'pageshow')
          pageListeners.push([type, listener]);
        listen(type, listener, options);
      });
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-11-06T12:00:00Z'));
    Object.defineProperty(document, 'hidden', {
      configurable: true,
      value: false
    });
    localStorage.clear();
    localStorage.setItem('token', accountToken('rider-a'));
    global.fetch = mockFetch;
    savedRoutes = [];
    routes = [{ id: '61D', name: 'Murray', system: 'PRT' }];
    mockFetch
      .mockReset()
      .mockImplementation((url: string, options?: RequestInit) => {
        if (options?.method === 'POST') {
          const routeId = JSON.parse(options.body as string).routeId;
          return Promise.resolve(
            result({ routeId, createdAt: new Date().toISOString() }, 201)
          );
        }
        if (options?.method === 'DELETE') return Promise.resolve(result(null));
        return Promise.resolve(
          result(
            url === '/transit/routes'
              ? routes
              : url === '/notifications/subscriptions'
                ? savedRoutes
                : []
          )
        );
      });
    document.body.innerHTML = readFileSync(
      join(__dirname, '../../client/pages/subscriptions.html'),
      'utf8'
    ).match(/<body>([\s\S]*)<\/body>/)![1];
  });
  afterEach(() => {
    window.dispatchEvent(new Event('pagehide'));
    for (const [type, listener] of pageListeners)
      window.removeEventListener(type, listener);
    listenSpy.mockRestore();
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  test('old saved dates reveal an exact Pittsburgh timestamp and retain focus through preference updates', async () => {
    savedRoutes = [{ routeId: '61D', createdAt: '2026-09-19T18:00:00Z' }];
    await boot();
    const date =
      document.querySelector<HTMLButtonElement>('.card-time-toggle')!;
    expect(date.textContent).toBe('Saved Sep 19');
    date.focus();
    date.click();
    expect(
      document.querySelector<HTMLTimeElement>('.card-time-exact')!.hidden
    ).toBe(false);
    expect(document.querySelector('.card-time-exact')!.textContent).toMatch(
      /Sep 19, 2026.*2:00 PM EDT/
    );
    const { setRoutePopupPreference } =
      await import('../../client/scripts/utils/muted-routes');
    setRoutePopupPreference('61D', { mode: 'muted' });
    const restored =
      document.querySelector<HTMLButtonElement>('.card-time-toggle')!;
    expect(restored.getAttribute('aria-expanded')).toBe('true');
    expect(document.activeElement).toBe(restored);
    restored.click();
    expect(
      document.querySelector<HTMLTimeElement>('.card-time-exact')!.hidden
    ).toBe(true);
  });

  test('relative date labels age while visible and refresh after returning from the background', async () => {
    savedRoutes = [{ routeId: '61D', createdAt: new Date().toISOString() }];
    await boot();
    const date =
      document.querySelector<HTMLButtonElement>('.card-time-toggle')!;
    expect(date.textContent).toBe('Saved just now');
    jest.advanceTimersByTime(120000);
    expect(date.textContent).toBe('Saved 2 min ago');
    Object.defineProperty(document, 'hidden', {
      configurable: true,
      value: true
    });
    jest.advanceTimersByTime(3600000);
    expect(date.textContent).toBe('Saved 2 min ago');
    Object.defineProperty(document, 'hidden', {
      configurable: true,
      value: false
    });
    document.dispatchEvent(new Event('visibilitychange'));
    const foregroundDate =
      document.querySelector<HTMLButtonElement>('.card-time-toggle')!;
    expect(foregroundDate.textContent).toBe('Saved 1 hr ago');
    window.dispatchEvent(new Event('pagehide'));
    jest.advanceTimersByTime(3600000);
    expect(foregroundDate.textContent).toBe('Saved 1 hr ago');
  });

  test('an invalid saved date stays unavailable without a broken date disclosure', async () => {
    savedRoutes = [{ routeId: '61D', createdAt: 'invalid' }];
    await boot();
    expect(document.querySelector('.subscription-card')!.textContent).toContain(
      'Date unavailable'
    );
    expect(document.querySelector('.card-time-toggle')).toBeNull();
    expect(document.body.textContent).not.toMatch(/NaN|Invalid Date/);
  });

  test('combines agency and unsaved filters including after a successful save', async () => {
    routes.push(
      { id: 'CMU-1', name: 'Campus Shuttle', system: 'CMU' },
      { id: 'CMU-2', name: 'East Shuttle', system: 'CMU' }
    );
    savedRoutes = [{ routeId: 'cmu-1', createdAt: new Date().toISOString() }];
    await boot();
    openSheet();
    const system = el<HTMLSelectElement>('sheet-system');
    system.value = 'CMU';
    system.dispatchEvent(new Event('change'));
    const unsaved = el<HTMLInputElement>('sheet-unsaved');
    unsaved.click();
    expect(el('sheet-results').querySelectorAll('li')).toHaveLength(1);
    expect(el('sheet-results').textContent).toContain('East Shuttle');
    el('sheet-results').querySelector('button')!.click();
    await flush();
    expect(el('sheet-results').children).toHaveLength(0);
    expect(el('sheet-status').textContent).toContain('No routes match');
    expect(document.querySelectorAll('.subscription-card')).toHaveLength(2);
  });
  test('loading does not present an empty account or allow premature saving', async () => {
    let finish!: (value: ReturnType<typeof result>) => void;
    mockFetch.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    await boot();
    expect(el('subscription-status').textContent).toContain('Loading');
    expect(el<HTMLButtonElement>('add-route-btn').disabled).toBe(true);
    expect(document.getElementById('subscription-empty')).toBeNull();
    finish(result([]));
    await flush();
    expect(el<HTMLButtonElement>('add-route-btn').disabled).toBe(false);
    expect(el('subscription-empty').textContent).toContain('Tap Add route');
  });

  test('the add dialog escapes route names and Escape restores focus', async () => {
    routes = [
      { id: 'CMU-1', name: '<img src=x onerror=alert(1)>', system: 'CMU' }
    ];
    await boot();
    const opener = el('add-route-btn');
    openSheet();
    const sheet = el('bottom-sheet');
    expect(sheet.getAttribute('role')).toBe('dialog');
    expect(sheet.hasAttribute('inert')).toBe(false);
    expect(document.querySelector('img')).toBeNull();
    expect(sheet.textContent).toContain('<img src=x onerror=alert(1)>');
    sheet.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })
    );
    expect(sheet.hasAttribute('inert')).toBe(true);
    expect(document.activeElement).toBe(opener);
  });

  test('saved routes link separately to the live map and their own updates, including the shuttle system', async () => {
    routes.push({ id: 'CMU-7', name: 'Oakland Shuttle', system: 'CMU' });
    savedRoutes = ['61D', 'cmu-7'].map((routeId) => ({
      routeId,
      createdAt: new Date().toISOString()
    }));
    await boot();
    const cards = document.querySelectorAll('.subscription-card');
    expect(
      cards[0].querySelector('.card-route-link')?.getAttribute('href')
    ).toBe('/#/map?r=61D');
    expect(
      cards[1].querySelector('.card-route-link')?.getAttribute('href')
    ).toBe('/#/map?r=CMU-7&s=CMU');
    expect(
      cards[1].querySelector('.card-route-link')?.getAttribute('aria-label')
    ).toContain('Oakland Shuttle');
    expect(
      cards[1].querySelector('.card-updates-link')?.getAttribute('href')
    ).toBe('/notifications?route=CMU-7');
  });

  test('saving updates the same control without losing focus or scroll, and cannot remove a route', async () => {
    await boot();
    const button = openSheet();
    button.focus();
    el('sheet-results').scrollTop = 180;
    const joined = jest.fn();
    document.addEventListener('notifRouteJoin', joined, { once: true });
    let finish!: (value: ReturnType<typeof result>) => void;
    mockFetch.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    button.click();
    button.click();
    expect(button.textContent).toBe('Saving…');
    expect(button.getAttribute('aria-disabled')).toBe('true');
    expect(button.disabled).toBe(false);
    finish(
      result({ routeId: '61D', createdAt: new Date().toISOString() }, 201)
    );
    await flush();
    expect(document.querySelector('.result-add-btn')).toBe(button);
    expect(button.textContent).toBe('✓ Saved');
    expect(button.getAttribute('aria-disabled')).toBe('true');
    expect(document.activeElement).toBe(button);
    expect(el('sheet-results').scrollTop).toBe(180);
    expect(el('route-count').textContent).toBe('1/10');
    expect(el('sheet-feedback').textContent).toBe('Route 61D saved.');
    expect(joined).toHaveBeenCalledTimes(1);
    button.click();
    expect(
      mockFetch.mock.calls.filter(([, options]) => options?.method === 'POST')
    ).toHaveLength(1);
    expect(
      mockFetch.mock.calls.some(([, options]) => options?.method === 'DELETE')
    ).toBe(false);
  });

  test('save failure stays beside the results and can be retried without losing the query', async () => {
    await boot();
    openSheet();
    const input = el<HTMLInputElement>('route-search-input');
    input.value = '61';
    input.dispatchEvent(new Event('input'));
    const button =
      document.querySelector<HTMLButtonElement>('.result-add-btn')!;
    mockFetch.mockRejectedValueOnce(new Error('offline'));
    button.click();
    await flush();
    expect(el('sheet-feedback').textContent).toContain(
      'Could not save this route'
    );
    expect(el('sheet-feedback').classList.contains('is-error')).toBe(true);
    expect(button.disabled).toBe(false);
    expect(input.value).toBe('61');
    button.click();
    await flush();
    expect(button.textContent).toBe('✓ Saved');
    expect(el('sheet-feedback').classList.contains('is-error')).toBe(false);
  });

  test('saved-route load errors offer retry and never claim the account is empty', async () => {
    mockFetch.mockResolvedValueOnce(result(null, 503));
    await boot();
    expect(el('subscription-status').textContent).toContain(
      'could not be loaded'
    );
    expect(document.getElementById('subscription-empty')).toBeNull();
    expect(el<HTMLButtonElement>('add-route-btn').disabled).toBe(true);
    const retry = el('subscriptions-retry');
    expect(retry.hidden).toBe(false);
    savedRoutes = [{ routeId: '61D', createdAt: new Date().toISOString() }];
    retry.focus();
    retry.click();
    await flush();
    expect(retry.hidden).toBe(true);
    expect(el('route-count').textContent).toBe('1/10');
    expect(document.activeElement).toBe(
      document.querySelector('.card-route-link')
    );
  });

  test('route catalog failures retry inside the open sheet and retain the search', async () => {
    mockFetch.mockImplementationOnce(() => Promise.resolve(result([])));
    mockFetch.mockResolvedValueOnce(result(null, 503));
    await boot();
    openSheet();
    expect(el('sheet-status').textContent).toContain('could not be loaded');
    const input = el<HTMLInputElement>('route-search-input');
    input.value = '61D';
    input.dispatchEvent(new Event('input'));
    const retry = el('routes-retry');
    retry.focus();
    retry.click();
    await flush();
    expect(input.value).toBe('61D');
    expect(document.activeElement).toBe(input);
    expect(el('sheet-status').textContent).toContain('1 route');
    expect(retry.hidden).toBe(true);
  });

  test('unmatched searches explain the empty state safely', async () => {
    await boot();
    openSheet();
    const input = el<HTMLInputElement>('route-search-input');
    input.value = '<img src=x>';
    input.dispatchEvent(new Event('input'));
    expect(el('sheet-status').textContent).toContain('No routes match');
    expect(document.querySelector('img')).toBeNull();
    expect(el('routes-retry').hidden).toBe(true);
    input.value = 'Murray';
    input.dispatchEvent(new Event('input'));
    expect(document.querySelectorAll('.sheet-result-item')).toHaveLength(1);
  });

  test('an empty catalog offers refresh instead of a blank dialog', async () => {
    routes = [];
    await boot();
    openSheet();
    expect(el('sheet-status').textContent).toContain('No routes are available');
    expect(el('routes-retry').hidden).toBe(false);
  });

  test.each(['loading', 'no matches'])(
    'the %s sheet cycles focus past hidden retry controls',
    async (state) => {
      let finish: ((value: ReturnType<typeof result>) => void) | undefined;
      if (state === 'loading') {
        mockFetch.mockResolvedValueOnce(result([]));
        mockFetch.mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              finish = resolve;
            })
        );
      }
      await boot();
      openSheet();
      const input = el<HTMLInputElement>('route-search-input');
      if (state === 'no matches') {
        input.value = 'no-such-route';
        input.dispatchEvent(new Event('input'));
      }
      expect(el('routes-retry').hidden).toBe(true);
      const last = el<HTMLInputElement>('sheet-unsaved');
      last.focus();
      last.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Tab',
          bubbles: true,
          cancelable: true
        })
      );
      expect(document.activeElement).toBe(el('sheet-close'));
      el('sheet-close').dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Tab',
          shiftKey: true,
          bubbles: true,
          cancelable: true
        })
      );
      expect(document.activeElement).toBe(last);
      finish?.(result(routes));
      await flush();
    }
  );

  test('saved states normalize IDs and only the saved card can remove a route', async () => {
    routes = [{ id: 'CMU-1', name: 'A Route', system: 'CMU' }];
    savedRoutes = [{ routeId: 'cmu-1', createdAt: new Date().toISOString() }];
    await boot();
    const button = openSheet();
    expect(button.textContent).toBe('✓ Saved');
    button.click();
    expect(mockFetch.mock.calls.some(([, options]) => options?.method)).toBe(
      false
    );
    el('sheet-close').click();
    const remove = document.querySelector<HTMLButtonElement>('.card-remove')!;
    expect(remove.getAttribute('aria-label')).toBe(
      'Remove A Route from saved routes'
    );
    remove.focus();
    remove.click();
    await flush();
    expect(document.querySelector('.subscription-card')).toBeNull();
    expect(document.activeElement).toBe(el('add-route-btn'));
    expect(el('route-count').textContent).toBe('0/10');
  });

  test('a failed removal retains its card and focus for retry', async () => {
    savedRoutes = [{ routeId: '61D', createdAt: new Date().toISOString() }];
    await boot();
    const button = document.querySelector<HTMLButtonElement>('.card-remove')!;
    button.focus();
    mockFetch.mockResolvedValueOnce(result(null, 503));
    button.click();
    await flush();
    expect(document.querySelector('.card-remove')).toBe(button);
    expect(button.disabled).toBe(false);
    expect(document.activeElement).toBe(button);
    expect(el('route-count').textContent).toBe('1/10');
    expect(
      document.querySelector('.toast-notification')!.textContent
    ).toContain('Failed to remove');
  });

  test('reaching the limit explains the next step and closing returns to an available control', async () => {
    savedRoutes = Array.from({ length: 9 }, (_, i) => ({
      routeId: `71${i}`,
      createdAt: new Date().toISOString()
    }));
    routes.push({ id: '61A', name: 'Braddock', system: 'PRT' });
    await boot();
    openSheet().click();
    await flush();
    expect(el('sheet-status').textContent).toContain(
      'Remove a route from your saved list'
    );
    const other =
      document.querySelectorAll<HTMLButtonElement>('.result-add-btn')[1];
    expect(other.getAttribute('aria-disabled')).toBe('true');
    other.click();
    expect(
      mockFetch.mock.calls.filter(([, options]) => options?.method === 'POST')
    ).toHaveLength(1);
    el('sheet-close').click();
    expect(document.activeElement).toBe(
      document.querySelector('.card-route-link')
    );
    expect(el<HTMLButtonElement>('add-route-btn').disabled).toBe(true);
  });

  test('a one-hour popup pause displays its expiry, resumes on time and keeps the saved route', async () => {
    savedRoutes = [{ routeId: '61D', createdAt: new Date().toISOString() }];
    await boot();
    expect(popupState()).toBe('Popups on while open');
    buttonNamed('Pause for 1 hour').click();
    expect(popupState()).toContain('Paused until');
    expect(
      document.querySelector('.card-bell')?.getAttribute('aria-pressed')
    ).toBe('true');
    expect(el('route-count').textContent).toBe('1/10');
    expect(mockFetch.mock.calls.some(([, options]) => options?.method)).toBe(
      false
    );
    jest.advanceTimersByTime(3_599_999);
    expect(popupState()).toContain('Paused until');
    jest.advanceTimersByTime(1);
    await flush();
    expect(popupState()).toBe('Popups on while open');
    expect(
      document.querySelector('.card-bell')?.getAttribute('aria-pressed')
    ).toBe('false');
    expect(el('route-count').textContent).toBe('1/10');
  });

  test('the permanent mute toggle and immediate resume update visible state without removing a route', async () => {
    savedRoutes = [{ routeId: '61D', createdAt: new Date().toISOString() }];
    await boot();
    document.querySelector<HTMLButtonElement>('.card-bell')!.click();
    expect(popupState()).toBe('Popups muted');
    jest.advanceTimersByTime(3_600_000);
    expect(popupState()).toBe('Popups muted');
    buttonNamed('Resume popups now').click();
    expect(popupState()).toBe('Popups on while open');
    expect(mockFetch.mock.calls.some(([, options]) => options?.method)).toBe(
      false
    );
  });

  test('a current-account preference change in another tab refreshes the visible popup state and preserves focus', async () => {
    savedRoutes = [{ routeId: '61D', createdAt: new Date().toISOString() }];
    await boot();
    document.querySelector<HTMLElement>('.card-route-link')!.focus();
    const key = preferenceKey('rider-a');
    const newValue = JSON.stringify([['61d', { mode: 'muted' }]]);
    localStorage.setItem(key, newValue);
    window.dispatchEvent(new StorageEvent('storage', { key, newValue }));
    expect(popupState()).toBe('Popups muted');
    expect(document.activeElement?.classList.contains('card-route-link')).toBe(
      true
    );
    const otherKey = preferenceKey('rider-b');
    localStorage.setItem(otherKey, '[]');
    window.dispatchEvent(
      new StorageEvent('storage', { key: otherKey, newValue: '[]' })
    );
    expect(popupState()).toBe('Popups muted');
  });

  test('undo removal restores the route and its original pause deadline with one guarded server mutation', async () => {
    savedRoutes = [{ routeId: '61D', createdAt: new Date().toISOString() }];
    await boot();
    buttonNamed('Pause for 1 hour').click();
    const captured = localStorage.getItem(preferenceKey('rider-a'));
    document.querySelector<HTMLButtonElement>('.card-remove')!.click();
    await flush();
    expect(el('subscription-undo').hidden).toBe(false);
    expect(el('route-count').textContent).toBe('0/10');
    let finish!: (value: ReturnType<typeof result>) => void;
    mockFetch.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    el('undo-remove-btn').click();
    el('undo-remove-btn').click();
    expect(
      mockFetch.mock.calls.filter(([, options]) => options?.method === 'POST')
    ).toHaveLength(1);
    jest.advanceTimersByTime(60_000);
    finish(
      result({ routeId: '61D', createdAt: new Date().toISOString() }, 201)
    );
    await flush();
    expect(el('route-count').textContent).toBe('1/10');
    expect(popupState()).toContain('Paused until');
    expect(localStorage.getItem(preferenceKey('rider-a'))).toBe(captured);
    expect(el('subscription-undo').hidden).toBe(true);
    expect(document.activeElement?.classList.contains('card-route-link')).toBe(
      true
    );
  });

  test('undo after a pause expires restores the saved route with popups enabled', async () => {
    savedRoutes = [{ routeId: '61D', createdAt: new Date().toISOString() }];
    await boot();
    buttonNamed('Pause for 1 hour').click();
    document.querySelector<HTMLButtonElement>('.card-remove')!.click();
    await flush();
    jest.advanceTimersByTime(3_600_001);
    el('undo-remove-btn').click();
    await flush();
    expect(popupState()).toBe('Popups on while open');
    expect(el('route-count').textContent).toBe('1/10');
  });

  test('failed undo keeps recovery available and retry restores exactly one saved route', async () => {
    savedRoutes = [{ routeId: '61D', createdAt: new Date().toISOString() }];
    await boot();
    document.querySelector<HTMLButtonElement>('.card-remove')!.click();
    await flush();
    mockFetch.mockRejectedValueOnce(new Error('offline'));
    el('undo-remove-btn').click();
    await flush();
    expect(el('subscription-undo').hidden).toBe(false);
    expect(el<HTMLButtonElement>('undo-remove-btn').disabled).toBe(false);
    expect(el('route-count').textContent).toBe('0/10');
    el('undo-remove-btn').click();
    await flush();
    expect(document.querySelectorAll('.subscription-card')).toHaveLength(1);
    expect(el('subscription-undo').hidden).toBe(true);
  });

  test('duplicate undo reconciles the server copy and restores mute only when the route is confirmed', async () => {
    savedRoutes = [{ routeId: '61D', createdAt: new Date().toISOString() }];
    await boot();
    document.querySelector<HTMLButtonElement>('.card-bell')!.click();
    document.querySelector<HTMLButtonElement>('.card-remove')!.click();
    await flush();
    mockFetch.mockResolvedValueOnce(
      apiError('DuplicateSubscription', 'Already subscribed')
    );
    savedRoutes = [{ routeId: '61d', createdAt: new Date().toISOString() }];
    el('undo-remove-btn').click();
    await flush();
    expect(document.querySelectorAll('.subscription-card')).toHaveLength(1);
    expect(popupState()).toBe('Popups muted');
    expect(el('subscription-undo').hidden).toBe(true);
  });

  test('server capacity rejection during undo retains the route count and a retry instead of inventing a saved route', async () => {
    savedRoutes = [{ routeId: '61D', createdAt: new Date().toISOString() }];
    await boot();
    document.querySelector<HTMLButtonElement>('.card-remove')!.click();
    await flush();
    mockFetch.mockResolvedValueOnce(
      apiError(
        'SubscriptionLimitReached',
        '10 routes saved. Remove a route first.'
      )
    );
    el('undo-remove-btn').click();
    await flush();
    expect(document.querySelector('.subscription-card')).toBeNull();
    expect(el('route-count').textContent).toBe('0/10');
    expect(el('subscription-undo').hidden).toBe(false);
    expect(el<HTMLButtonElement>('undo-remove-btn').disabled).toBe(false);
  });

  test('undo cannot exceed ten routes when a different route filled the last slot', async () => {
    savedRoutes = Array.from({ length: 10 }, (_, i) => ({
      routeId: `71${i}`,
      createdAt: new Date().toISOString()
    }));
    await boot();
    document.querySelector<HTMLButtonElement>('.card-remove')!.click();
    await flush();
    openSheet().click();
    await flush();
    el('sheet-close').click();
    expect(el('route-count').textContent).toBe('10/10');
    const before = mockFetch.mock.calls.filter(
      ([, options]) => options?.method === 'POST'
    ).length;
    el('undo-remove-btn').click();
    await flush();
    expect(
      mockFetch.mock.calls.filter(([, options]) => options?.method === 'POST')
    ).toHaveLength(before);
    expect(el('route-count').textContent).toBe('10/10');
    expect(el('subscription-undo').hidden).toBe(false);
  });

  test('an unconfirmed duplicate undo response keeps recovery available without claiming a saved route', async () => {
    savedRoutes = [{ routeId: '61D', createdAt: new Date().toISOString() }];
    await boot();
    document.querySelector<HTMLButtonElement>('.card-remove')!.click();
    await flush();
    savedRoutes = [];
    mockFetch.mockResolvedValueOnce(
      apiError('DuplicateSubscription', 'Already subscribed')
    );
    el('undo-remove-btn').click();
    await flush();
    expect(document.querySelector('.subscription-card')).toBeNull();
    expect(el('subscription-undo').hidden).toBe(false);
    expect(el('route-count').textContent).toBe('0/10');
  });

  test('a later removal replaces the previous undo target', async () => {
    savedRoutes = ['61D', '61A'].map((routeId) => ({
      routeId,
      createdAt: new Date().toISOString()
    }));
    await boot();
    document
      .querySelector<HTMLButtonElement>('[data-route-id="61D"] .card-remove')!
      .click();
    await flush();
    document
      .querySelector<HTMLButtonElement>('[data-route-id="61A"] .card-remove')!
      .click();
    await flush();
    el('undo-remove-btn').click();
    await flush();
    const post = mockFetch.mock.calls.find(
      ([, options]) => options?.method === 'POST'
    );
    expect(JSON.parse(post![1].body)).toEqual({ routeId: '61A' });
    expect(document.querySelectorAll('.subscription-card')).toHaveLength(1);
    expect(
      document
        .querySelector('.subscription-card')
        ?.getAttribute('data-route-id')
    ).toBe('61A');
  });

  test('a stale undo completion after account switch cannot restore the previous rider route or mute preference', async () => {
    savedRoutes = [{ routeId: '61D', createdAt: new Date().toISOString() }];
    await boot();
    document.querySelector<HTMLButtonElement>('.card-bell')!.click();
    document.querySelector<HTMLButtonElement>('.card-remove')!.click();
    await flush();
    let finish!: (value: ReturnType<typeof result>) => void;
    mockFetch.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    el('undo-remove-btn').click();
    localStorage.setItem('token', accountToken('rider-b'));
    window.dispatchEvent(
      new StorageEvent('storage', {
        key: 'token',
        newValue: accountToken('rider-b')
      })
    );
    finish(
      result({ routeId: '61D', createdAt: new Date().toISOString() }, 201)
    );
    await flush();
    expect(document.querySelector('.subscription-card')).toBeNull();
    expect(el('subscription-undo').hidden).toBe(true);
    expect(localStorage.getItem(preferenceKey('rider-b'))).toBeNull();
  });

  test('leaving the page discards undo and its pending completion without changing the next page', async () => {
    savedRoutes = [{ routeId: '61D', createdAt: new Date().toISOString() }];
    await boot();
    document.querySelector<HTMLButtonElement>('.card-remove')!.click();
    await flush();
    let finish!: (value: ReturnType<typeof result>) => void;
    mockFetch.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    el('undo-remove-btn').click();
    window.dispatchEvent(new Event('pagehide'));
    document.body.innerHTML = '<main>Next page</main>';
    finish(
      result({ routeId: '61D', createdAt: new Date().toISOString() }, 201)
    );
    await flush();
    expect(document.body.textContent).toBe('Next page');
  });

  test('returning from the back-forward cache discards previous undo and reloads current routes with usable remove controls', async () => {
    savedRoutes = [{ routeId: '61D', createdAt: new Date().toISOString() }];
    await boot();
    document.querySelector<HTMLButtonElement>('.card-remove')!.click();
    await flush();
    expect(el('subscription-undo').hidden).toBe(false);
    cachedPageTransition('pagehide');
    savedRoutes = [{ routeId: '61A', createdAt: new Date().toISOString() }];
    cachedPageTransition('pageshow');
    await flush();
    expect(el('subscription-undo').hidden).toBe(true);
    const cards = document.querySelectorAll<HTMLElement>('.subscription-card');
    expect(cards).toHaveLength(1);
    expect(cards[0].dataset.routeId).toBe('61A');
    const remove = cards[0].querySelector<HTMLButtonElement>('.card-remove')!;
    expect(remove.disabled).toBe(false);
    remove.click();
    await flush();
    expect(document.querySelector('.subscription-card')).toBeNull();
    expect(el('subscription-undo-label').textContent).toContain('61A');
  });

  test('a late pre-cache removal cannot overwrite the restored list or unlock a new pending removal', async () => {
    savedRoutes = [{ routeId: '61D', createdAt: new Date().toISOString() }];
    await boot();
    let finishOld!: (value: ReturnType<typeof result>) => void;
    mockFetch.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishOld = resolve;
        })
    );
    document.querySelector<HTMLButtonElement>('.card-remove')!.click();
    cachedPageTransition('pagehide');
    savedRoutes = [{ routeId: '61A', createdAt: new Date().toISOString() }];
    cachedPageTransition('pageshow');
    await flush();
    const remove = document.querySelector<HTMLButtonElement>(
      '[data-route-id="61A"] .card-remove'
    )!;
    expect(remove.disabled).toBe(false);
    let finishNew!: (value: ReturnType<typeof result>) => void;
    mockFetch.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishNew = resolve;
        })
    );
    remove.click();
    expect(remove.disabled).toBe(true);
    finishOld(result(null));
    await flush();
    expect(el('subscription-undo').hidden).toBe(true);
    expect(document.querySelectorAll('.subscription-card')).toHaveLength(1);
    expect(
      document.querySelector<HTMLElement>('.subscription-card')?.dataset.routeId
    ).toBe('61A');
    expect(remove.disabled).toBe(true);
    finishNew(result(null));
    await flush();
    expect(document.querySelector('.subscription-card')).toBeNull();
    expect(el('subscription-undo-label').textContent).toContain('61A');
    expect(el('subscription-undo-label').textContent).not.toContain('61D');
    expect(el<HTMLButtonElement>('add-route-btn').disabled).toBe(false);
  });
});

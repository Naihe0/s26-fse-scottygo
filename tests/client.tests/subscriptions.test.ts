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

describe('saved routes interactions and recovery', () => {
  beforeEach(() => {
    jest.resetModules();
    jest.useFakeTimers();
    localStorage.clear();
    localStorage.setItem('token', 'test-token');
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
    jest.clearAllTimers();
    jest.useRealTimers();
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
      input.focus();
      input.dispatchEvent(
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
      expect(document.activeElement).toBe(input);
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
});

/** @jest-environment jsdom */

jest.mock('../../client/scripts/components/app-header', () => ({}));
jest.mock('../../client/scripts/components/live-notifications', () => ({}));
const mockOn = jest.fn();
const mockDisconnect = jest.fn();
const mockConnect = jest.fn();
jest.mock('socket.io-client', () => ({
  io: () => ({ on: mockOn, disconnect: mockDisconnect, connect: mockConnect })
}));
const mockFetch = jest.fn();
const unsafeText = '<img src=x onerror=alert(1)>';
const service = (id = 'one', routeId = '71C') => ({
  id,
  headerText: `Agency ${id}`,
  descriptionText: 'A service notice.',
  routeIds: [routeId],
  activePeriods: []
});
const rider = (id = 'one', routeId = '71C', vid = '123') => ({
  _id: id,
  routeId,
  vid,
  message: `Rider ${id}`,
  changedFields: [],
  createdAt: new Date().toISOString()
});
const result = (payload: unknown) => ({
  ok: true,
  json: async () => ({ payload })
});
async function flush(): Promise<void> {
  for (let i = 0; i < 25; i++) await Promise.resolve();
}
function changeSearch(text: string): void {
  const input = document.getElementById(
    'notif-search-input'
  ) as HTMLInputElement;
  input.value = text;
  input.dispatchEvent(new Event('input'));
}
function choose(view: string): void {
  document
    .querySelector<HTMLButtonElement>(`[data-notif-view="${view}"]`)!
    .click();
}
function pageTransition(type: string, persisted: boolean): void {
  const event = new Event(type);
  Object.defineProperty(event, 'persisted', { value: persisted });
  window.dispatchEvent(event);
}
function useSnapshots(
  services: unknown[] = [service()],
  riders: unknown[] = [rider()],
  subscriptions: unknown[] = []
): void {
  mockFetch.mockImplementation((url: string) =>
    Promise.resolve(
      result(
        url === '/notifications/alerts'
          ? services
          : url === '/notifications/notifications'
            ? riders
            : url === '/notifications/subscriptions'
              ? subscriptions
              : []
      )
    )
  );
}

describe('notification center rendering and refresh ownership', () => {
  beforeEach(() => {
    jest.resetModules();
    jest.useFakeTimers();
    global.fetch = mockFetch;
    mockFetch.mockReset();
    mockOn.mockReset();
    mockDisconnect.mockReset();
    mockConnect.mockReset();
    localStorage.clear();
    localStorage.setItem('token', 'test-token');
    localStorage.setItem('username', 'inbox-user');
    history.replaceState(null, '', '/notifications');
    Object.defineProperty(document, 'hidden', {
      configurable: true,
      value: false
    });
    document.body.innerHTML =
      '<ul id="notif-list"></ul><p id="notif-empty"></p><p id="notif-status"></p><span id="notif-count"></span><input id="notif-search-input"><button id="notif-search-clear"></button><button id="notif-refresh"></button><button data-notif-view="all"></button><button data-notif-view="service"></button><button data-notif-view="live"></button><button id="notif-saved-only"></button><button id="notif-unread-only"></button><select id="notif-sort"><option value="priority">Priority</option><option value="newest">Newest</option></select><select id="notif-group"><option value="flat">Together</option><option value="route">Route</option></select><p id="notif-scope-status"></p><p id="notif-inbox-announcement"></p>';
  });
  afterEach(() => {
    pageTransition('pagehide', false);
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  test('service feed text is displayed literally, without HTML execution', async () => {
    useSnapshots(
      [
        {
          ...service(),
          headerText: unsafeText,
          descriptionText: unsafeText,
          routeIds: [unsafeText]
        }
      ],
      []
    );
    await import('../../client/scripts/notification');
    await flush();
    expect(document.querySelector('img')).toBeNull();
    expect(document.querySelector('.notif-title')!.textContent).toBe(
      unsafeText
    );
    expect(document.querySelector('.notif-body')!.textContent).toBe(unsafeText);
  });

  test('persisted report messages are rendered literally in prefilled live results', async () => {
    history.replaceState(null, '', '/notifications?route=61D&type=live');
    useSnapshots(
      [],
      [{ ...rider('one', '61D', unsafeText), message: unsafeText }]
    );
    await import('../../client/scripts/notification');
    await flush();
    expect(document.querySelector('img')).toBeNull();
    expect(document.querySelector('.notif-body')!.textContent).toBe(unsafeText);
    expect(
      document
        .querySelector('[data-notif-view="live"]')
        ?.getAttribute('aria-pressed')
    ).toBe('true');
  });

  test('explicit views and immediate local search preserve the selected data source', async () => {
    useSnapshots();
    await import('../../client/scripts/notification');
    await flush();
    expect(document.querySelectorAll('.notif-card')).toHaveLength(2);
    const requests = mockFetch.mock.calls.length;
    choose('live');
    expect(document.querySelectorAll('.notif-card')).toHaveLength(1);
    changeSearch('agency');
    expect(document.querySelectorAll('.notif-card')).toHaveLength(0);
    expect(document.getElementById('notif-empty')?.textContent).toContain(
      'No updates match'
    );
    choose('service');
    expect(document.querySelectorAll('.notif-card')).toHaveLength(1);
    expect(mockFetch).toHaveBeenCalledTimes(requests);
  });

  test('an in-flight snapshot uses the current query and clearing it does not queue another search', async () => {
    let finish!: (value: unknown) => void;
    mockFetch.mockImplementation((url: string) =>
      url === '/notifications/notifications'
        ? new Promise((resolve) => {
            finish = resolve;
          })
        : Promise.resolve(result([]))
    );
    await import('../../client/scripts/notification');
    await flush();
    changeSearch('does not match');
    finish(result([rider()]));
    await flush();
    expect(document.querySelectorAll('.notif-card')).toHaveLength(0);
    const requestCount = mockFetch.mock.calls.length;
    document.getElementById('notif-search-clear')!.click();
    await jest.advanceTimersByTimeAsync(300);
    expect(document.querySelectorAll('.notif-card')).toHaveLength(1);
    expect(mockFetch).toHaveBeenCalledTimes(requestCount);
  });

  test('exact route prefill excludes route-number substrings until the rider edits search', async () => {
    history.replaceState(null, '', '/notifications?route=1');
    useSnapshots(
      [service('one', '1'), service('forty-one', '41')],
      [rider('one', '1'), rider('eleven', '11')]
    );
    await import('../../client/scripts/notification');
    await flush();
    expect(document.querySelectorAll('.notif-card')).toHaveLength(2);
    expect(document.getElementById('notif-list')?.textContent).not.toContain(
      'eleven'
    );
    changeSearch('1');
    expect(document.querySelectorAll('.notif-card')).toHaveLength(4);
  });

  test('bus prefill matches the exact bus and excludes unrelated agency notices', async () => {
    history.replaceState(null, '', '/notifications?bus=12');
    useSnapshots(
      [service('12', '12')],
      [rider('bus12', '71C', '12'), rider('bus123', '71C', '123')]
    );
    await import('../../client/scripts/notification');
    await flush();
    expect(document.querySelectorAll('.notif-card')).toHaveLength(1);
    expect(document.querySelector('.notif-subtitle')?.textContent).toBe(
      'Bus #12'
    );
  });

  test('keeps the last successful source snapshot when a refresh partially fails', async () => {
    useSnapshots();
    await import('../../client/scripts/notification');
    await flush();
    mockFetch.mockImplementation((url: string) =>
      url === '/notifications/alerts'
        ? Promise.reject(new Error('offline'))
        : Promise.resolve(result([rider('new')]))
    );
    document.getElementById('notif-refresh')!.click();
    await flush();
    expect(document.getElementById('notif-list')?.textContent).toContain(
      'Agency one'
    );
    expect(document.getElementById('notif-list')?.textContent).toContain(
      'Rider new'
    );
    expect(document.getElementById('notif-status')?.textContent).toContain(
      'Showing the last available updates'
    );
  });

  test('distinguishes unavailable sources from successful empty results', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 503 });
    await import('../../client/scripts/notification');
    await flush();
    expect(document.getElementById('notif-empty')?.textContent).toContain(
      'unavailable'
    );
    useSnapshots([], []);
    document.getElementById('notif-refresh')!.click();
    await flush();
    choose('live');
    expect(document.getElementById('notif-empty')?.textContent).toContain(
      'last 30 minutes'
    );
    expect(
      document.getElementById('notif-status')?.classList.contains('has-error')
    ).toBe(false);
  });

  test.each(['/notifications/alerts', '/notifications/notifications'])(
    'does not claim all sources are empty when %s fails on first load',
    async (failingPath) => {
      mockFetch.mockImplementation((url: string) =>
        Promise.resolve(
          url === failingPath ? { ok: false, status: 503 } : result([])
        )
      );
      await import('../../client/scripts/notification');
      await flush();
      expect(document.getElementById('notif-empty')?.textContent).toBe(
        'No updates in the available results. Some updates could not load. Try Refresh to check all sources.'
      );
      changeSearch('71C');
      expect(document.getElementById('notif-empty')?.textContent).toBe(
        'No updates match “71C” in the available results. Some updates could not load. Try Refresh to check all sources.'
      );
    }
  );

  test('a healthy empty Live view remains specific to rider updates when agency alerts cannot load', async () => {
    history.replaceState(null, '', '/notifications?type=live');
    mockFetch.mockImplementation((url: string) =>
      Promise.resolve(
        url === '/notifications/alerts'
          ? { ok: false, status: 503 }
          : result([])
      )
    );
    await import('../../client/scripts/notification');
    await flush();
    expect(document.getElementById('notif-empty')?.textContent).toBe(
      'No rider updates in the last 30 minutes. Follow routes to receive new reports while using ScottyGo.'
    );
    expect(document.getElementById('notif-status')?.textContent).toContain(
      'Service alerts could not refresh'
    );
  });

  test('a newer socket refresh owns the list even if an older request finishes later', async () => {
    let completeOld!: (value: unknown) => void;
    let alertRequests = 0;
    mockFetch.mockImplementation((url: string) => {
      if (url === '/notifications/alerts' && ++alertRequests === 1)
        return new Promise((resolve) => {
          completeOld = resolve;
        });
      return Promise.resolve(
        result(url === '/notifications/alerts' ? [service('new')] : [])
      );
    });
    await import('../../client/scripts/notification');
    await flush();
    const refresh = mockOn.mock.calls.find(
      ([name]) => name === 'alertUpdate'
    )![1];
    refresh();
    await jest.advanceTimersByTimeAsync(250);
    expect(document.getElementById('notif-list')?.textContent).toContain(
      'Agency new'
    );
    completeOld(result([service('old')]));
    await flush();
    expect(document.getElementById('notif-list')?.textContent).not.toContain(
      'Agency old'
    );
  });

  test('keeps expanded descriptions and focused links during changed snapshots', async () => {
    const long = {
      ...service(),
      descriptionText: 'A long notice. '.repeat(40)
    };
    useSnapshots([long], []);
    await import('../../client/scripts/notification');
    await flush();
    document.querySelector<HTMLDetailsElement>('.notif-details')!.open = true;
    document.querySelector<HTMLAnchorElement>('.notif-route')!.focus();
    useSnapshots([long, service('second')], []);
    const socketRefresh = mockOn.mock.calls.find(
      ([name]) => name === 'alertUpdate'
    )![1];
    socketRefresh();
    await jest.advanceTimersByTimeAsync(250);
    expect(
      document.querySelector<HTMLDetailsElement>('.notif-details')!.open
    ).toBe(true);
    expect(document.activeElement?.className).toBe('notif-route');
  });

  test('refreshes relative times without recreating an unchanged card', async () => {
    const notification = rider();
    useSnapshots([], [notification]);
    await import('../../client/scripts/notification');
    await flush();
    const card = document.querySelector('.notif-card');
    expect(document.querySelector('time')?.textContent).toBe('Just now');
    await jest.advanceTimersByTimeAsync(60_000);
    expect(document.querySelector('.notif-card')).toBe(card);
    expect(document.querySelector('time')?.textContent).toBe('1 min ago');
  });

  test('pauses periodic refresh in hidden tabs and restores after BFCache without duplicate setup', async () => {
    useSnapshots();
    await import('../../client/scripts/notification');
    await flush();
    const count = mockFetch.mock.calls.length;
    Object.defineProperty(document, 'hidden', {
      configurable: true,
      value: true
    });
    await jest.advanceTimersByTimeAsync(60_000);
    expect(mockFetch).toHaveBeenCalledTimes(count);
    pageTransition('pagehide', true);
    expect(mockDisconnect).toHaveBeenCalled();
    Object.defineProperty(document, 'hidden', {
      configurable: true,
      value: false
    });
    pageTransition('pageshow', true);
    await jest.advanceTimersByTimeAsync(250);
    expect(mockFetch).toHaveBeenCalledTimes(count + 3);
    expect(mockConnect).toHaveBeenCalledTimes(1);
  });

  test('returning from BFCache reloads changed saved routes without toggling scope', async () => {
    const services = [service('before', '61C'), service('after', '71C')];
    useSnapshots(services, [], [{ routeId: '61C' }]);
    await import('../../client/scripts/notification');
    await flush();
    document.getElementById('notif-saved-only')!.click();
    await flush();
    expect(document.querySelector('.notif-title')?.textContent).toBe(
      'Agency before'
    );

    pageTransition('pagehide', true);
    useSnapshots(services, [], [{ routeId: '71C' }]);
    pageTransition('pageshow', true);
    await jest.advanceTimersByTimeAsync(250);
    expect(document.querySelectorAll('.notif-card')).toHaveLength(1);
    expect(document.querySelector('.notif-title')?.textContent).toBe(
      'Agency after'
    );
    expect(
      document.getElementById('notif-saved-only')?.getAttribute('aria-pressed')
    ).toBe('true');
  });

  test.each(['token', null])(
    'a changed session (%s storage event) aborts old requests and stops page subscriptions before reload',
    async (key) => {
      const pending = new Map<
        string,
        { complete(value: unknown): void; signal: AbortSignal }
      >();
      mockFetch.mockImplementation((url: string, options: RequestInit) =>
        url.startsWith('/notifications/')
          ? new Promise((complete) => {
              pending.set(url, {
                complete,
                signal: options.signal as AbortSignal
              });
            })
          : Promise.resolve(result([]))
      );
      await import('../../client/scripts/notification');
      await flush();
      const location = Object.getOwnPropertyDescriptor(window, 'location')!;
      const reload = jest.fn();
      Object.defineProperty(window, 'location', {
        configurable: true,
        value: { reload }
      });
      try {
        if (key === null) localStorage.clear();
        else localStorage.setItem('token', 'another-account-token');
        window.dispatchEvent(new StorageEvent('storage', { key }));
        expect(reload).toHaveBeenCalledTimes(1);
        expect(mockDisconnect).toHaveBeenCalledTimes(1);
        expect(pending.size).toBe(3);
        for (const request of pending.values()) {
          expect(request.signal.aborted).toBe(true);
          request.complete(result([service('old-account')]));
        }
        await flush();
        expect(document.querySelectorAll('.notif-card')).toHaveLength(0);

        const requests = mockFetch.mock.calls.length;
        document.getElementById('notif-refresh')!.click();
        document.dispatchEvent(new Event('scottygo:notification'));
        document.dispatchEvent(new Event('visibilitychange'));
        pageTransition('pageshow', true);
        await jest.advanceTimersByTimeAsync(60_000);
        expect(mockFetch).toHaveBeenCalledTimes(requests);
        expect(mockConnect).not.toHaveBeenCalled();
      } finally {
        Object.defineProperty(window, 'location', location);
      }
    }
  );

  test('BFCache restoration detects a changed session even without a storage event', async () => {
    useSnapshots();
    await import('../../client/scripts/notification');
    await flush();
    pageTransition('pagehide', true);
    localStorage.setItem('token', 'another-account-token');
    const location = Object.getOwnPropertyDescriptor(window, 'location')!;
    const reload = jest.fn();
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { reload }
    });
    try {
      const requests = mockFetch.mock.calls.length;
      pageTransition('pageshow', true);
      await jest.advanceTimersByTimeAsync(60_000);
      expect(reload).toHaveBeenCalledTimes(1);
      expect(mockConnect).not.toHaveBeenCalled();
      expect(mockFetch).toHaveBeenCalledTimes(requests);
    } finally {
      Object.defineProperty(window, 'location', location);
    }
  });

  test('renaming the account or receiving an unchanged token does not reload the inbox', async () => {
    useSnapshots();
    await import('../../client/scripts/notification');
    await flush();
    const location = Object.getOwnPropertyDescriptor(window, 'location')!;
    const reload = jest.fn();
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { reload }
    });
    try {
      localStorage.setItem('username', 'renamed-inbox-user');
      window.dispatchEvent(new StorageEvent('storage', { key: 'username' }));
      window.dispatchEvent(new StorageEvent('storage', { key: 'token' }));
      expect(reload).not.toHaveBeenCalled();
      expect(mockDisconnect).not.toHaveBeenCalled();
      expect(document.querySelectorAll('.notif-card')).toHaveLength(2);
    } finally {
      Object.defineProperty(window, 'location', location);
    }
  });

  test('saved-route scope composes with type and text filters', async () => {
    useSnapshots(
      [service('saved', '61C'), service('other', '71C')],
      [rider('saved', '61C'), rider('other', '71C')],
      [{ routeId: '61C' }]
    );
    await import('../../client/scripts/notification');
    await flush();
    document.getElementById('notif-saved-only')!.click();
    await flush();
    expect(document.querySelectorAll('.notif-card')).toHaveLength(2);
    expect(document.getElementById('notif-list')?.textContent).not.toContain(
      'Agency other'
    );
    choose('service');
    changeSearch('saved');
    expect(document.querySelectorAll('.notif-card')).toHaveLength(1);
    expect(document.querySelector('.notif-title')?.textContent).toBe(
      'Agency saved'
    );
    changeSearch('missing');
    expect(document.querySelectorAll('.notif-card')).toHaveLength(0);
  });

  test('saved-route empty and failed states remain distinguishable', async () => {
    useSnapshots();
    await import('../../client/scripts/notification');
    await flush();
    document.getElementById('notif-saved-only')!.click();
    await flush();
    expect(document.getElementById('notif-empty')?.textContent).toContain(
      'Save a route'
    );
    expect(document.querySelector('#notif-empty a')?.getAttribute('href')).toBe(
      '/subscriptions'
    );
    mockFetch.mockImplementation((url: string) =>
      url === '/notifications/subscriptions'
        ? Promise.reject(new Error('offline'))
        : Promise.resolve(result([]))
    );
    document.getElementById('notif-refresh')!.click();
    await flush();
    expect(
      document.getElementById('notif-scope-status')?.textContent
    ).toContain('Saved routes could not refresh');
  });

  test('read action is explicit and an unread list moves keyboard focus to the next update', async () => {
    useSnapshots([service('first'), service('second')], []);
    await import('../../client/scripts/notification');
    await flush();
    expect(document.querySelectorAll('[data-read="false"]')).toHaveLength(2);
    document.getElementById('notif-unread-only')!.click();
    const action = document.querySelector<HTMLButtonElement>(
      '[data-key="alert:first"] [data-action="read"]'
    )!;
    action.focus();
    action.click();
    expect(document.querySelectorAll('.notif-card')).toHaveLength(1);
    expect(
      document.activeElement?.closest<HTMLElement>('[data-key]')?.dataset.key
    ).toBe('alert:second');
    document.getElementById('notif-unread-only')!.click();
    expect(
      document
        .querySelector('[data-key="alert:first"]')
        ?.getAttribute('data-read')
    ).toBe('true');
    expect(document.getElementById('notif-count')?.textContent).toContain(
      '2 updates · 1 unread'
    );
  });

  test('changed alert content becomes unread while unchanged read state survives refresh', async () => {
    useSnapshots([service()], []);
    await import('../../client/scripts/notification');
    await flush();
    document.querySelector<HTMLButtonElement>('[data-action="read"]')!.click();
    document.getElementById('notif-refresh')!.click();
    await flush();
    expect(
      document.querySelector('.notif-card')?.getAttribute('data-read')
    ).toBe('true');
    useSnapshots(
      [{ ...service(), descriptionText: 'A new agency correction.' }],
      []
    );
    document.getElementById('notif-refresh')!.click();
    await flush();
    expect(
      document.querySelector('.notif-card')?.getAttribute('data-read')
    ).toBe('false');
  });

  test('priority and newest order can be switched without another feed request', async () => {
    useSnapshots(
      [
        {
          ...service('severe'),
          severityLevel: 'SEVERE',
          activePeriods: [{ start: '2026-01-01T00:00:00Z', end: '' }]
        },
        {
          ...service('recent'),
          severityLevel: 'INFO',
          activePeriods: [{ start: '2026-10-24T00:00:00Z', end: '' }]
        }
      ],
      []
    );
    await import('../../client/scripts/notification');
    await flush();
    expect(document.querySelector('.notif-title')?.textContent).toBe(
      'Agency severe'
    );
    const before = mockFetch.mock.calls.length;
    const sort = document.getElementById('notif-sort') as HTMLSelectElement;
    sort.value = 'newest';
    sort.dispatchEvent(new Event('change'));
    expect(document.querySelector('.notif-title')?.textContent).toBe(
      'Agency recent'
    );
    expect(mockFetch).toHaveBeenCalledTimes(before);
  });

  test('route grouping keeps shared notices and global counts unique', async () => {
    const shared = { ...service('shared', '61C'), routeIds: ['61C', '71C'] };
    useSnapshots(
      [shared, shared, service('single', '61C')],
      [rider('one', '61C')]
    );
    await import('../../client/scripts/notification');
    await flush();
    const group = document.getElementById('notif-group') as HTMLSelectElement;
    group.value = 'route';
    group.dispatchEvent(new Event('change'));
    expect(document.querySelectorAll('.notif-route-group')).toHaveLength(2);
    expect(document.querySelectorAll('[data-key="alert:shared"]')).toHaveLength(
      1
    );
    expect(document.querySelectorAll('.notif-card')).toHaveLength(3);
    expect(document.getElementById('notif-count')?.textContent).toContain(
      '3 updates'
    );
    expect(document.getElementById('notif-list')?.textContent).toContain(
      'Route 61C + Route 71C'
    );
  });

  test('saved scope immediately brings a followed route into a shared group heading', async () => {
    const shared = {
      ...service('shared'),
      routeIds: ['28X', '58', '61C', '71C']
    };
    useSnapshots([shared], [], [{ routeId: '61c' }]);
    await import('../../client/scripts/notification');
    await flush();
    const group = document.getElementById('notif-group') as HTMLSelectElement;
    group.value = 'route';
    group.dispatchEvent(new Event('change'));
    const heading = () =>
      document.querySelector('.notif-group-heading')?.textContent;
    expect(heading()).toBe('Route 28X + Route 58 + 2 more · 1');

    document.getElementById('notif-saved-only')!.click();
    expect(heading()).toBe('Route 61C + Route 28X + 2 more · 1');
    expect(document.querySelectorAll('[data-key="alert:shared"]')).toHaveLength(
      1
    );
    expect(
      [...document.querySelectorAll('.notif-card .notif-route')].map(
        (link) => link.textContent
      )
    ).toEqual(['Route 28X', 'Route 58', 'Route 61C', 'Route 71C']);
    expect(document.getElementById('notif-count')?.textContent).toContain(
      '1 update'
    );

    document.getElementById('notif-saved-only')!.click();
    expect(heading()).toBe('Route 28X + Route 58 + 2 more · 1');
  });

  test('a changed followed route refreshes the heading for the same shared notice', async () => {
    const shared = {
      ...service('shared'),
      routeIds: ['28X', '58', '61C', '71C']
    };
    useSnapshots([shared], [], [{ routeId: '61C' }]);
    await import('../../client/scripts/notification');
    await flush();
    const group = document.getElementById('notif-group') as HTMLSelectElement;
    group.value = 'route';
    group.dispatchEvent(new Event('change'));
    document.getElementById('notif-saved-only')!.click();
    await flush();
    expect(document.querySelector('.notif-group-heading')?.textContent).toBe(
      'Route 61C + Route 28X + 2 more · 1'
    );

    useSnapshots([shared], [], [{ routeId: '71C' }]);
    document.getElementById('notif-refresh')!.click();
    await flush();
    expect(document.querySelector('.notif-group-heading')?.textContent).toBe(
      'Route 71C + Route 28X + 2 more · 1'
    );
    expect(document.querySelectorAll('.notif-card')).toHaveLength(1);
  });

  test('a refresh preserves expanded notices and read-action focus inside route groups', async () => {
    const long = {
      ...service(),
      descriptionText: 'An agency notice. '.repeat(35)
    };
    useSnapshots([long], []);
    await import('../../client/scripts/notification');
    await flush();
    const group = document.getElementById('notif-group') as HTMLSelectElement;
    group.value = 'route';
    group.dispatchEvent(new Event('change'));
    document.querySelector<HTMLDetailsElement>('.notif-details')!.open = true;
    document.querySelector<HTMLButtonElement>('[data-action="read"]')!.focus();
    useSnapshots([long, service('new')], []);
    document.getElementById('notif-refresh')!.click();
    await flush();
    expect(
      document.querySelector<HTMLDetailsElement>('.notif-details')!.open
    ).toBe(true);
    expect((document.activeElement as HTMLElement).dataset.action).toBe('read');
  });

  test('copying an update gives a visible dismissible success message', async () => {
    const previousClipboard = Object.getOwnPropertyDescriptor(
      navigator,
      'clipboard'
    );
    const previousShare = Object.getOwnPropertyDescriptor(navigator, 'share');
    const writeText = jest.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText }
    });
    Object.defineProperty(navigator, 'share', {
      configurable: true,
      value: undefined
    });
    try {
      useSnapshots([service()], []);
      await import('../../client/scripts/notification');
      await flush();
      document
        .querySelector<HTMLButtonElement>('[data-action="share"]')!
        .click();
      await flush();
      expect(writeText).toHaveBeenCalledTimes(1);
      const toast = document.querySelector<HTMLElement>('.toast-notification')!;
      expect(toast.textContent).toContain('Update summary copied.');
      expect(toast.hidden).toBe(false);
      toast
        .querySelector<HTMLButtonElement>('[aria-label="Dismiss message"]')!
        .click();
      expect(document.querySelector('.toast-notification')).toBeNull();
    } finally {
      if (previousClipboard)
        Object.defineProperty(navigator, 'clipboard', previousClipboard);
      else Reflect.deleteProperty(navigator, 'clipboard');
      if (previousShare)
        Object.defineProperty(navigator, 'share', previousShare);
      else Reflect.deleteProperty(navigator, 'share');
    }
  });
});

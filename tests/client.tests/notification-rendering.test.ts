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
  riders: unknown[] = [rider()]
): void {
  mockFetch.mockImplementation((url: string) =>
    Promise.resolve(
      result(
        url === '/notifications/alerts'
          ? services
          : url === '/notifications/notifications'
            ? riders
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
    localStorage.setItem('token', 'test-token');
    history.replaceState(null, '', '/notifications');
    Object.defineProperty(document, 'hidden', {
      configurable: true,
      value: false
    });
    document.body.innerHTML =
      '<ul id="notif-list"></ul><p id="notif-empty"></p><p id="notif-status"></p><span id="notif-count"></span><input id="notif-search-input"><button id="notif-search-clear"></button><button id="notif-refresh"></button><button data-notif-view="all"></button><button data-notif-view="service"></button><button data-notif-view="live"></button>';
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
    expect(mockFetch).toHaveBeenCalledTimes(count + 2);
    expect(mockConnect).toHaveBeenCalledTimes(1);
  });
});

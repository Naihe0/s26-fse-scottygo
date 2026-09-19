/** @jest-environment jsdom */

jest.mock('../../client/scripts/components/app-header', () => ({}));
jest.mock('../../client/scripts/components/live-notifications', () => ({}));
jest.mock('socket.io-client', () => ({ io: () => ({ on: jest.fn() }) }));
const mockFetch = jest.fn();
const unsafeText = '<img src=x onerror=alert(1)>';
const result = (payload: unknown) => ({
  ok: true,
  json: async () => ({ payload })
});
async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

describe('notification list rendering and search ownership', () => {
  beforeEach(() => {
    jest.resetModules();
    jest.useFakeTimers();
    global.fetch = mockFetch;
    mockFetch.mockReset();
    localStorage.setItem('token', 'test-token');
    history.replaceState(null, '', '/notifications');
    document.body.innerHTML =
      '<ul id="notif-list"></ul><p id="notif-empty"></p><input id="notif-search-input"><button id="notif-search-clear"></button>';
  });
  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  test('service feed text is displayed literally, without HTML execution', async () => {
    mockFetch.mockImplementation((url: string) =>
      Promise.resolve(
        result(
          url === '/transit/routes'
            ? []
            : [
                {
                  headerText: unsafeText,
                  descriptionText: unsafeText,
                  routeIds: [unsafeText]
                }
              ]
        )
      )
    );
    await import('../../client/scripts/notification');
    await flush();
    expect(document.querySelector('img')).toBeNull();
    expect(document.querySelector('.notif-title')!.textContent).toBe(
      unsafeText
    );
    expect(document.querySelector('.notif-body')!.textContent).toBe(unsafeText);
  });

  test('persisted report messages are rendered literally in search results', async () => {
    history.replaceState(null, '', '/notifications?route=61D');
    mockFetch.mockImplementation((url: string) =>
      Promise.resolve(
        result(
          url.startsWith('/notifications/notifications')
            ? [
                {
                  routeId: '61D',
                  vid: unsafeText,
                  message: unsafeText,
                  createdAt: new Date().toISOString()
                }
              ]
            : []
        )
      )
    );
    await import('../../client/scripts/notification');
    await flush();
    expect(document.querySelector('img')).toBeNull();
    expect(document.querySelector('.notif-body')!.textContent).toBe(unsafeText);
  });

  test('clearing search cancels a queued search and cannot be overwritten by its pending response', async () => {
    let finishSearch!: (value: unknown) => void;
    mockFetch.mockImplementation((url: string) => {
      if (url.startsWith('/notifications/notifications'))
        return new Promise((resolve) => {
          finishSearch = resolve;
        });
      return Promise.resolve(result([]));
    });
    await import('../../client/scripts/notification');
    await flush();
    const input = document.getElementById(
      'notif-search-input'
    ) as HTMLInputElement;
    input.value = 'old';
    input.dispatchEvent(new Event('input'));
    await jest.advanceTimersByTimeAsync(300);
    document.getElementById('notif-search-clear')!.click();
    finishSearch(
      result([
        {
          routeId: '61D',
          message: 'old notification',
          createdAt: new Date().toISOString()
        }
      ])
    );
    await flush();
    expect(document.getElementById('notif-list')!.children.length).toBe(0);
    const requestCount = mockFetch.mock.calls.length;
    input.value = 'queued';
    input.dispatchEvent(new Event('input'));
    document.getElementById('notif-search-clear')!.click();
    await jest.advanceTimersByTimeAsync(300);
    expect(mockFetch).toHaveBeenCalledTimes(requestCount + 1);
  });
});

/** @jest-environment jsdom */
import { SharedStopNavigation } from '../../client/scripts/utils/stop-link-navigation';

const stop = {
  stopId: 'cmu:123',
  stopName: 'Campus stop',
  lat: 40.44,
  lon: -79.94,
  routes: ['61C'],
  dtradd: [],
  dtrrem: []
};
function response(stops: unknown[], status = 200): Response {
  return {
    ok: status === 200,
    status,
    json: async () => ({ name: 'SearchTransitCompleted', payload: { stops } })
  } as Response;
}

describe('shared and saved stop navigation', () => {
  const originalFetch = globalThis.fetch;
  let fetchMock: jest.Mock<
    Promise<Response>,
    [RequestInfo | URL, RequestInit?]
  >;
  let openStop: jest.Mock;
  let onError: jest.Mock<void, [string, () => Promise<void>]>;
  let navigation: SharedStopNavigation;

  beforeEach(() => {
    jest.useFakeTimers();
    localStorage.clear();
    localStorage.setItem('token', 'test-session');
    fetchMock = jest
      .fn<Promise<Response>, [RequestInfo | URL, RequestInit?]>()
      .mockResolvedValue(response([stop]));
    globalThis.fetch = fetchMock;
    openStop = jest.fn();
    onError = jest.fn<void, [string, () => Promise<void>]>();
    navigation = new SharedStopNavigation({ openStop, onError });
  });
  afterEach(() => {
    navigation.cancel();
    jest.clearAllTimers();
    jest.useRealTimers();
    globalThis.fetch = originalFetch;
  });

  test('looks up the encoded public ID with authentication and opens its exact current record', async () => {
    await navigation.open('cmu:123');
    expect(fetchMock).toHaveBeenCalledWith(
      '/search?q=cmu%3A123',
      expect.objectContaining({
        headers: { Authorization: 'Bearer test-session' },
        signal: expect.any(AbortSignal)
      })
    );
    expect(openStop).toHaveBeenCalledWith(stop);
    expect(onError).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
  });

  test('never opens a substring match returned ahead of the exact stop', async () => {
    fetchMock.mockResolvedValue(
      response([{ ...stop, stopId: 'cmu:123-extra' }, stop])
    );
    await navigation.open('cmu:123');
    expect(openStop).toHaveBeenCalledWith(stop);
  });

  test('reports a missing exact record and allows an explicit retry', async () => {
    fetchMock
      .mockResolvedValueOnce(response([{ ...stop, stopId: 'cmu:123-extra' }]))
      .mockResolvedValueOnce(response([stop]));
    await navigation.open('cmu:123');
    expect(openStop).not.toHaveBeenCalled();
    expect(onError.mock.calls[0][0]).toContain('unavailable');
    await onError.mock.calls[0][1]();
    expect(openStop).toHaveBeenCalledWith(stop);
  });

  test('rejects unsafe link IDs before a network request', async () => {
    await navigation.open('../account');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(onError.mock.calls[0][0]).toContain('not valid');
  });

  test.each([
    { ...stop, lat: 91 },
    { ...stop, lon: Number.NaN },
    { ...stop, stopName: '' },
    { ...stop, lat: '40.44' },
    { ...stop, stopName: 'x'.repeat(301) }
  ])('rejects malformed stop geometry or labels: %j', async (invalid) => {
    fetchMock.mockResolvedValue(response([invalid]));
    await navigation.open('cmu:123');
    expect(openStop).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledTimes(1);
  });

  test('strips unexpected fields and supplies safe optional arrays', async () => {
    fetchMock.mockResolvedValue(
      response([
        { ...stop, token: 'hidden', dtradd: null, routes: [42, '61C'] }
      ])
    );
    await navigation.open('cmu:123');
    expect(openStop).toHaveBeenCalledWith(stop);
  });

  test('cancelling suppresses both a late lookup and error feedback', async () => {
    let finish!: (result: Response) => void;
    fetchMock.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      })
    );
    const pending = navigation.open('cmu:123');
    const signal = fetchMock.mock.calls[0][1]!.signal!;
    navigation.cancel();
    await pending;
    expect(signal.aborted).toBe(true);
    finish(response([stop]));
    await Promise.resolve();
    expect(openStop).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });

  test('a newer stop navigation supersedes an older response', async () => {
    let finish!: (result: Response) => void;
    fetchMock.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      })
    );
    const old = navigation.open('old');
    await navigation.open('cmu:123');
    finish(response([{ ...stop, stopId: 'old' }]));
    await old;
    expect(openStop).toHaveBeenCalledTimes(1);
    expect(openStop).toHaveBeenCalledWith(stop);
  });

  test('a session change suppresses an old response and its retry', async () => {
    fetchMock.mockResolvedValueOnce(response([], 503));
    await navigation.open('cmu:123');
    const retry = onError.mock.calls[0][1];
    localStorage.setItem('token', 'another-session');
    await retry();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    let finish!: (result: Response) => void;
    fetchMock.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      })
    );
    const pending = navigation.open('cmu:123');
    localStorage.removeItem('token');
    finish(response([stop]));
    await pending;
    expect(openStop).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledTimes(1);
  });

  test('enforces the deadline even if a transport ignores its abort signal', async () => {
    fetchMock.mockReturnValue(new Promise(() => {}));
    const pending = navigation.open('cmu:123');
    await jest.advanceTimersByTimeAsync(15_000);
    await pending;
    expect(fetchMock.mock.calls[0][1]!.signal!.aborted).toBe(true);
    expect(onError.mock.calls[0][0]).toContain('too long');
    expect(openStop).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
  });

  test('also bounds a stalled response body and reports HTTP or malformed-response errors', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => new Promise(() => {})
    } as unknown as Response);
    const pending = navigation.open('cmu:123');
    await jest.advanceTimersByTimeAsync(15_000);
    await pending;
    expect(onError.mock.calls[0][0]).toContain('too long');
    fetchMock.mockResolvedValueOnce(response([], 401));
    await navigation.open('cmu:123');
    expect(onError.mock.calls[1][0]).toContain('Sign in again');
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ payload: { stops: [stop] } })
    } as Response);
    await navigation.open('cmu:123');
    expect(onError.mock.calls[2][0]).toContain('Could not load');
  });
});

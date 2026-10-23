import { transit_realtime } from 'gtfs-realtime-bindings';
import { AlertsService } from '../../../server/services/alerts.service';
import dotenv from 'dotenv';

const ALERT_POLL_MS = 5 * 60_000;

function alertFeed(entity: transit_realtime.IFeedEntity[] = []): Response {
  const bytes = transit_realtime.FeedMessage.encode({
    header: { gtfsRealtimeVersion: '2.0' },
    entity
  }).finish();
  return new Response(bytes.slice());
}

describe('service alert polling', () => {
  let service: AlertsService;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    service = new AlertsService();
  });

  afterEach(() => {
    service.stop();
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  test('a hung alerts request reaches its deadline and allows the next poll', async () => {
    const request = jest.spyOn(global, 'fetch').mockImplementation(
      (_url, options) =>
        new Promise((_resolve, reject) => {
          options?.signal?.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError'))
          );
        })
    );
    service.start();
    await jest.advanceTimersByTimeAsync(15_000);
    expect(service.isHealthy()).toBe(false);
    expect(service.getLastError()).toContain('timed out');

    request.mockResolvedValue(alertFeed());
    await jest.advanceTimersByTimeAsync(ALERT_POLL_MS);
    expect(service.isHealthy()).toBe(true);
    expect(request).toHaveBeenCalledTimes(2);
  });

  test('identical consecutive alerts emit one change event', async () => {
    jest
      .spyOn(global, 'fetch')
      .mockImplementation(async () =>
        alertFeed([
          {
            id: 'alert-1',
            alert: { headerText: { translation: [{ text: 'Test delay' }] } }
          }
        ])
      );
    const changed = jest.fn();
    service.onAlertsChanged = changed;
    service.start();
    await jest.advanceTimersByTimeAsync(ALERT_POLL_MS);
    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(changed).toHaveBeenCalledTimes(1);
  });
});

test.each([
  { key: '', password: 'TestPassword123!' },
  { key: 'someDefaultKey', password: 'TestPassword123!' },
  {
    key: 'PLEASE POPULATE YOUR PRODUCTION JWT SECRET HERE',
    password: 'TestPassword123!'
  },
  { key: 'a'.repeat(32), password: 'admin' },
  { key: 'a'.repeat(32), password: 'PLEASE POPULATE ADMIN PASSWORD HERE' }
])('production refuses unsafe configuration %j', ({ key, password }) => {
  const saved = {
    stage: process.env.STAGE,
    key: process.env.JWT_KEY,
    password: process.env.INITIAL_ADMIN_PASSWORD
  };
  jest.spyOn(dotenv, 'config').mockReturnValue({});
  Object.assign(process.env, {
    STAGE: 'PROD',
    JWT_KEY: key,
    INITIAL_ADMIN_PASSWORD: password
  });
  try {
    expect(() =>
      jest.isolateModules(() => {
        jest.requireActual('../../../server/env');
      })
    ).toThrow('Production requires');
  } finally {
    process.env.STAGE = saved.stage;
    process.env.JWT_KEY = saved.key;
    process.env.INITIAL_ADMIN_PASSWORD = saved.password;
  }
});

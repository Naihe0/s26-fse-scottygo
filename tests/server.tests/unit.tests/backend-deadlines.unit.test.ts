import { transit_realtime } from 'gtfs-realtime-bindings';
import alertsService from '../../../server/services/alerts.service';
import dotenv from 'dotenv';

const internal = alertsService as unknown as {
  fetchAlerts(): Promise<void>;
  fetchInProgress: boolean;
  isStopping: boolean;
  alerts: unknown[];
};

afterEach(() => {
  alertsService.stop();
  alertsService.onAlertsChanged = null;
  jest.restoreAllMocks();
  jest.useRealTimers();
});

test('a hung alerts request reaches its deadline and allows the next poll', async () => {
  jest.useFakeTimers();
  internal.isStopping = false;
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
  const request = jest.spyOn(global, 'fetch').mockImplementation(
    (_url, options) =>
      new Promise((_resolve, reject) => {
        options?.signal?.addEventListener('abort', () =>
          reject(new DOMException('aborted', 'AbortError'))
        );
      })
  );
  const pending = internal.fetchAlerts();
  await jest.advanceTimersByTimeAsync(15_000);
  await pending;
  expect(alertsService.isHealthy()).toBe(false);
  expect(alertsService.getLastError()).toContain('timed out');
  expect(internal.fetchInProgress).toBe(false);

  const body = transit_realtime.FeedMessage.encode({
    header: { gtfsRealtimeVersion: '2.0' },
    entity: []
  }).finish();
  request.mockResolvedValue(new Response(body));
  await internal.fetchAlerts();
  expect(alertsService.isHealthy()).toBe(true);
  expect(request).toHaveBeenCalledTimes(2);
});

test('identical consecutive alerts emit one change event', async () => {
  internal.isStopping = false;
  internal.alerts = [];
  jest.spyOn(console, 'log').mockImplementation(() => undefined);
  const body = transit_realtime.FeedMessage.encode({
    header: { gtfsRealtimeVersion: '2.0' },
    entity: [
      {
        id: 'alert-1',
        alert: { headerText: { translation: [{ text: 'Test delay' }] } }
      }
    ]
  }).finish();
  jest
    .spyOn(global, 'fetch')
    .mockImplementation(async () => new Response(body));
  const changed = jest.fn();
  alertsService.onAlertsChanged = changed;
  await internal.fetchAlerts();
  await internal.fetchAlerts();
  expect(changed).toHaveBeenCalledTimes(1);
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

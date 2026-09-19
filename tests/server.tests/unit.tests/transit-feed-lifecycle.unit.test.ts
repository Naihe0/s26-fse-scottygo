import { transit_realtime } from 'gtfs-realtime-bindings';
import { VehiclePositionsService } from '../../../server/services/vehicle-positions.service';
import { TripUpdatesService } from '../../../server/services/trip-updates.service';
import { TripShotLiveStatusService } from '../../../server/services/tripshot-livestatus.service';

const emptyFeed = transit_realtime.FeedMessage.encode({
  header: { gtfsRealtimeVersion: '2.0' },
  entity: []
}).finish();

function response(bytes: Uint8Array = emptyFeed): Response {
  return {
    ok: true,
    arrayBuffer: async () => bytes,
    json: async () => ({ vehicleStatuses: [], rides: [], vehicles: [] })
  } as unknown as Response;
}

function deferredResponse() {
  let resolve!: (result: Response) => void;
  const promise = new Promise<Response>((done) => {
    resolve = done;
  });
  return { resolve, promise };
}

describe.each([
  ['PRT vehicles', () => new VehiclePositionsService(), 15_000],
  ['PRT arrivals', () => new TripUpdatesService(), 15_000],
  ['CMU live status', () => new TripShotLiveStatusService(), 10_000]
] as const)('%s polling lifecycle', (_label, createService, timeoutMs) => {
  let service: ReturnType<typeof createService>;
  let fetchMock: jest.SpyInstance;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(Date.UTC(2026, 8, 19, 12));
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    fetchMock = jest.spyOn(globalThis, 'fetch').mockResolvedValue(response());
    service = createService();
  });

  afterEach(async () => {
    service.stop();
    await jest.advanceTimersByTimeAsync(0);
    expect(jest.getTimerCount()).toBe(0);
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  test('reports unhealthy before the first sample and when the last sample expires', async () => {
    expect(service.isHealthy()).toBe(false);
    service.start();
    await jest.advanceTimersByTimeAsync(0);
    expect(service.isHealthy()).toBe(true);
    service.stop();
    await jest.advanceTimersByTimeAsync(90_001);
    expect(service.isHealthy()).toBe(false);
  });

  test('times out a stalled request then recovers on the next scheduled poll', async () => {
    fetchMock.mockImplementationOnce(
      (_url, options: RequestInit) =>
        new Promise((_resolve, reject) => {
          options.signal!.addEventListener(
            'abort',
            () => reject(new DOMException('Aborted', 'AbortError')),
            { once: true }
          );
        })
    );
    service.start();
    await jest.advanceTimersByTimeAsync(timeoutMs);
    expect(service.getConsecutiveFailures()).toBe(1);
    expect(service.isHealthy()).toBe(false);
    await jest.advanceTimersByTimeAsync(30_000 - timeoutMs);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(service.getConsecutiveFailures()).toBe(0);
    expect(service.isHealthy()).toBe(true);
  });

  test('stop aborts an in-flight request without publishing a late response or restarting polling', async () => {
    const pending = deferredResponse();
    fetchMock.mockReturnValueOnce(pending.promise);
    service.start();
    const signal = fetchMock.mock.calls[0][1].signal as AbortSignal;
    service.stop();
    expect(signal.aborted).toBe(true);
    pending.resolve(response());
    await jest.advanceTimersByTimeAsync(120_000);
    expect(service.getLastFetched()).toBeNull();
    expect(service.getConsecutiveFailures()).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('an old request cannot overwrite a newer polling session after stop and restart', async () => {
    const pending = deferredResponse();
    fetchMock.mockReturnValueOnce(pending.promise);
    service.start();
    service.stop();
    service.start();
    await jest.advanceTimersByTimeAsync(0);
    const currentTimestamp = service.getLastFetched();
    expect(currentTimestamp).not.toBeNull();
    await jest.advanceTimersByTimeAsync(1000);
    pending.resolve(response());
    await jest.advanceTimersByTimeAsync(0);
    expect(service.getLastFetched()).toEqual(currentTimestamp);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

test('PRT arrival lookups recalculate minutes and remove departures that passed during a feed outage', async () => {
  jest.useFakeTimers();
  jest.setSystemTime(Date.UTC(2026, 8, 19, 12));
  const service = new TripUpdatesService();
  const arrivalTime = Math.floor(Date.now() / 1000) + 120;
  const bytes = transit_realtime.FeedMessage.encode({
    header: { gtfsRealtimeVersion: '2.0' },
    entity: [
      {
        id: 'trip-1',
        tripUpdate: {
          trip: { tripId: 'trip-1', routeId: '61C' },
          stopTimeUpdate: [{ stopId: '1', arrival: { time: arrivalTime } }]
        }
      }
    ]
  }).finish();
  jest.spyOn(console, 'log').mockImplementation(() => undefined);
  jest.spyOn(globalThis, 'fetch').mockResolvedValue(response(bytes));
  try {
    service.start();
    await jest.advanceTimersByTimeAsync(0);
    service.stop();
    expect(service.getPredictions('1')[0].minutes).toBe(2);
    await jest.advanceTimersByTimeAsync(60_000);
    expect(service.getPredictions('1')[0].minutes).toBe(1);
    await jest.advanceTimersByTimeAsync(60_001);
    expect(service.getPredictions('1')).toEqual([]);
  } finally {
    service.stop();
    jest.useRealTimers();
    jest.restoreAllMocks();
  }
});

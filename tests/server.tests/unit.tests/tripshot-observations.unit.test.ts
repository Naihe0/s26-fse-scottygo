import { TripShotLiveStatusService } from '../../../server/services/tripshot-livestatus.service';

const now = Date.UTC(2026, 9, 24, 12);
let service: TripShotLiveStatusService;
let fetchMock: jest.SpyInstance;

function status(age = 0, extra: Record<string, unknown> = {}) {
  return {
    vehicleId: 'bus-id',
    name: 'Bus 1',
    location: { lt: 40.44, lg: -79.94 },
    when: new Date(now - age).toISOString(),
    speed: 8,
    bearing: 90,
    liveDataAvailable: true,
    ...extra
  };
}

function response(statuses = [status()], duplicateRide = false): Response {
  const ride = {
    routeId: 'route-id',
    vehicleId: 'bus-id',
    state: { Active: {} },
    scheduledStart: new Date(now - 60_000).toISOString(),
    scheduledEnd: new Date(now + 60_000).toISOString(),
    stopStatus: []
  };
  return {
    ok: true,
    json: async () => ({
      vehicleStatuses: statuses,
      rides: duplicateRide ? [ride, ride] : [ride]
    })
  } as unknown as Response;
}

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(now);
  jest.spyOn(console, 'log').mockImplementation(() => undefined);
  fetchMock = jest.spyOn(globalThis, 'fetch');
  service = new TripShotLiveStatusService();
});
afterEach(() => {
  service.stop();
  expect(jest.getTimerCount()).toBe(0);
  jest.useRealTimers();
  jest.restoreAllMocks();
});

test('multiple active rides or duplicate statuses do not duplicate the physical shuttle', async () => {
  fetchMock.mockResolvedValue(
    response([status(30_000), status(), status(20_000)], true)
  );
  service.start();
  await jest.advanceTimersByTimeAsync(0);
  const vehicles = service.getVehiclesByTsRouteId('route-id');
  expect(vehicles).toHaveLength(1);
  expect(vehicles[0].lastUpdate).toBe(new Date(now).toISOString());
});

test('a newly fetched old GPS sample does not move the shuttle backwards', async () => {
  fetchMock
    .mockResolvedValueOnce(response())
    .mockResolvedValue(
      response([
        status(20_000, { location: { lt: 40.4, lg: -79.95 }, bearing: 270 })
      ])
    );
  service.start();
  await jest.advanceTimersByTimeAsync(0);
  const previous = service.getVehiclesByTsRouteId('route-id')[0];
  await jest.advanceTimersByTimeAsync(15_000);
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(service.getVehiclesByTsRouteId('route-id')).toEqual([previous]);
  expect(service.getLastFetched()?.getTime()).toBe(now + 15_000);
  expect(previous.lastUpdate).toBe(new Date(now).toISOString());
});

test('an invalid timestamp duplicate cannot hide a measured shuttle fix', async () => {
  fetchMock.mockResolvedValue(
    response([
      status(),
      status(0, { when: '', location: { lt: 40.4, lg: -79.95 } })
    ])
  );
  service.start();
  await jest.advanceTimersByTimeAsync(0);
  expect(service.getVehiclesByTsRouteId('route-id')).toEqual([
    expect.objectContaining({
      lat: 40.44,
      lon: -79.94,
      lastUpdate: new Date(now).toISOString()
    })
  ]);
});

test('bad coordinates are excluded and invalid speed/bearing stay unknown', async () => {
  fetchMock.mockResolvedValue(
    response([
      status(0, { location: { lt: NaN, lg: -79.94 } }),
      status(0, { speed: -1, bearing: 500 })
    ])
  );
  service.start();
  await jest.advanceTimersByTimeAsync(0);
  expect(service.getVehiclesByTsRouteId('route-id')).toEqual([
    expect.objectContaining({
      speed: undefined,
      heading: undefined,
      lat: 40.44
    })
  ]);
});

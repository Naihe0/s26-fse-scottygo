import { transit_realtime } from 'gtfs-realtime-bindings';
import { VehiclePositionsService } from '../../../server/services/vehicle-positions.service';

const CURRENT_SECONDS = Date.UTC(2026, 8, 19, 12) / 1000;
let service: VehiclePositionsService;
let fetchMock: jest.SpyInstance;

function position(
  extras: Partial<transit_realtime.IVehiclePosition> = {}
): transit_realtime.IVehiclePosition {
  return {
    trip: { routeId: '61C' },
    position: { latitude: 40.44, longitude: -79.94 },
    ...extras
  };
}

function feed(vehicles: transit_realtime.IVehiclePosition[]) {
  return transit_realtime.FeedMessage.encode({
    header: { gtfsRealtimeVersion: '2.0', timestamp: CURRENT_SECONDS },
    entity: vehicles.map((vehicle, index) => ({ id: `bus-${index}`, vehicle }))
  }).finish();
}

async function poll(vehicles: transit_realtime.IVehiclePosition[]) {
  const bytes = feed(vehicles);
  fetchMock.mockResolvedValue({
    ok: true,
    arrayBuffer: async () => bytes
  } as unknown as Response);
  service.start();
  await jest.advanceTimersByTimeAsync(0);
  return service.getVehicles('61C');
}

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(CURRENT_SECONDS * 1000);
  jest.spyOn(console, 'log').mockImplementation(() => undefined);
  fetchMock = jest.spyOn(globalThis, 'fetch');
  service = new VehiclePositionsService();
});

afterEach(() => {
  service.stop();
  expect(jest.getTimerCount()).toBe(0);
  jest.useRealTimers();
  jest.restoreAllMocks();
});

test('missing protobuf fields stay unknown despite inherited zero and status defaults', async () => {
  const decoded = transit_realtime.FeedMessage.decode(feed([position()]))
    .entity[0].vehicle!;
  expect(decoded.position!.speed).toBe(0);
  expect(decoded.currentStopSequence).toBe(0);
  expect(decoded.currentStatus).toBeDefined();
  for (const field of ['timestamp', 'currentStatus', 'currentStopSequence']) {
    expect(Object.prototype.hasOwnProperty.call(decoded, field)).toBe(false);
  }
  const [vehicle] = await poll([position()]);
  const serialized = JSON.parse(JSON.stringify(vehicle));
  expect(serialized).not.toHaveProperty('speed');
  expect(serialized).not.toHaveProperty('heading');
  expect(serialized).not.toHaveProperty('currentStatus');
  expect(serialized).not.toHaveProperty('currentStopSequence');
  // Neither a fresh feed header nor a recent fetch makes this a recent fix.
  expect(vehicle.lastUpdate).toBe('');
  expect(Number.isNaN(Date.parse(vehicle.lastUpdate))).toBe(true);
});

test('preserves explicitly measured zero speed, north bearing, and stop sequence zero', async () => {
  const [vehicle] = await poll([
    position({
      position: { latitude: 40.44, longitude: -79.94, speed: 0, bearing: 0 },
      currentStopSequence: 0,
      currentStatus:
        transit_realtime.VehiclePosition.VehicleStopStatus.STOPPED_AT,
      timestamp: CURRENT_SECONDS
    })
  ]);
  expect(vehicle).toMatchObject({
    speed: 0,
    heading: 0,
    currentStopSequence: 0,
    currentStatus: 'STOPPED_AT',
    lastUpdate: new Date(CURRENT_SECONDS * 1000).toISOString()
  });
});

test.each([
  [0, 'INCOMING_AT'],
  [1, 'STOPPED_AT'],
  [2, 'IN_TRANSIT_TO'],
  [123, undefined]
])(
  'decodes explicit status %s with a stop sequence as %s',
  async (status, expected) => {
    const [vehicle] = await poll([
      position({ currentStopSequence: 3, currentStatus: status as number })
    ]);
    expect(vehicle.currentStatus).toBe(expected);
  }
);

test('status without a stop sequence is ignored, and a missing status is not inferred', async () => {
  const vehicles = await poll([
    position({
      currentStatus:
        transit_realtime.VehiclePosition.VehicleStopStatus.STOPPED_AT
    }),
    position({ currentStopSequence: 3 })
  ]);
  expect(vehicles.map((vehicle) => vehicle.currentStatus)).toEqual([
    undefined,
    undefined
  ]);
});

test.each([NaN, Infinity, -Infinity, -0.1])(
  'invalid measured speed %s remains unknown',
  async (speed) => {
    const [vehicle] = await poll([
      position({ position: { latitude: 40.44, longitude: -79.94, speed } })
    ]);
    expect(vehicle.speed).toBeUndefined();
  }
);

test('retains speed in meters per second and leaves the original measurement time intact', async () => {
  const measured = CURRENT_SECONDS - 300;
  const [vehicle] = await poll([
    position({
      timestamp: measured,
      position: { latitude: 40.44, longitude: -79.94, speed: 12.5 }
    })
  ]);
  expect(vehicle.speed).toBe(12.5);
  expect(vehicle.lastUpdate).toBe(new Date(measured * 1000).toISOString());
});

test('an explicitly encoded epoch is stale rather than replaced with the current time', async () => {
  const [vehicle] = await poll([position({ timestamp: 0 })]);
  expect(vehicle.lastUpdate).toBe('1970-01-01T00:00:00.000Z');
});

test('out-of-range timestamp cannot abort a valid feed or fabricate freshness', async () => {
  const vehicles = await poll([
    position({ timestamp: 9_000_000_000_000 }),
    position({ timestamp: CURRENT_SECONDS })
  ]);
  expect(service.isHealthy()).toBe(true);
  expect(vehicles).toHaveLength(2);
  expect(vehicles[0].lastUpdate).toBe('');
  expect(vehicles[1].lastUpdate).toBe(
    new Date(CURRENT_SECONDS * 1000).toISOString()
  );
});

test('invalid coordinates are skipped individually and empty descriptor id falls back to entity id', async () => {
  const vehicles = await poll([
    position({ position: { latitude: NaN, longitude: -79.94 } }),
    position({ position: { latitude: 91, longitude: -79.94 } }),
    position({ position: { latitude: 40.44, longitude: 181 } }),
    position({ vehicle: {} })
  ]);
  expect(vehicles).toHaveLength(1);
  expect(vehicles[0].vid).toBe('bus-3');
  expect(service.isHealthy()).toBe(true);
});

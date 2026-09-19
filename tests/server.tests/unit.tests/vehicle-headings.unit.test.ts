import { transit_realtime } from 'gtfs-realtime-bindings';
import { VehiclePositionsService } from '../../../server/services/vehicle-positions.service';
import { TripShotLiveStatusService } from '../../../server/services/tripshot-livestatus.service';
import trueTimeService from '../../../server/services/truetime.service';

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(Date.UTC(2026, 8, 19, 12));
  jest.spyOn(console, 'log').mockImplementation(() => undefined);
});

afterEach(() => {
  expect(jest.getTimerCount()).toBe(0);
  jest.useRealTimers();
  jest.restoreAllMocks();
});

function vehicleFeed(bearing?: number) {
  return transit_realtime.FeedMessage.encode({
    header: { gtfsRealtimeVersion: '2.0' },
    entity: [
      {
        id: 'prt-vehicle',
        vehicle: {
          trip: { routeId: '61C' },
          position: { latitude: 40.44, longitude: -79.94, bearing },
          timestamp: Math.floor(Date.now() / 1000)
        }
      }
    ]
  }).finish();
}

describe('PRT protobuf bearing availability', () => {
  it('distinguishes omitted protobuf bearing from an explicitly encoded northbound zero', () => {
    const missing =
      transit_realtime.FeedMessage.decode(vehicleFeed()).entity[0].vehicle!
        .position!;
    const north = transit_realtime.FeedMessage.decode(vehicleFeed(0)).entity[0]
      .vehicle!.position!;
    expect(missing.bearing).toBe(0); // protobuf's inherited default is not a supplied observation.
    expect(Object.prototype.hasOwnProperty.call(missing, 'bearing')).toBe(
      false
    );
    expect(Object.prototype.hasOwnProperty.call(north, 'bearing')).toBe(true);
  });

  it.each([
    [undefined, undefined],
    [0, 0],
    [90, 90],
    [359.5, 359.5],
    [NaN, undefined],
    [Infinity, undefined],
    [-Infinity, undefined]
  ])(
    'returns bearing %s as %s through the public service',
    async (bearing, expected) => {
      const bytes = vehicleFeed(bearing);
      jest.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        arrayBuffer: async () => bytes
      } as unknown as Response);
      const service = new VehiclePositionsService();
      try {
        service.start();
        await jest.advanceTimersByTimeAsync(0);
        const vehicles = service.getVehicles('61C');
        expect(service.isHealthy()).toBe(true);
        expect(vehicles).toHaveLength(1);
        expect(vehicles[0].heading).toBe(expected);
        if (expected === undefined)
          expect(JSON.parse(JSON.stringify(vehicles[0]))).not.toHaveProperty(
            'heading'
          );
      } finally {
        service.stop();
      }
    }
  );
});

describe('TripShot bearing availability', () => {
  it.each([
    [undefined, undefined],
    [null, undefined],
    [0, 0],
    [270, 270],
    [359.5, 359.5],
    [NaN, undefined],
    [Infinity, undefined],
    ['90', undefined]
  ])(
    'returns bearing %s as %s through the public service',
    async (bearing, expected) => {
      jest.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        json: async () => ({
          vehicleStatuses: [
            {
              vehicleId: 'cmu-vehicle',
              name: 'Shuttle',
              location: { lt: 40.44, lg: -79.94 },
              when: new Date().toISOString(),
              liveDataAvailable: true,
              bearing
            }
          ],
          rides: [
            {
              routeId: 'cmu-route',
              vehicleId: 'cmu-vehicle',
              state: { Active: {} },
              vias: [],
              stopStatus: []
            }
          ]
        })
      } as unknown as Response);
      const service = new TripShotLiveStatusService();
      try {
        service.start();
        await jest.advanceTimersByTimeAsync(0);
        const vehicles = service.getVehiclesByTsRouteId('cmu-route');
        expect(service.isHealthy()).toBe(true);
        expect(vehicles).toHaveLength(1);
        expect(vehicles[0].heading).toBe(expected);
        if (expected === undefined)
          expect(JSON.parse(JSON.stringify(vehicles[0]))).not.toHaveProperty(
            'heading'
          );
      } finally {
        service.stop();
      }
    }
  );
});

describe('TrueTime heading parsing', () => {
  it.each([
    [undefined, undefined],
    [null, undefined],
    ['', undefined],
    ['   ', undefined],
    ['bad', undefined],
    ['90bad', undefined],
    ['Infinity', undefined],
    ['0', 0],
    ['270', 270],
    [' 45.5 ', 45.5]
  ])(
    'returns heading %s as %s through the public service',
    async (hdg, expected) => {
      jest.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(
          JSON.stringify({
            'bustime-response': {
              vehicle: [
                {
                  vid: 'prt-vehicle',
                  rt: '61C',
                  lat: '40.44',
                  lon: '-79.94',
                  tmstmp: '20260919 08:00',
                  hdg
                }
              ]
            }
          })
        )
      );
      const vehicles = await trueTimeService.getVehicles('61C');
      expect(vehicles).toHaveLength(1);
      expect(vehicles[0].heading).toBe(expected);
      if (expected === undefined)
        expect(JSON.parse(JSON.stringify(vehicles[0]))).not.toHaveProperty(
          'heading'
        );
    }
  );
});

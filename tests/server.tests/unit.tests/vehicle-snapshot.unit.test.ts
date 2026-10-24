import type { IVehicle } from '../../../common/transit.interface';
import { reconcileVehicleSnapshot } from '../../../server/services/vehicle-snapshot';

const now = Date.UTC(2026, 9, 24, 12);
const bus = (age = 0, extra: Partial<IVehicle> = {}): IVehicle => ({
  vid: '1',
  lat: 40.44,
  lon: -79.94,
  routeId: '61C',
  source: 'live',
  isDetoured: false,
  speed: 10,
  heading: 90,
  lastUpdate: new Date(now - age).toISOString(),
  ...extra
});

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(now);
});
afterEach(() => jest.useRealTimers());

test('duplicate entities yield one bus with the newest measured position', () => {
  const fresh = bus(0, { lat: 40.45 });
  expect(
    reconcileVehicleSnapshot([bus(30_000), fresh, bus(10_000)], [])
  ).toEqual([fresh]);
});

test('an out-of-order source response cannot move a bus back or change its trip', () => {
  const fresh = bus(0, { tripId: 'new-trip' });
  const old = bus(30_000, { lat: 40.4, routeId: '61A', tripId: 'old-trip' });
  expect(reconcileVehicleSnapshot([old], [fresh])).toEqual([fresh]);
});

test('same-timestamp coordinate and heading jitter stays fixed, while a stop halts motion', () => {
  const previous = bus();
  const repeated = bus(0, {
    lat: 40.441,
    heading: 270,
    speed: 0,
    currentStatus: 'STOPPED_AT'
  });
  expect(reconcileVehicleSnapshot([repeated], [previous])).toEqual([
    { ...previous, speed: 0, currentStatus: 'STOPPED_AT' }
  ]);
});

test('same-timestamp duplicate route assignment stays on the accepted route', () => {
  const previous = bus();
  expect(
    reconcileVehicleSnapshot([bus(0, { routeId: '61A' })], [previous])
  ).toEqual([previous]);
});

test('unknown timestamp cannot overwrite a known observation or fabricate freshness', () => {
  const previous = bus(10_000);
  expect(
    reconcileVehicleSnapshot(
      [bus(0, { lastUpdate: '', lat: 40.45 })],
      [previous]
    )
  ).toEqual([previous]);
  const unknown = bus(0, { lastUpdate: '' });
  expect(reconcileVehicleSnapshot([unknown], [])).toEqual([unknown]);
});

test.each([-6_000, -3_600_000])(
  'a bad future clock %s cannot poison acceptance of the next real fix',
  (age) => {
    const future = bus(age);
    const current = bus(0, { lat: 40.46 });
    expect(reconcileVehicleSnapshot([current], [future])).toEqual([current]);
  }
);

test('a genuine newer trip and route are accepted', () => {
  const newer = bus(0, { routeId: '61A', tripId: 'next' });
  expect(reconcileVehicleSnapshot([newer], [bus(10_000)])).toEqual([newer]);
});

test('invalid positions are rejected individually and missing buses leave the snapshot', () => {
  const valid = bus(0, { vid: 'valid' });
  expect(
    reconcileVehicleSnapshot(
      [
        bus(0, { vid: 'bad', lat: NaN }),
        bus(0, { vid: 'bad2', lon: 181 }),
        valid
      ],
      [bus(0, { vid: 'gone' })]
    )
  ).toEqual([valid]);
});

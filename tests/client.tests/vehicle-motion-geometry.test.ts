import { VehicleMotionEstimator } from '../../client/scripts/services/vehicle-motion';
import type { IPattern, IStop, IVehicle } from '../../common/transit.interface';

const epoch = Date.parse('2026-10-24T12:00:00Z');
const latitude = 40.44;
const longitude = -79.94;
const latScale = 111_194.9266;
const lngScale = latScale * Math.cos((latitude * Math.PI) / 180);
const point = (x: number, y = 0) => ({
  lat: latitude + y / latScale,
  lng: longitude + x / lngScale
});
const xOf = (position: { lng: number }) =>
  (position.lng - longitude) * lngScale;
const at = (seconds: number) => epoch + seconds * 1000;
const shape = (): IPattern => ({
  shapeId: 'main',
  direction: 'OUTBOUND',
  path: [point(0), point(2000)]
});
const stop = (x: number): IStop => ({
  stopId: 'next',
  stopName: 'Next',
  lat: point(x).lat,
  lon: point(x).lng,
  dtradd: [],
  dtrrem: []
});
const bus = (seconds: number, x: number): IVehicle => ({
  vid: 'bus',
  routeId: 'R',
  tripId: 'trip',
  shapeId: 'main',
  direction: 'OUTBOUND',
  lat: point(x).lat,
  lon: point(x).lng,
  speed: 10,
  heading: 90,
  source: 'live',
  lastUpdate: new Date(at(seconds)).toISOString(),
  isDetoured: false
});

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(at(20));
});
afterEach(() => jest.useRealTimers());

function moving(stops: IStop[] = []) {
  const estimator = new VehicleMotionEstimator();
  const patterns = [shape()];
  estimator.setRouteGeometry('R', patterns, stops);
  estimator.ingest(bus(0, 0), at(0));
  estimator.ingest(bus(10, 100), at(10));
  return { estimator, patterns };
}

test('identical stop data in a fresh array preserves moving progress and correction', () => {
  const { estimator, patterns } = moving([stop(500)]);
  const before = estimator.estimate('bus', at(20))!;
  estimator.setRouteGeometry('R', patterns, [
    { ...stop(500), stopName: 'Renamed stop' }
  ]);
  expect(estimator.estimate('bus', at(20))).toEqual(before);
  estimator.ingest(bus(10, 100), at(20));
  expect(xOf(estimator.estimate('bus', at(30))!.position)).toBeGreaterThan(
    xOf(before.position)
  );
});

test('late stop hydration keeps displayed position continuous and retains motion history', () => {
  const { estimator, patterns } = moving();
  const before = estimator.estimate('bus', at(20))!;
  estimator.setRouteGeometry('R', patterns, [stop(160)]);
  expect(estimator.estimate('bus', at(20))!.position).toEqual(before.position);
  expect(estimator.estimate('bus', at(20))!.sourceTimestamp).toBe(at(10));
  estimator.ingest(bus(10, 100), at(20));
  const after = estimator.estimate('bus', at(30))!;
  expect(after.moving).toBe(true);
  expect(xOf(after.position)).toBeGreaterThan(xOf(before.position));
  estimator.ingest(bus(30, 300), at(30));
  expect(estimator.estimate('bus', at(35))!.moving).toBe(true);
});

test('updated stop coordinates invalidate cached stop projections', () => {
  const { estimator, patterns } = moving([stop(500)]);
  estimator.setRouteGeometry('R', patterns, [stop(160)]);
  const changed = estimator.estimate('bus', at(30))!;
  const reference = moving([stop(160)]).estimator.estimate('bus', at(30))!;
  expect(xOf(changed.position)).toBeCloseTo(xOf(reference.position), 4);
});

test('replacement shapes re-match the observation and slide from the displayed point', () => {
  const { estimator } = moving();
  const before = estimator.estimate('bus', at(20))!;
  estimator.setRouteGeometry(
    'R',
    [{ ...shape(), path: [point(0), point(1000), point(2000, 100)] }],
    []
  );
  expect(estimator.estimate('bus', at(20))!.position).toEqual(before.position);
  const midway = estimator.estimate('bus', at(21))!;
  expect(xOf(midway.position)).toBeGreaterThan(100);
  expect(xOf(midway.position)).toBeLessThan(xOf(before.position));
  const settled = estimator.estimate('bus', at(25))!;
  expect(xOf(settled.position)).toBeCloseTo(100, 4);
  expect(settled.rawPosition).toEqual(point(100));
  expect(settled.sourceTimestamp).toBe(at(10));
  estimator.ingest(bus(30, 300), at(30));
  expect(estimator.estimate('bus', at(35))!.moving).toBe(true);
});

test('stop and shape updates preserve the displayed point during an outage', () => {
  const { estimator, patterns } = moving();
  const before = estimator.estimate('bus', at(20))!;
  estimator.pause('bus', before.position, at(20));
  estimator.setRouteGeometry('R', patterns, [stop(160)]);
  estimator.setRouteGeometry('R', [shape()], [stop(160)]);
  expect(estimator.estimate('bus', at(40))!.position).toEqual(before.position);
  expect(estimator.estimate('bus', at(40))!.moving).toBe(false);
});

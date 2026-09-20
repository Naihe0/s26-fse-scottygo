import {
  VehicleMotionEstimator,
  VEHICLE_MOTION_LIMITS
} from '../../client/scripts/services/vehicle-motion';
import type { IPattern, IStop, IVehicle } from '../../common/transit.interface';
import type { ILatLng } from '../../common/map.interface';

const epoch = Date.parse('2026-09-19T12:00:00Z');
const latitude = 40.44;
const longitude = -79.94;
const latScale = 111_194.9266;
const lngScale = latScale * Math.cos((latitude * Math.PI) / 180);
const point = (x: number, y = 0): ILatLng => ({
  lat: latitude + y / latScale,
  lng: longitude + x / lngScale
});
const xy = (position: ILatLng) => ({
  x: (position.lng - longitude) * lngScale,
  y: (position.lat - latitude) * latScale
});
const at = (seconds: number) => epoch + seconds * 1_000;
function vehicle(
  seconds: number,
  x: number,
  y = 0,
  extra: Partial<IVehicle> = {}
): IVehicle {
  const position = point(x, y);
  return {
    vid: 'bus',
    routeId: 'R',
    tripId: 'trip',
    shapeId: 'main',
    direction: 'OUTBOUND',
    lat: position.lat,
    lon: position.lng,
    heading: 90,
    speed: 10,
    source: 'live',
    lastUpdate: new Date(at(seconds)).toISOString(),
    isDetoured: false,
    ...extra
  };
}
const shape = (
  path: ILatLng[] = [point(0), point(2_000)],
  shapeId = 'main',
  direction = 'OUTBOUND'
): IPattern => ({ shapeId, direction, path });
const stop = (id: string, x: number, y = 0): IStop => ({
  stopId: id,
  stopName: id,
  lat: point(x, y).lat,
  lon: point(x, y).lng,
  dtradd: [],
  dtrrem: []
});
function moving(
  patterns: IPattern[] = [shape()],
  stops: IStop[] = [],
  extra: Partial<IVehicle> = {}
): VehicleMotionEstimator {
  const estimator = new VehicleMotionEstimator();
  estimator.setRouteGeometry('R', patterns, stops);
  estimator.ingest(vehicle(0, 0, 0, extra), at(0));
  estimator.ingest(vehicle(10, 100, 0, extra), at(10));
  return estimator;
}

describe('bounded source-time vehicle motion', () => {
  test('a single high-speed sample never creates a velocity history', () => {
    const estimator = new VehicleMotionEstimator();
    estimator.setRouteGeometry('R', [shape()], []);
    estimator.ingest(vehicle(0, 100, 0, { speed: 30 }), at(0));
    expect(estimator.estimate('bus', at(15))).toMatchObject({
      position: point(100),
      rawPosition: point(100),
      estimated: false,
      moving: false,
      sourceTimestamp: at(0),
      ageMs: 15_000
    });
    expect(estimator.hasActiveMotion(at(15))).toBe(false);
  });

  test('fuses observed and feed speeds conservatively instead of trusting a fast feed value', () => {
    const slower = moving(undefined, [], { speed: 3 });
    expect(xy(slower.estimate('bus', at(20))!.position).x).toBeCloseTo(130, 1);
    const faster = moving(undefined, [], { speed: 30 });
    expect(xy(faster.estimate('bus', at(20))!.position).x).toBeCloseTo(200, 1);
    const observedOnly = moving(undefined, [], { speed: undefined });
    expect(xy(observedOnly.estimate('bus', at(20))!.position).x).toBeCloseTo(
      180,
      1
    );
  });

  test('forecasts follow a right-angle route bend and update heading, never cutting the corner', () => {
    const estimator = new VehicleMotionEstimator();
    estimator.setRouteGeometry(
      'R',
      [shape([point(0), point(150), point(150, 500)])],
      []
    );
    estimator.ingest(vehicle(0, 50, 0, { speed: 5 }), at(0));
    estimator.ingest(vehicle(10, 100, 0, { speed: 5 }), at(10));
    const result = estimator.estimate('bus', at(30))!;
    expect(xy(result.position).x).toBeCloseTo(150, 1);
    expect(xy(result.position).y).toBeCloseTo(45, 1);
    expect(result.heading).toBeCloseTo(0, 1);
    expect(result.estimated).toBe(true);
    expect(result.rawPosition).toEqual(point(100));
  });

  test('prediction decays and stops at both its distance and time bounds through a long outage', () => {
    const estimator = moving();
    const final = estimator.estimate('bus', at(70))!;
    expect(xy(final.position).x).toBeCloseTo(
      100 + VEHICLE_MOTION_LIMITS.maximumDistance,
      1
    );
    expect(estimator.estimate('bus', at(600))!.position).toEqual(
      final.position
    );
    expect(estimator.estimate('bus', at(600))).toMatchObject({
      moving: false,
      freshness: 'stale',
      confidence: 0
    });
    expect(estimator.hasActiveMotion(at(70))).toBe(false);
    const slow = moving(undefined, [], { speed: 1 });
    expect(xy(slow.estimate('bus', at(70))!.position).x).toBeCloseTo(135, 1);
    expect(slow.estimate('bus', at(80))!.position).toEqual(
      slow.estimate('bus', at(70))!.position
    );
  });

  test('late snapshots keep their source age and can never be promoted to fresh by duplicate polling', () => {
    const estimator = moving();
    const before = estimator.estimate('bus', at(50))!;
    estimator.ingest(vehicle(10, 999, 0, { speed: 35 }), at(50));
    expect(estimator.estimate('bus', at(50))).toEqual(before);
    expect(before).toMatchObject({
      sourceTimestamp: at(10),
      ageMs: 40_000,
      freshness: 'aging',
      rawPosition: point(100)
    });
  });

  test('out-of-order positions cannot rewind a trip or manufacture velocity', () => {
    const estimator = moving();
    const before = estimator.estimate('bus', at(30));
    estimator.ingest(
      vehicle(5, 1_500, 0, { tripId: 'old-trip', routeId: 'old-route' }),
      at(30)
    );
    expect(estimator.estimate('bus', at(30))).toEqual(before);
  });

  test('jitter and feed speed cannot manufacture travel when GPS has barely moved', () => {
    const estimator = new VehicleMotionEstimator();
    estimator.setRouteGeometry('R', [shape()], []);
    estimator.ingest(vehicle(0, 100), at(0));
    estimator.ingest(vehicle(10, 103, 2), at(10));
    expect(estimator.estimate('bus', at(20))).toMatchObject({
      position: point(103, 2),
      estimated: false,
      moving: false
    });
  });

  test('a teleport snaps to the reported point without animating the jump or extrapolating it', () => {
    const estimator = moving();
    estimator.ingest(vehicle(12, 1_500), at(12));
    expect(estimator.estimate('bus', at(12))).toMatchObject({
      position: point(1_500),
      estimated: false,
      moving: false
    });
    expect(estimator.estimate('bus', at(40))!.position).toEqual(point(1_500));
  });

  test('an implausible acceleration resets velocity even below the absolute speed limit', () => {
    const estimator = moving();
    estimator.ingest(vehicle(12, 160, 0, { speed: 30 }), at(12));
    expect(estimator.estimate('bus', at(20))).toMatchObject({
      position: point(160),
      moving: false,
      estimated: false
    });
  });

  test('subsecond timestamps still reject a teleport instead of treating it as a local correction', () => {
    const estimator = moving();
    estimator.ingest(vehicle(10.5, 190), at(10.5));
    expect(estimator.estimate('bus', at(10.5))).toMatchObject({
      position: point(190),
      moving: false,
      estimated: false
    });
  });

  test('long gaps discard stale speed evidence', () => {
    const estimator = moving();
    estimator.ingest(vehicle(200, 500), at(200));
    expect(estimator.estimate('bus', at(205))).toMatchObject({
      position: point(500),
      moving: false,
      estimated: false
    });
  });

  test.each(['tripId', 'routeId', 'direction', 'shapeId'] as const)(
    '%s changes reset journey continuity',
    (field) => {
      const estimator = moving();
      estimator.ingest(vehicle(20, 150, 0, { [field]: 'different' }), at(20));
      expect(estimator.estimate('bus', at(30))).toMatchObject({
        position: point(150),
        moving: false,
        estimated: false
      });
    }
  );

  test.each(['not-a-date', new Date(at(120)).toISOString()])(
    'unknown/future source time remains stale: %s',
    (lastUpdate) => {
      const estimator = new VehicleMotionEstimator();
      estimator.ingest(vehicle(0, 100, 0, { lastUpdate }), at(0));
      expect(estimator.estimate('bus', at(10))).toMatchObject({
        position: point(100),
        sourceTimestamp: null,
        ageMs: null,
        confidence: 0,
        freshness: 'stale',
        estimated: false
      });
    }
  );

  test('invalid coordinates never poison the current estimate', () => {
    const estimator = moving();
    const before = estimator.estimate('bus', at(30));
    estimator.ingest(vehicle(20, 120, 0, { lat: NaN }), at(20));
    estimator.ingest(vehicle(20, 120, 0, { lon: 181 }), at(20));
    expect(estimator.estimate('bus', at(30))).toEqual(before);
  });
});

describe('stop and geometry safeguards', () => {
  test.each([
    { currentStatus: 'STOPPED_AT' as const },
    { speed: 0 },
    { currentStatus: 'INCOMING_AT' as const, currentStopId: 'near' }
  ])('does not predict through a stop: %j', (status) => {
    const estimator = moving(undefined, [stop('near', 118)], status);
    expect(estimator.estimate('bus', at(20))).toMatchObject({
      position: point(100),
      estimated: false,
      moving: false
    });
  });

  test('a known next stop caps progress before the stop', () => {
    const estimator = moving(undefined, [stop('next', 150)], {
      currentStatus: 'IN_TRANSIT_TO',
      currentStopId: 'next'
    });
    expect(xy(estimator.estimate('bus', at(30))!.position).x).toBeCloseTo(
      142,
      1
    );
    expect(estimator.hasActiveMotion(at(30))).toBe(false);
  });

  test('an already passed currentStopId cannot bypass the nearest upcoming stop', () => {
    const estimator = moving(
      undefined,
      [stop('behind', 50), stop('next', 140)],
      { currentStopId: 'behind', currentStatus: 'IN_TRANSIT_TO' }
    );
    expect(xy(estimator.estimate('bus', at(30))!.position).x).toBeCloseTo(
      132,
      1
    );
  });

  test('a mapped stop only five meters ahead also halts prediction when stop metadata is absent', () => {
    const estimator = moving(undefined, [stop('close', 105)]);
    expect(xy(estimator.estimate('bus', at(30))!.position).x).toBeCloseTo(
      100,
      1
    );
    expect(estimator.hasActiveMotion(at(30))).toBe(false);
  });

  test('route terminals are hard prediction limits', () => {
    const estimator = moving([shape([point(0), point(150)])]);
    expect(xy(estimator.estimate('bus', at(30))!.position).x).toBeCloseTo(
      150,
      1
    );
    expect(estimator.hasActiveMotion(at(30))).toBe(false);
  });

  test.each([
    'missing',
    'off-route',
    'detoured',
    'unknown-shape',
    'wrong-heading',
    'wrong-direction'
  ])('no forward prediction with %s geometry evidence', (kind) => {
    const estimator = new VehicleMotionEstimator();
    if (kind !== 'missing') estimator.setRouteGeometry('R', [shape()], []);
    const extra: Partial<IVehicle> =
      kind === 'detoured'
        ? { isDetoured: true }
        : kind === 'unknown-shape'
          ? { shapeId: 'missing' }
          : kind === 'wrong-heading'
            ? { heading: 270 }
            : kind === 'wrong-direction'
              ? { direction: 'INBOUND' }
              : {};
    const y = kind === 'off-route' ? 100 : 0;
    estimator.ingest(vehicle(0, 50, y, extra), at(0));
    estimator.ingest(vehicle(10, 100, y, extra), at(10));
    expect(estimator.estimate('bus', at(20))).toMatchObject({
      position: point(100, y),
      estimated: false,
      moving: false
    });
  });

  test('overlapping same-direction variants remain ambiguous without exact shape metadata', () => {
    const variants = [
      shape([point(0), point(150), point(150, 500)], 'north'),
      shape([point(0), point(150), point(150, -500)], 'south')
    ];
    const unknown = moving(variants, [], { shapeId: undefined });
    expect(unknown.estimate('bus', at(25))).toMatchObject({
      position: point(100),
      moving: false,
      estimated: false
    });
    const exact = moving(variants, [], { shapeId: 'north' });
    const predicted = xy(exact.estimate('bus', at(25))!.position);
    expect(predicted.x).toBeCloseTo(150, 1);
    expect(predicted.y).toBeGreaterThan(80);
  });

  test('source history disambiguates a repeated same-heading leg of a loop', () => {
    const estimator = new VehicleMotionEstimator();
    estimator.setRouteGeometry(
      'R',
      [
        shape([
          point(-300),
          point(300),
          point(300, 200),
          point(0, 200),
          point(0),
          point(300)
        ])
      ],
      []
    );
    estimator.ingest(vehicle(0, -100, 0, { speed: 11 }), at(0));
    estimator.ingest(vehicle(10, 10, 0, { speed: 11 }), at(10));
    const result = estimator.estimate('bus', at(20))!;
    expect(xy(result.position).x).toBeCloseTo(120, 1);
    expect(xy(result.position).y).toBeCloseTo(0, 1);
    expect(result.estimated).toBe(true);
  });

  test('a self intersection with no distinguishing history stays at the reported point', () => {
    const estimator = moving([
      shape([
        point(0),
        point(400),
        point(400, 200),
        point(0, 200),
        point(0),
        point(400),
        point(800)
      ])
    ]);
    expect(estimator.estimate('bus', at(30))).toMatchObject({
      position: point(100),
      moving: false,
      estimated: false
    });
  });

  test('observed heading resolves a crossing when feed heading is absent', () => {
    const estimator = new VehicleMotionEstimator();
    estimator.setRouteGeometry(
      'R',
      [
        shape([
          point(-200),
          point(200),
          point(200, 200),
          point(0, 200),
          point(0, -200)
        ])
      ],
      []
    );
    estimator.ingest(
      vehicle(0, -100, 0, { heading: undefined, speed: 9 }),
      at(0)
    );
    estimator.ingest(
      vehicle(10, -10, 0, { heading: undefined, speed: 9 }),
      at(10)
    );
    const result = xy(estimator.estimate('bus', at(20))!.position);
    expect(result.x).toBeCloseTo(80, 1);
    expect(result.y).toBeCloseTo(0, 1);
  });
});

describe('single-marker reconciliation and cached geometry', () => {
  test('small raw corrections slide even without any forecast geometry, then settle at actual GPS', () => {
    const estimator = new VehicleMotionEstimator();
    estimator.ingest(vehicle(0, 0), at(0));
    estimator.ingest(vehicle(10, 30), at(10));
    expect(xy(estimator.estimate('bus', at(10))!.position).x).toBeCloseTo(0, 1);
    expect(xy(estimator.estimate('bus', at(10.3))!.position).x).toBeCloseTo(
      15,
      1
    );
    expect(estimator.estimate('bus', at(11))).toMatchObject({
      position: point(30),
      estimated: false,
      moving: false
    });
  });

  test('a stopped report reconciles the previous forecast back to the actual point', () => {
    const estimator = moving();
    const before = estimator.estimate('bus', at(15))!.position;
    estimator.ingest(
      vehicle(15, 120, 0, { currentStatus: 'STOPPED_AT', speed: 0 }),
      at(15)
    );
    expect(estimator.estimate('bus', at(15))!.position).toEqual(before);
    expect(estimator.estimate('bus', at(18))).toMatchObject({
      position: point(120),
      estimated: false,
      moving: false
    });
  });

  test('correction across a corner follows route geometry and is continuous at completion', () => {
    const estimator = new VehicleMotionEstimator();
    estimator.setRouteGeometry(
      'R',
      [shape([point(0), point(150), point(150, 500)])],
      []
    );
    estimator.ingest(vehicle(0, 50, 0, { speed: 5 }), at(0));
    estimator.ingest(vehicle(10, 100, 0, { speed: 5 }), at(10));
    const before = estimator.estimate('bus', at(30))!.position;
    estimator.ingest(vehicle(30, 150, 30, { speed: 4, heading: 0 }), at(30));
    expect(estimator.estimate('bus', at(30))!.position).toEqual(before);
    const mid = xy(estimator.estimate('bus', at(30.3))!.position);
    expect(mid.x).toBeCloseTo(150, 1);
    expect(mid.y).toBeGreaterThan(30);
    expect(mid.y).toBeLessThan(45);
    const end = xy(estimator.estimate('bus', at(30.6))!.position);
    const next = xy(estimator.estimate('bus', at(30.601))!.position);
    expect(Math.abs(next.y - end.y)).toBeLessThan(0.02);
    expect(next.x).toBeCloseTo(end.x, 5);
  });

  test('duplicate safety status may stop a forecast but does not restamp its location', () => {
    const estimator = moving();
    estimator.ingest(
      vehicle(10, 100, 0, { currentStatus: 'STOPPED_AT', speed: 0 }),
      at(20)
    );
    expect(estimator.estimate('bus', at(23))).toMatchObject({
      position: point(100),
      sourceTimestamp: at(10),
      ageMs: 13_000,
      estimated: false,
      moving: false
    });
  });

  test('removal/clear release history but preserve cached route geometry', () => {
    const estimator = moving();
    estimator.remove('bus');
    expect(estimator.estimate('bus', at(20))).toBeNull();
    estimator.ingest(vehicle(0, 0), at(0));
    estimator.clear();
    expect(estimator.hasActiveMotion(at(20))).toBe(false);
    estimator.ingest(vehicle(0, 0), at(0));
    estimator.ingest(vehicle(10, 100), at(10));
    expect(estimator.estimate('bus', at(20))!.estimated).toBe(true);
  });

  test('bulk registration reads no paths, and unrelated shape variants are never compiled', () => {
    const estimator = new VehicleMotionEstimator();
    const unread: IPattern = {
      direction: 'OUTBOUND',
      shapeId: 'unused',
      get path(): ILatLng[] {
        throw new Error('Unused geometry must stay lazy');
      }
    };
    for (let index = 0; index < 100; index++)
      estimator.setRouteGeometry(String(index), [unread], []);
    const long = shape(
      Array.from({ length: 4_000 }, (_, index) => point(index * 2))
    );
    estimator.setRouteGeometry('R', [unread, long], []);
    estimator.ingest(vehicle(0, 1_000), at(0));
    estimator.ingest(vehicle(10, 1_100), at(10));
    const result = estimator.estimate('bus', at(20))!;
    expect(xy(result.position).x).toBeCloseTo(1_200, 1);
    expect(result.moving).toBe(true);
  });

  test('malformed route geometry is never bridged through missing or implausible segments', () => {
    const estimator = moving([
      shape([point(0), { lat: NaN, lng: 0 }, point(2_000)])
    ]);
    expect(estimator.estimate('bus', at(30))).toMatchObject({
      position: point(100),
      estimated: false
    });
    const huge = moving([shape([point(0), point(10_000)])]);
    expect(huge.estimate('bus', at(30))).toMatchObject({
      position: point(100),
      estimated: false
    });
  });
});

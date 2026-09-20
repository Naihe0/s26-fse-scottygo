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

describe('latency-aware, bounded vehicle motion', () => {
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
    expect(xy(result.position).y).toBeCloseTo(50, 1);
    expect(result.heading).toBeCloseTo(0, 1);
    expect(result.estimated).toBe(true);
    expect(result.rawPosition).toEqual(point(100));
  });

  test('a missed update decays to rest and remains there through a long outage', () => {
    const estimator = moving();
    const final = estimator.estimate('bus', at(70))!;
    expect(xy(final.position).x).toBeGreaterThan(300);
    expect(xy(final.position).x).toBeLessThan(
      100 + VEHICLE_MOTION_LIMITS.maximumDistance
    );
    const cruiseAdvance =
      xy(estimator.estimate('bus', at(25))!.position).x -
      xy(estimator.estimate('bus', at(24))!.position).x;
    const lateAdvance =
      xy(estimator.estimate('bus', at(55))!.position).x -
      xy(estimator.estimate('bus', at(54))!.position).x;
    expect(lateAdvance).toBeGreaterThan(0);
    expect(lateAdvance).toBeLessThan(cruiseAdvance / 2);
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
    expect(xy(slow.estimate('bus', at(70))!.position).x).toBeLessThan(200);
    expect(slow.estimate('bus', at(80))!.position).toEqual(
      slow.estimate('bus', at(70))!.position
    );
  });

  test('an 85-second-old first report moves every second without waiting for another packet', () => {
    const estimator = new VehicleMotionEstimator();
    estimator.setRouteGeometry('R', [shape()], []);
    estimator.ingest(vehicle(0, 100, 0, { speed: 6.7 }), at(85));
    const first = estimator.estimate('bus', at(85))!;
    expect(first.rawPosition).toEqual(point(100));
    expect(first.ageMs).toBe(85_000);
    expect(first.moving).toBe(true);
    expect(xy(first.position).x).toBeGreaterThan(500);
    for (let second = 86; second <= 115; second++) {
      const before = estimator.estimate('bus', at(second - 1))!;
      const current = estimator.estimate('bus', at(second))!;
      expect(xy(current.position).x - xy(before.position).x).toBeGreaterThan(5);
      expect(current.rawPosition).toEqual(point(100));
      expect(current.moving).toBe(true);
      expect(estimator.hasActiveMotion(at(second))).toBe(true);
    }
    expect(estimator.estimate('bus', at(115))!.freshness).toBe('stale');
  });

  test('the initial cadence prior spans a captured 90-second wait for the next distinct packet', () => {
    const estimator = new VehicleMotionEstimator();
    estimator.setRouteGeometry('R', [shape()], []);
    const report = vehicle(0, 100, 0, { speed: 6.7 });
    estimator.ingest(report, at(25));
    for (let receipt = 35; receipt <= 115; receipt += 10)
      estimator.ingest(report, at(receipt));
    for (let second = 26; second <= 115; second++) {
      expect(
        xy(estimator.estimate('bus', at(second))!.position).x
      ).toBeGreaterThan(
        xy(estimator.estimate('bus', at(second - 1))!.position).x
      );
    }
    expect(estimator.hasActiveMotion(at(180))).toBe(false);
  });

  test('a plausible 45mph express-bus first report starts motion with the modeled speed capped', () => {
    const estimator = new VehicleMotionEstimator();
    estimator.setRouteGeometry('R', [shape([point(0), point(4_000)])], []);
    estimator.ingest(vehicle(0, 100, 0, { speed: 20.1168 }), at(26));
    const before = estimator.estimate('bus', at(26))!;
    const after = estimator.estimate('bus', at(27))!;
    const delta = xy(after.position).x - xy(before.position).x;
    expect(delta).toBeGreaterThan(15);
    expect(delta).toBeLessThanOrEqual(20);
    expect(after.moving).toBe(true);
    estimator.ingest(vehicle(0, 100, 0, { vid: 'faster', speed: 25 }), at(26));
    expect(
      xy(estimator.estimate('faster', at(27))!.position).x -
        xy(estimator.estimate('faster', at(26))!.position).x
    ).toBeCloseTo(20, 1);
  });

  test('recently arriving distinct delayed reports sustain motion across repeated feed intervals', () => {
    const estimator = new VehicleMotionEstimator();
    estimator.setRouteGeometry('R', [shape([point(0), point(4_000)])], []);
    for (let sourceTime = 0; sourceTime <= 120; sourceTime += 30) {
      const receipt = sourceTime + 85;
      estimator.ingest(
        vehicle(sourceTime, 100 + sourceTime * 6.7, 0, {
          speed: 6.7
        }),
        at(receipt)
      );
      for (let offset = 4; offset < 30; offset++) {
        const previous = estimator.estimate('bus', at(receipt + offset - 1))!;
        const next = estimator.estimate('bus', at(receipt + offset))!;
        expect(xy(next.position).x).toBeGreaterThan(xy(previous.position).x);
        expect(next.moving).toBe(true);
      }
    }
  });

  test('a fast report with 120 seconds of latency still has a useful continuation window', () => {
    const estimator = new VehicleMotionEstimator();
    estimator.setRouteGeometry('R', [shape([point(0), point(4_000)])], []);
    estimator.ingest(vehicle(0, 0, 0, { speed: 20 }), at(120));
    for (let second = 121; second <= 150; second++) {
      expect(
        xy(estimator.estimate('bus', at(second))!.position).x
      ).toBeGreaterThan(
        xy(estimator.estimate('bus', at(second - 1))!.position).x
      );
    }
    expect(estimator.hasActiveMotion(at(180))).toBe(false);
    expect(estimator.estimate('bus', at(180))!.position).toEqual(
      estimator.estimate('bus', at(600))!.position
    );
  });

  test('duplicate HTTP polling cannot renew the motion window of a frozen source', () => {
    const estimator = new VehicleMotionEstimator();
    estimator.setRouteGeometry('R', [shape()], []);
    const report = vehicle(0, 100, 0, { speed: 6.7 });
    estimator.ingest(report, at(85));
    for (let receipt = 95; receipt <= 205; receipt += 10)
      estimator.ingest(report, at(receipt));
    expect(estimator.estimate('bus', at(180))!.moving).toBe(false);
    expect(estimator.estimate('bus', at(180))!.position).toEqual(
      estimator.estimate('bus', at(500))!.position
    );
    expect(estimator.estimate('bus', at(205))!.sourceTimestamp).toBe(at(0));
  });

  test.each([
    { shapeId: undefined },
    { heading: undefined },
    { speed: undefined },
    { speed: 0.4 }
  ])(
    'first-sample motion requires credible independent evidence: %j',
    (extra) => {
      const estimator = new VehicleMotionEstimator();
      estimator.setRouteGeometry('R', [shape()], []);
      estimator.ingest(vehicle(0, 100, 0, extra), at(85));
      expect(estimator.estimate('bus', at(90))).toMatchObject({
        position: point(100),
        moving: false,
        estimated: false
      });
    }
  );

  test('a newly received report already more than two minutes old cannot restart prediction', () => {
    const estimator = new VehicleMotionEstimator();
    estimator.setRouteGeometry('R', [shape()], []);
    estimator.ingest(vehicle(0, 100, 0, { speed: 6.7 }), at(121));
    expect(estimator.estimate('bus', at(130))).toMatchObject({
      position: point(100),
      moving: false,
      estimated: false,
      freshness: 'stale'
    });
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
  test.each([{ currentStatus: 'STOPPED_AT' as const }, { speed: 0 }])(
    'does not predict through a stop: %j',
    (status) => {
      const estimator = moving(undefined, [stop('near', 118)], status);
      expect(estimator.estimate('bus', at(20))).toMatchObject({
        position: point(100),
        estimated: false,
        moving: false
      });
    }
  );

  test('an announced next stop decelerates, dwells briefly, then resumes the same route', () => {
    const estimator = moving(undefined, [stop('next', 150)], {
      currentStatus: 'IN_TRANSIT_TO',
      currentStopId: 'next'
    });
    const arriving = xy(estimator.estimate('bus', at(16))!.position).x;
    expect(arriving).toBeGreaterThan(145);
    expect(arriving).toBeLessThan(150);
    expect(xy(estimator.estimate('bus', at(18))!.position).x).toBeCloseTo(
      150,
      1
    );
    expect(xy(estimator.estimate('bus', at(23))!.position).x).toBeCloseTo(
      150,
      1
    );
    expect(estimator.hasActiveMotion(at(20))).toBe(true);
    expect(xy(estimator.estimate('bus', at(30))!.position).x).toBeGreaterThan(
      180
    );
  });

  test('an approaching report with positive speed does not remain frozen near a stop', () => {
    const estimator = moving(undefined, [stop('near', 118)], {
      currentStopId: 'near',
      currentStatus: 'INCOMING_AT'
    });
    expect(xy(estimator.estimate('bus', at(15))!.position).x).toBeCloseTo(
      118,
      1
    );
    expect(xy(estimator.estimate('bus', at(30))!.position).x).toBeGreaterThan(
      180
    );
  });

  test('an already passed currentStopId still accounts for the nearest upcoming mapped stop', () => {
    const estimator = moving(
      undefined,
      [stop('behind', 50), stop('next', 140)],
      { currentStopId: 'behind', currentStatus: 'IN_TRANSIT_TO' }
    );
    const withoutStops = moving();
    const slowed = xy(estimator.estimate('bus', at(15))!.position).x;
    expect(slowed).toBeLessThan(
      xy(withoutStops.estimate('bus', at(15))!.position).x
    );
    expect(slowed).toBeGreaterThan(130);
    expect(xy(estimator.estimate('bus', at(30))!.position).x).toBeGreaterThan(
      200
    );
  });

  test('a nearby mapped stop slows the estimate without manufacturing an indefinite stop', () => {
    const estimator = moving(undefined, [stop('close', 105)]);
    expect(xy(estimator.estimate('bus', at(12))!.position).x).toBeLessThan(120);
    expect(xy(estimator.estimate('bus', at(30))!.position).x).toBeGreaterThan(
      200
    );
    expect(estimator.hasActiveMotion(at(30))).toBe(true);
  });

  test('nearby duplicate stop poles do not create repeated boarding dwells', () => {
    const single = moving(undefined, [stop('next', 150)], {
      currentStopId: 'next',
      currentStatus: 'IN_TRANSIT_TO'
    });
    const duplicate = moving(
      undefined,
      [stop('other', 148), stop('next', 150), stop('third', 151)],
      {
        currentStopId: 'next',
        currentStatus: 'IN_TRANSIT_TO'
      }
    );
    expect(xy(duplicate.estimate('bus', at(30))!.position).x).toBeCloseTo(
      xy(single.estimate('bus', at(30))!.position).x,
      1
    );
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
  test('an outage freezes the displayed point, and cached snapshots cannot restart it', () => {
    const estimator = new VehicleMotionEstimator();
    estimator.setRouteGeometry('R', [shape()], []);
    const report = vehicle(0, 100, 0, { speed: 6.7 });
    estimator.ingest(report, at(85));
    const displayed = estimator.estimate('bus', at(109.95))!.position;
    estimator.pause('bus', displayed, at(110));
    estimator.ingest(report, at(120));
    expect(estimator.estimate('bus', at(120))).toMatchObject({
      position: displayed,
      rawPosition: point(100),
      moving: false,
      sourceTimestamp: at(0),
      confidence: 0
    });
    expect(estimator.hasActiveMotion(at(120))).toBe(false);
    estimator.ingest(vehicle(30, 300, 0, { speed: 6.7 }), at(125));
    expect(estimator.estimate('bus', at(125))!.position).toEqual(displayed);
    expect(xy(estimator.estimate('bus', at(129))!.position).x).toBeGreaterThan(
      xy(displayed).x
    );
    expect(estimator.estimate('bus', at(129))!.rawPosition).toEqual(point(300));
    expect(estimator.hasActiveMotion(at(129))).toBe(true);
  });

  test('pausing midway through a correction retains that exact displayed point', () => {
    const estimator = new VehicleMotionEstimator();
    estimator.setRouteGeometry('R', [shape()], []);
    estimator.ingest(vehicle(0, 100, 0, { speed: 6.7 }), at(85));
    estimator.ingest(vehicle(30, 130, 0, { speed: 1 }), at(115));
    const halfway = estimator.estimate('bus', at(117))!.position;
    estimator.pause('bus', undefined, at(117));
    expect(estimator.estimate('bus', at(130))!.position).toEqual(halfway);
    expect(estimator.hasActiveMotion(at(130))).toBe(false);
    estimator.ingest(vehicle(60, 160, 0, { speed: 1 }), at(145));
    expect(estimator.estimate('bus', at(145))!.position).toEqual(halfway);
    const correcting = xy(estimator.estimate('bus', at(147))!.position).x;
    expect(correcting).toBeLessThan(xy(halfway).x);
    expect(correcting).toBeGreaterThan(245);
  });

  test('a delayed stopped report slides a long forecast back to the actual GPS fix', () => {
    const estimator = new VehicleMotionEstimator();
    estimator.setRouteGeometry('R', [shape([point(0), point(4_000)])], []);
    estimator.ingest(vehicle(0, 100, 0, { speed: 15 }), at(85));
    const before = estimator.estimate('bus', at(115))!.position;
    estimator.ingest(
      vehicle(30, 130, 0, {
        speed: 0,
        currentStatus: 'STOPPED_AT'
      }),
      at(115)
    );
    expect(estimator.estimate('bus', at(115))!.position).toEqual(before);
    expect(xy(estimator.estimate('bus', at(117))!.position).x).toBeGreaterThan(
      130
    );
    expect(estimator.estimate('bus', at(119))).toMatchObject({
      position: point(130),
      moving: false,
      estimated: false
    });
  });

  test('an ordinary delayed slowdown slides a large prediction error back along the route', () => {
    const estimator = new VehicleMotionEstimator();
    estimator.setRouteGeometry('R', [shape()], []);
    estimator.ingest(vehicle(0, 100, 0, { speed: 6.7 }), at(85));
    const before = estimator.estimate('bus', at(115))!;
    estimator.ingest(vehicle(30, 130, 0, { speed: 1 }), at(115));
    expect(estimator.estimate('bus', at(115))!.position).toEqual(
      before.position
    );
    const midway = xy(estimator.estimate('bus', at(117))!.position).x;
    expect(midway).toBeLessThan(xy(before.position).x);
    expect(midway).toBeGreaterThan(220);
    const end = xy(estimator.estimate('bus', at(119))!.position).x;
    const after = xy(estimator.estimate('bus', at(119.001))!.position).x;
    expect(end).toBeCloseTo(219, 1);
    expect(Math.abs(after - end)).toBeLessThan(0.02);
    expect(estimator.estimate('bus', at(119))!.rawPosition).toEqual(point(130));
  });

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

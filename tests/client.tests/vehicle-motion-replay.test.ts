import { VehicleMotionEstimator } from '../../client/scripts/services/vehicle-motion';
import type { IVehicle } from '../../common/transit.interface';
import {
  motionReplayScenarios,
  replayTime,
  runMotionReplay
} from '../../tools/vehicle-motion-replay-fixtures';

const latScale = 111_194.9266;
const lngScale = latScale * Math.cos((40.44 * Math.PI) / 180);
const point = (x: number, y = 0) => ({
  lat: 40.44 + y / latScale,
  lng: -79.94 + x / lngScale
});
const meters = (position: { lat: number; lng: number }) => ({
  x: (position.lng + 79.94) * lngScale,
  y: (position.lat - 40.44) * latScale
});
function packet(
  second: number,
  x: number,
  speed = 8,
  y = 0,
  extra: Partial<IVehicle> = {}
): IVehicle {
  return {
    vid: 'bus',
    routeId: 'R',
    tripId: 'trip',
    shapeId: 'main',
    direction: 'OUTBOUND',
    source: 'live',
    isDetoured: false,
    lat: point(x, y).lat,
    lon: point(x, y).lng,
    speed,
    heading: 90,
    lastUpdate: new Date(replayTime(second)).toISOString(),
    ...extra
  };
}
function track(): VehicleMotionEstimator {
  const estimator = new VehicleMotionEstimator();
  estimator.setRouteGeometry(
    'R',
    [
      { shapeId: 'main', direction: 'OUTBOUND', path: [point(0), point(4_500)] }
    ],
    []
  );
  estimator.ingest(packet(0, 100), replayTime(0));
  estimator.ingest(packet(10, 180), replayTime(10));
  return estimator;
}

describe('vehicle movement replay acceptance', () => {
  const replays = motionReplayScenarios();
  const result = (name: string) =>
    runMotionReplay(
      () => new VehicleMotionEstimator(),
      replays.find((replay) => replay.name === name)!
    );

  test('a delayed but steadily moving bus keeps moving and remains close to the controlled truth', () => {
    const metrics = result('steady-delayed');
    expect(metrics.meanPositionErrorMeters).toBeLessThan(20);
    expect(metrics.reverseTravelMeters).toBeLessThan(0.1);
    expect(metrics.movingFreezeSeconds).toBeLessThan(1);
    expect(metrics.maxFrameTravelMeters).toBeLessThan(5);
  });

  test('slow traffic with GPS noise avoids repeated reversal and long freezes', () => {
    const metrics = result('slow-gps-jitter');
    expect(metrics.reverseTravelMeters).toBeLessThan(20);
    expect(metrics.movingFreezeSeconds).toBeLessThan(20);
    expect(metrics.p95PositionErrorMeters).toBeLessThan(35);
  });

  test('one corrupt kilometre-scale fix cannot fling the marker away and back', () => {
    const metrics = result('isolated-teleport');
    expect(metrics.maxFrameTravelMeters).toBeLessThan(5);
    expect(metrics.reverseTravelMeters).toBeLessThan(1);
    expect(metrics.meanPositionErrorMeters).toBeLessThan(20);
    expect(metrics.movingFreezeSeconds).toBeLessThan(1);
  });

  test('a corner remains on the road and duplicate timestamps never run backwards', () => {
    const bend = result('right-angle-bend');
    expect(bend.maxCrossTrackMeters).toBeLessThan(0.1);
    expect(bend.reverseTravelMeters).toBeLessThan(0.1);
    expect(bend.meanPositionErrorMeters).toBeLessThan(10);
    const duplicates = result('duplicates-and-out-of-order');
    expect(duplicates.timestampRegressions).toBe(0);
    expect(duplicates.movingFreezeSeconds).toBeLessThan(1);
    expect(duplicates.maxFrameTravelMeters).toBeLessThan(5);
  });

  test('GPS updates without trusted geometry slide instead of jumping', () => {
    expect(result('missing-geometry').maxFrameTravelMeters).toBeLessThan(5);
  });

  test('a delayed stop and restart still converge to the current measured journey', () => {
    const metrics = result('stop-and-restart');
    expect(metrics.p95PositionErrorMeters).toBeLessThan(70);
    expect(metrics.finalPositionErrorMeters).toBeLessThan(1);
    expect(metrics.maxFrameTravelMeters).toBeLessThan(5);
  });

  test.each(replays.map((replay) => [replay.name, replay] as const))(
    '%s always retains a finite marker and monotonic source time',
    (_name, replay) => {
      const metrics = runMotionReplay(
        () => new VehicleMotionEstimator(),
        replay
      );
      expect(metrics.timestampRegressions).toBe(0);
      expect(Number.isFinite(metrics.meanPositionErrorMeters)).toBe(true);
    }
  );
});

describe('new-fix reconciliation and interruption recovery', () => {
  test('unchanged GPS cannot manufacture continued travel from a stale positive speed', () => {
    const estimator = track();
    estimator.ingest(
      packet(20, 200, 0, 0, { currentStatus: 'STOPPED_AT' }),
      replayTime(20)
    );
    for (let second = 25; second <= 55; second += 5)
      estimator.ingest(
        packet(second, 200 + Math.min(second - 20, 15) * 1.2, 1.2),
        replayTime(second)
      );
    const stopped = estimator.estimate('bus', replayTime(65))!;
    expect(meters(stopped.position).x).toBeCloseTo(218, 2);
    expect(stopped.moving).toBe(false);
    expect(stopped.sourceTimestamp).toBe(replayTime(55));
    expect(estimator.hasActiveMotion(replayTime(65))).toBe(false);
  });

  test('more frequent fixes preserve motion in slow traffic and after a stop', () => {
    const estimator = track();
    estimator.ingest(
      packet(20, 200, 0, 0, { currentStatus: 'STOPPED_AT' }),
      replayTime(20)
    );
    for (let second = 25; second <= 50; second += 5)
      estimator.ingest(
        packet(second, 200 + (second - 20) * 1.2, 1.2),
        replayTime(second)
      );
    const before = estimator.estimate('bus', replayTime(50))!;
    const after = estimator.estimate('bus', replayTime(51))!;
    expect(after.moving).toBe(true);
    expect(
      meters(after.position).x - meters(before.position).x
    ).toBeGreaterThan(0.5);
    expect(meters(after.position).x).toBeGreaterThan(236);
  });

  test('a consistent one-second source stream does not disable prediction', () => {
    const estimator = track();
    for (let second = 11; second <= 15; second++)
      estimator.ingest(packet(second, 100 + second * 8), replayTime(second));
    const before = estimator.estimate('bus', replayTime(15))!;
    const after = estimator.estimate('bus', replayTime(16))!;
    expect(after.moving).toBe(true);
    expect(
      meters(after.position).x - meters(before.position).x
    ).toBeGreaterThan(5);
  });

  test('repeated stopped fixes suppress GPS wander without altering the raw measurement', () => {
    const estimator = track();
    estimator.ingest(
      packet(20, 200, 0, 0, { currentStatus: 'STOPPED_AT' }),
      replayTime(20)
    );
    for (let second = 30; second <= 120; second += 10) {
      const jitter = second % 20 ? -4 : 4;
      estimator.ingest(
        packet(second, 200 + jitter, 0, jitter, {
          currentStatus: 'STOPPED_AT'
        }),
        replayTime(second)
      );
      const estimate = estimator.estimate('bus', replayTime(second + 5))!;
      expect(meters(estimate.position).x).toBeCloseTo(200, 2);
      expect(meters(estimate.position).y).toBeCloseTo(0, 2);
      expect(meters(estimate.rawPosition).x).toBeCloseTo(200 + jitter, 2);
      expect(estimate.sourceTimestamp).toBe(replayTime(second));
    }
  });

  test('a small overshoot catches up by slowing down while measured travel continues', () => {
    const estimator = track();
    const before = estimator.estimate('bus', replayTime(20))!;
    estimator.ingest(packet(20, 240, 6), replayTime(20));
    expect(estimator.estimate('bus', replayTime(20))!.position).toEqual(
      before.position
    );
    let previous = meters(before.position).x;
    for (let frame = 1; frame <= 200; frame++) {
      const current = meters(
        estimator.estimate('bus', replayTime(20 + frame / 20))!.position
      ).x;
      expect(current).toBeGreaterThanOrEqual(previous - 0.001);
      previous = current;
    }
    expect(previous).toBeCloseTo(300, 1);
  });

  test('duplicate stop snapshots do not restart an unfinished slide', () => {
    const estimator = track();
    const stop = packet(15, 200, 0, 0, { currentStatus: 'STOPPED_AT' });
    estimator.ingest(stop, replayTime(15));
    for (let frame = 1; frame <= 20; frame++)
      estimator.ingest(stop, replayTime(15 + frame / 20));
    const settled = estimator.estimate('bus', replayTime(16))!;
    expect(meters(settled.position).x).toBeCloseTo(200, 2);
    expect(settled.sourceTimestamp).toBe(replayTime(15));
    expect(settled.moving).toBe(false);
  });

  test('corroborating a relocation accepts the second fix and slides from the displayed point', () => {
    const estimator = track();
    expect(estimator.ingest(packet(11, 1_700), replayTime(11))).toBe(false);
    const before = estimator.estimate('bus', replayTime(14))!;
    expect(estimator.ingest(packet(14, 1_724), replayTime(14))).toBe(true);
    const accepted = estimator.estimate('bus', replayTime(14))!;
    expect(accepted.position).toEqual(before.position);
    expect(meters(accepted.rawPosition).x).toBeCloseTo(1_724, 2);
    expect(accepted.sourceTimestamp).toBe(replayTime(14));
    const middle = meters(
      estimator.estimate('bus', replayTime(16))!.position
    ).x;
    expect(middle).toBeGreaterThan(meters(before.position).x);
    expect(middle).toBeLessThan(1_724);
    expect(
      meters(estimator.estimate('bus', replayTime(19))!.position).x
    ).toBeCloseTo(1_724, 2);
  });

  test('returning from a background tab starts at its last painted position and converges', () => {
    const estimator = track();
    const painted = estimator.estimate('bus', replayTime(10))!;
    estimator.rebaseDisplay(
      'bus',
      painted.position,
      painted.heading,
      replayTime(35)
    );
    expect(estimator.estimate('bus', replayTime(35))!.position).toEqual(
      painted.position
    );
    const middle = estimator.estimate('bus', replayTime(37))!;
    expect(meters(middle.position).x).toBeGreaterThan(
      meters(painted.position).x
    );
    expect(middle.sourceTimestamp).toBe(replayTime(10));
    expect(estimator.estimate('bus', replayTime(70))!.position).toEqual(
      estimator.estimate('bus', replayTime(210))!.position
    );
    expect(estimator.hasActiveMotion(replayTime(210))).toBe(false);
  });
});

describe('missing trip shape uses only an unambiguous shared route corridor', () => {
  const north = {
    shapeId: 'north',
    direction: 'OUTBOUND',
    path: [point(0), point(150), point(150, 500)]
  };
  const south = {
    shapeId: 'south',
    direction: 'OUTBOUND',
    path: [point(0), point(150), point(150, -500)]
  };
  const unknownShape = (second: number, x: number, y = 0, heading = 90) =>
    packet(second, x, 8, y, { shapeId: undefined, heading });

  test('a single well-supported fix moves along a unique route without an exact shape ID', () => {
    const estimator = new VehicleMotionEstimator();
    estimator.setRouteGeometry('R', [north], []);
    estimator.ingest(unknownShape(0, 100), replayTime(0));
    const result = estimator.estimate('bus', replayTime(5))!;
    expect(result.moving).toBe(true);
    expect(meters(result.position).x).toBeGreaterThan(120);
    expect(meters(result.position).x).toBeLessThan(150);
    expect(result.sourceTimestamp).toBe(replayTime(0));
    expect(meters(result.rawPosition).x).toBeCloseTo(100, 2);
  });

  test('overlapping variants move to their shared branch point, then wait without choosing a branch', () => {
    const estimator = new VehicleMotionEstimator();
    estimator.setRouteGeometry('R', [north, south], []);
    const gps = unknownShape(0, 100);
    estimator.ingest(gps, replayTime(0));
    expect(
      meters(estimator.estimate('bus', replayTime(3))!.position).x
    ).toBeGreaterThan(110);
    for (let second = 0; second <= 30; second += 0.25) {
      const location = meters(
        estimator.estimate('bus', replayTime(second))!.position
      );
      expect(location.x).toBeLessThanOrEqual(150.01);
      expect(Math.abs(location.y)).toBeLessThan(0.01);
    }
    const waiting = estimator.estimate('bus', replayTime(30))!;
    expect(meters(waiting.position).x).toBeGreaterThanOrEqual(130);
    expect(waiting.moving).toBe(false);
    estimator.ingest(gps, replayTime(35));
    estimator.ingest(gps, replayTime(45));
    expect(estimator.estimate('bus', replayTime(60))!.position).toEqual(
      waiting.position
    );
    expect(estimator.estimate('bus', replayTime(60))!.sourceTimestamp).toBe(
      replayTime(0)
    );
  });

  test('the earliest split among all plausible variants limits the shared corridor', () => {
    const early = {
      shapeId: 'early',
      direction: 'OUTBOUND',
      path: [point(0), point(130), point(130, 500)]
    };
    const estimator = new VehicleMotionEstimator();
    estimator.setRouteGeometry('R', [north, south, early], []);
    estimator.ingest(unknownShape(0, 100), replayTime(0));
    const result = meters(estimator.estimate('bus', replayTime(30))!.position);
    expect(result.x).toBeGreaterThan(110);
    expect(result.x).toBeLessThanOrEqual(130.01);
    expect(Math.abs(result.y)).toBeLessThan(0.01);
  });

  test('distinct parallel roads more than five metres apart do not become a shared corridor', () => {
    const estimator = new VehicleMotionEstimator();
    estimator.setRouteGeometry(
      'R',
      [
        {
          shapeId: 'left',
          direction: 'OUTBOUND',
          path: [point(0, -4), point(1000, -4)]
        },
        {
          shapeId: 'right',
          direction: 'OUTBOUND',
          path: [point(0, 4), point(1000, 4)]
        }
      ],
      []
    );
    estimator.ingest(unknownShape(0, 100), replayTime(0));
    expect(estimator.estimate('bus', replayTime(10))).toMatchObject({
      position: point(100),
      moving: false,
      estimated: false
    });
    estimator.ingest(unknownShape(10, 180), replayTime(10));
    expect(estimator.estimate('bus', replayTime(30))).toMatchObject({
      position: point(180),
      moving: false,
      estimated: false
    });
  });

  test('duplicate variants with identical geometry can continue along the complete common route', () => {
    const path = [point(0), point(1000)];
    const estimator = new VehicleMotionEstimator();
    estimator.setRouteGeometry(
      'R',
      [
        { shapeId: 'first', direction: 'OUTBOUND', path },
        { shapeId: 'second', direction: 'OUTBOUND', path: [...path] }
      ],
      []
    );
    estimator.ingest(unknownShape(0, 100), replayTime(0));
    expect(
      meters(estimator.estimate('bus', replayTime(20))!.position).x
    ).toBeGreaterThan(200);
    estimator.ingest(unknownShape(20, 260), replayTime(20));
    expect(
      meters(estimator.estimate('bus', replayTime(30))!.position).x
    ).toBeGreaterThan(300);
    expect(estimator.estimate('bus', replayTime(30))!.moving).toBe(true);
  });

  test('new GPS and heading can resolve the fork before motion continues down that branch', () => {
    const estimator = new VehicleMotionEstimator();
    estimator.setRouteGeometry('R', [north, south], []);
    estimator.ingest(unknownShape(0, 100), replayTime(0));
    expect(
      Math.abs(meters(estimator.estimate('bus', replayTime(20))!.position).y)
    ).toBeLessThan(0.01);
    estimator.ingest(unknownShape(20, 150, 30, 0), replayTime(20));
    const resolved = estimator.estimate('bus', replayTime(25))!;
    expect(meters(resolved.position).x).toBeCloseTo(150, 2);
    expect(meters(resolved.position).y).toBeGreaterThan(30);
    expect(resolved.moving).toBe(true);
    expect(resolved.sourceTimestamp).toBe(replayTime(20));
  });

  test('a supplied unrecognized shape ID is never replaced with a guessed corridor', () => {
    const estimator = new VehicleMotionEstimator();
    estimator.setRouteGeometry('R', [north, south], []);
    estimator.ingest(
      packet(0, 100, 8, 0, { shapeId: 'not-on-this-route' }),
      replayTime(0)
    );
    expect(estimator.estimate('bus', replayTime(20))).toMatchObject({
      position: point(100),
      moving: false,
      estimated: false
    });
  });
});

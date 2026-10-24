import type { ILatLng } from '../common/map.interface';
import type { IPattern, IStop, IVehicle } from '../common/transit.interface';

/** Controlled synthetic truth: these replays measure regressions, not GPS accuracy. */
export interface MotionReplayEstimator {
  setRouteGeometry(routeId: string, patterns: IPattern[], stops: IStop[]): void;
  ingest(vehicle: IVehicle, receivedAt: number): void;
  estimate(
    vid: string,
    now: number
  ): {
    position: ILatLng;
    sourceTimestamp: number | null;
  } | null;
}

type XY = { x: number; y: number };
interface ReplayReport {
  received: number;
  vehicle: IVehicle;
}
export interface MotionReplayScenario {
  name: string;
  description: string;
  path: XY[];
  geometry: boolean;
  stops: IStop[];
  from: number;
  until: number;
  /** Distance travelled along path, in metres, at this wall-clock second. */
  truth: (seconds: number) => number;
  reports: ReplayReport[];
}

export interface MotionReplayMetrics {
  scenario: string;
  seconds: number;
  meanPositionErrorMeters: number;
  p95PositionErrorMeters: number;
  reverseTravelMeters: number;
  maxFrameTravelMeters: number;
  movingFreezeSeconds: number;
  maxCrossTrackMeters: number;
  finalPositionErrorMeters: number;
  timestampRegressions: number;
}

const epoch = Date.parse('2026-10-24T12:00:00Z');
const latOrigin = 40.44;
const lngOrigin = -79.94;
const latScale = 111_194.9266;
const lngScale = latScale * Math.cos((latOrigin * Math.PI) / 180);
export const replayTime = (seconds: number): number => epoch + seconds * 1_000;
const position = ({ x, y }: XY): ILatLng => ({
  lat: latOrigin + y / latScale,
  lng: lngOrigin + x / lngScale
});
const xy = (point: ILatLng): XY => ({
  x: (point.lng - lngOrigin) * lngScale,
  y: (point.lat - latOrigin) * latScale
});
const distance = (a: XY, b: XY): number => Math.hypot(a.x - b.x, a.y - b.y);
const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

function pathPoint(path: XY[], progress: number): XY {
  let remaining = Math.max(0, progress);
  for (let index = 1; index < path.length; index++) {
    const a = path[index - 1];
    const b = path[index];
    const length = distance(a, b);
    if (remaining <= length) {
      const fraction = remaining / length;
      return {
        x: a.x + (b.x - a.x) * fraction,
        y: a.y + (b.y - a.y) * fraction
      };
    }
    remaining -= length;
  }
  return path[path.length - 1];
}

function projection(
  path: XY[],
  point: XY
): { progress: number; crossTrack: number } {
  let offset = 0;
  let best = { progress: 0, crossTrack: Infinity };
  for (let index = 1; index < path.length; index++) {
    const a = path[index - 1];
    const b = path[index];
    const length = distance(a, b);
    const fraction = clamp(
      ((point.x - a.x) * (b.x - a.x) + (point.y - a.y) * (b.y - a.y)) /
        length ** 2,
      0,
      1
    );
    const projected = {
      x: a.x + (b.x - a.x) * fraction,
      y: a.y + (b.y - a.y) * fraction
    };
    const crossTrack = distance(projected, point);
    if (crossTrack < best.crossTrack)
      best = { progress: offset + fraction * length, crossTrack };
    offset += length;
  }
  return best;
}

function report(
  path: XY[],
  source: number,
  received: number,
  progress: number,
  extra: Partial<IVehicle> = {},
  noise: XY = { x: 0, y: 0 }
): ReplayReport {
  const actual = pathPoint(path, progress);
  const ahead = pathPoint(path, progress + 0.5);
  const coordinate = position({ x: actual.x + noise.x, y: actual.y + noise.y });
  const heading =
    ((Math.atan2(ahead.x - actual.x, ahead.y - actual.y) * 180) / Math.PI +
      360) %
    360;
  return {
    received,
    vehicle: {
      vid: 'replay-bus',
      routeId: 'R',
      tripId: 'trip',
      shapeId: 'main',
      direction: 'OUTBOUND',
      source: 'live',
      isDetoured: false,
      lat: coordinate.lat,
      lon: coordinate.lng,
      speed: 8,
      heading,
      lastUpdate: new Date(replayTime(source)).toISOString(),
      ...extra
    }
  };
}

const straight: XY[] = [
  { x: 0, y: 0 },
  { x: 4_500, y: 0 }
];
function scenario(
  name: string,
  description: string,
  truth: (seconds: number) => number,
  reports: ReplayReport[],
  extra: Partial<MotionReplayScenario> = {}
): MotionReplayScenario {
  return {
    name,
    description,
    path: straight,
    geometry: true,
    stops: [],
    from: 0,
    until: 120,
    truth,
    reports,
    ...extra
  };
}

export function motionReplayScenarios(): MotionReplayScenario[] {
  const cadence = Array.from({ length: 6 }, (_, index) => index * 20);
  const steadyTruth = (seconds: number) => 100 + seconds * 8;
  const slowTruth = (seconds: number) => 100 + seconds * 1.2;
  const stopTruth = (seconds: number) =>
    100 + Math.min(seconds, 35) * 8 + Math.max(0, seconds - 65) * 6;
  const stoppedPosition = position(pathPoint(straight, 380));
  const turnPath: XY[] = [
    { x: 0, y: 0 },
    { x: 250, y: 0 },
    { x: 250, y: 1_600 }
  ];
  const delayed = cadence.map((second) =>
    report(straight, second, second + 15, steadyTruth(second))
  );
  const repeated = cadence.map((second) =>
    report(straight, second, second, steadyTruth(second))
  );
  const old = report(straight, 0, 0, 100);
  return [
    scenario(
      'steady-delayed',
      '30-second source cadence with 15-second delivery lag; constant 8 m/s.',
      steadyTruth,
      [0, 30, 60, 90, 120].map((second) =>
        report(straight, second, second + 15, steadyTruth(second))
      ),
      { from: 15, until: 135 }
    ),
    scenario(
      'slow-gps-jitter',
      'Slow traffic at 1.2 m/s with alternating 4 m along-track and 6 m lateral noise.',
      slowTruth,
      Array.from({ length: 13 }, (_, index) =>
        report(
          straight,
          index * 10,
          index * 10 + 5,
          slowTruth(index * 10),
          { speed: 1.2 },
          { x: index % 2 ? -4 : 4, y: index % 2 ? -6 : 6 }
        )
      ),
      { from: 5, until: 125 }
    ),
    scenario(
      'stationary-gps-jitter',
      'A confirmed stopped bus with alternating 4 m GPS wander stays parked.',
      () => 200,
      Array.from({ length: 13 }, (_, index) =>
        report(
          straight,
          index * 10,
          index * 10,
          200,
          { speed: 0, currentStatus: 'STOPPED_AT' },
          {
            x: index === 0 ? 0 : index % 2 ? -4 : 4,
            y: index === 0 ? 0 : index % 2 ? -4 : 4
          }
        )
      )
    ),
    scenario(
      'isolated-teleport',
      'A single impossible 1.5 km fix is followed by the valid track.',
      steadyTruth,
      [...repeated, report(straight, 41, 41, 1_900)]
    ),
    scenario(
      'stop-and-restart',
      'Bus stops at 35 s, remains at the platform until 65 s, then restarts; 8 s feed lag.',
      stopTruth,
      Array.from({ length: 13 }, (_, index) => {
        const second = index * 10;
        const stopped = second >= 35 && second <= 65;
        return report(straight, second, second + 8, stopTruth(second), {
          speed: stopped ? 0 : second > 65 ? 6 : 8,
          currentStatus: stopped ? 'STOPPED_AT' : 'IN_TRANSIT_TO',
          currentStopId: second <= 65 ? 'boarding' : undefined
        });
      }),
      {
        from: 8,
        until: 128,
        stops: [
          {
            stopId: 'boarding',
            stopName: 'Boarding',
            lat: stoppedPosition.lat,
            lon: stoppedPosition.lng,
            dtradd: [],
            dtrrem: []
          }
        ]
      }
    ),
    scenario(
      'right-angle-bend',
      'A right-angle turn with 12 s delivery lag and 15 s source cadence.',
      (seconds) => 50 + seconds * 6,
      Array.from({ length: 9 }, (_, index) =>
        report(turnPath, index * 15, index * 15 + 12, 50 + index * 15 * 6, {
          speed: 6
        })
      ),
      { path: turnPath, from: 12, until: 132 }
    ),
    scenario(
      'duplicates-and-out-of-order',
      'Repeated HTTP snapshots and older packets do not reset source freshness or movement.',
      steadyTruth,
      [
        ...repeated,
        ...Array.from({ length: 20 }, (_, index) => ({
          ...old,
          received: 5 + index * 5
        }))
      ]
    ),
    scenario(
      'very-delayed-first-fix',
      'The first fix is already 85 s old; later reports retain that source lag.',
      steadyTruth,
      cadence.map((second) =>
        report(straight, second, second + 85, steadyTruth(second))
      ),
      { from: 85, until: 185 }
    ),
    scenario(
      'missing-geometry',
      'No trusted route shape; fresh GPS updates still reconcile smoothly.',
      steadyTruth,
      delayed,
      { geometry: false, from: 15, until: 115 }
    ),
    scenario(
      'bad-speed-packet',
      'One zero-speed packet contradicts consistent continuing source travel.',
      steadyTruth,
      cadence.map((second) =>
        report(straight, second, second + 10, steadyTruth(second), {
          speed: second === 40 ? 0 : 8
        })
      ),
      { from: 10, until: 110 }
    ),
    scenario(
      'feed-outage',
      'After two fixes the feed stops: estimate must decay, retain one marker and settle.',
      steadyTruth,
      [report(straight, 0, 0, 100), report(straight, 10, 10, 180)],
      { until: 210 }
    )
  ].map((item) => ({
    ...item,
    reports: item.reports.sort((a, b) => a.received - b.received)
  }));
}

/** Replay at 20 Hz; metric names include units to keep comparisons honest. */
export function runMotionReplay(
  createEstimator: () => MotionReplayEstimator,
  replay: MotionReplayScenario
): MotionReplayMetrics {
  const estimator = createEstimator();
  if (replay.geometry)
    estimator.setRouteGeometry(
      'R',
      [
        {
          shapeId: 'main',
          direction: 'OUTBOUND',
          path: replay.path.map(position)
        }
      ],
      replay.stops
    );
  let reportIndex = 0;
  let previousPosition: XY | null = null;
  let previousProgress = 0;
  let previousTimestamp: number | null = null;
  let reverseTravel = 0;
  let maxFrameTravel = 0;
  let movingFreeze = 0;
  let maxCrossTrack = 0;
  let timestampRegressions = 0;
  const errors: number[] = [];
  const frames = Math.round((replay.until - replay.from) * 20);
  for (let frame = 0; frame <= frames; frame++) {
    const second = replay.from + frame / 20;
    while (
      reportIndex < replay.reports.length &&
      replay.reports[reportIndex].received <= second + 1e-8
    ) {
      const packet = replay.reports[reportIndex++];
      estimator.ingest(packet.vehicle, replayTime(packet.received));
    }
    const estimate = estimator.estimate('replay-bus', replayTime(second));
    if (!estimate)
      throw new Error(`${replay.name}: missing marker at ${second}s`);
    const rendered = xy(estimate.position);
    if (!Number.isFinite(rendered.x) || !Number.isFinite(rendered.y))
      throw new Error(`${replay.name}: non-finite marker`);
    const progress = projection(replay.path, rendered);
    maxCrossTrack = Math.max(maxCrossTrack, progress.crossTrack);
    errors.push(
      distance(rendered, pathPoint(replay.path, replay.truth(second)))
    );
    if (previousPosition) {
      const travel = distance(rendered, previousPosition);
      maxFrameTravel = Math.max(maxFrameTravel, travel);
      reverseTravel += Math.max(0, previousProgress - progress.progress);
      if (
        replay.truth(second) - replay.truth(second - 0.05) > 0.025 &&
        travel < 0.005
      )
        movingFreeze += 0.05;
    }
    if (
      estimate.sourceTimestamp !== null &&
      previousTimestamp !== null &&
      estimate.sourceTimestamp < previousTimestamp
    )
      timestampRegressions++;
    if (estimate.sourceTimestamp !== null)
      previousTimestamp = estimate.sourceTimestamp;
    previousPosition = rendered;
    previousProgress = progress.progress;
  }
  const sorted = [...errors].sort((a, b) => a - b);
  const round = (value: number) => Math.round(value * 100) / 100;
  return {
    scenario: replay.name,
    seconds: replay.until - replay.from,
    meanPositionErrorMeters: round(
      errors.reduce((a, b) => a + b, 0) / errors.length
    ),
    p95PositionErrorMeters: round(
      sorted[Math.floor((sorted.length - 1) * 0.95)]
    ),
    reverseTravelMeters: round(reverseTravel),
    maxFrameTravelMeters: round(maxFrameTravel),
    movingFreezeSeconds: round(movingFreeze),
    maxCrossTrackMeters: round(maxCrossTrack),
    finalPositionErrorMeters: round(errors[errors.length - 1]),
    timestampRegressions
  };
}

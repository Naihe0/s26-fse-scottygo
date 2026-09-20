import type { ILatLng } from '../../../common/map.interface';
import type {
  IPattern,
  IStop,
  IVehicle
} from '../../../common/transit.interface';

export interface VehicleMotionEstimate {
  position: ILatLng;
  rawPosition: ILatLng;
  heading?: number;
  estimated: boolean;
  moving: boolean;
  freshness: 'fresh' | 'aging' | 'stale';
  /** A conservative quality score, not a statistical probability. */
  confidence: number;
  sourceTimestamp: number | null;
  ageMs: number | null;
}

export const VEHICLE_MOTION_LIMITS = {
  freshMs: 30_000,
  staleMs: 90_000,
  // Absolute safeguards; each track normally expires earlier, based on cadence.
  horizonMs: 180_000,
  maximumInitialAgeMs: 120_000,
  maximumDistance: 3_000,
  maximumSpeed: 20,
  maximumInitialSpeed: 25,
  maximumObservedSpeed: 35,
  maximumRouteDistance: 35
} as const;

interface Segment {
  from: ILatLng;
  to: ILatLng;
  length: number;
  start: number;
  heading: number;
}

interface Pattern {
  key: number;
  direction: string;
  shapeId?: string;
  segments: Segment[];
  length: number;
  stops: Map<string, number[]>;
}

interface RouteGeometry {
  patterns: IPattern[];
  stops: IStop[];
  compiled: Map<number, Pattern | null>;
  stopPositions: Map<string, ILatLng> | null;
}

interface Match {
  pattern: Pattern;
  progress: number;
  distance: number;
  heading: number;
  score: number;
}

interface Sample {
  position: ILatLng;
  timestamp: number | null;
  match: Match | null;
}

interface MotionPhase {
  from: number;
  to: number;
  start: number;
  end: number;
  startSpeed: number;
  endSpeed: number;
}

interface Track {
  vehicle: IVehicle;
  sample: Sample;
  receivedAt: number;
  speed: number;
  observedSpeed: number | null;
  quality: number;
  stopAt: number;
  cadenceMs: number;
  cadenceSamples: number;
  fullSpeedSeconds: number;
  horizonSeconds: number;
  phases: MotionPhase[];
  paused: {
    position: ILatLng;
    heading: number | undefined;
    progress: number | null;
  } | null;
  correction: {
    from: ILatLng;
    fromProgress: number | null;
    startedAt: number;
    duration: number;
  } | null;
}

const EARTH_RADIUS = 6_371_000;
const radians = (degrees: number) => (degrees * Math.PI) / 180;
const clamp = (value: number, min: number, max: number) =>
  Math.max(min, Math.min(max, value));

function validPosition(point: ILatLng): boolean {
  return (
    Number.isFinite(point.lat) &&
    Math.abs(point.lat) <= 90 &&
    Number.isFinite(point.lng) &&
    Math.abs(point.lng) <= 180
  );
}

function distance(a: ILatLng, b: ILatLng): number {
  const dLat = radians(b.lat - a.lat);
  const dLng = radians(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(radians(a.lat)) *
      Math.cos(radians(b.lat)) *
      Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS * Math.asin(Math.sqrt(clamp(h, 0, 1)));
}

function bearing(a: ILatLng, b: ILatLng): number {
  const y = Math.sin(radians(b.lng - a.lng)) * Math.cos(radians(b.lat));
  const x =
    Math.cos(radians(a.lat)) * Math.sin(radians(b.lat)) -
    Math.sin(radians(a.lat)) *
      Math.cos(radians(b.lat)) *
      Math.cos(radians(b.lng - a.lng));
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

function normalizedHeading(value?: number): number | undefined {
  return typeof value === 'number' && Number.isFinite(value)
    ? ((value % 360) + 360) % 360
    : undefined;
}

function headingDifference(a: number, b: number): number {
  return Math.abs(((a - b + 540) % 360) - 180);
}

function direction(value?: string): string {
  const result = value?.trim().toUpperCase() ?? '';
  if (result === 'IB') return 'INBOUND';
  if (result === 'OB') return 'OUTBOUND';
  return result;
}

function project(
  point: ILatLng,
  segment: Segment
): { progress: number; distance: number } {
  const scaleX = Math.cos(radians((segment.from.lat + segment.to.lat) / 2));
  const x = (point.lng - segment.from.lng) * scaleX;
  const y = point.lat - segment.from.lat;
  const dx = (segment.to.lng - segment.from.lng) * scaleX;
  const dy = segment.to.lat - segment.from.lat;
  const fraction = clamp((x * dx + y * dy) / (dx * dx + dy * dy), 0, 1);
  const projected = {
    lat: segment.from.lat + fraction * (segment.to.lat - segment.from.lat),
    lng: segment.from.lng + fraction * (segment.to.lng - segment.from.lng)
  };
  return {
    progress: segment.start + fraction * segment.length,
    distance: distance(point, projected)
  };
}

function pointAt(
  pattern: Pattern,
  progress: number
): { position: ILatLng; heading: number } {
  const bounded = clamp(progress, 0, pattern.length);
  let low = 0;
  let high = pattern.segments.length - 1;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    const segment = pattern.segments[middle];
    if (segment.start + segment.length <= bounded) low = middle + 1;
    else high = middle;
  }
  const segment = pattern.segments[low];
  const fraction = clamp((bounded - segment.start) / segment.length, 0, 1);
  return {
    position: {
      lat: segment.from.lat + fraction * (segment.to.lat - segment.from.lat),
      lng: segment.from.lng + fraction * (segment.to.lng - segment.from.lng)
    },
    heading: segment.heading
  };
}

function compilePattern(pattern: IPattern, key: number): Pattern | null {
  if (
    !Array.isArray(pattern.path) ||
    pattern.path.length < 2 ||
    pattern.path.some((point) => !point || !validPosition(point))
  )
    return null;
  const segments: Segment[] = [];
  let length = 0;
  for (let i = 1; i < pattern.path.length; i++) {
    const from = pattern.path[i - 1];
    const to = pattern.path[i];
    const segmentLength = distance(from, to);
    if (segmentLength < 0.5) continue;
    // A missing intermediate shape must not create a country-crossing shortcut.
    if (segmentLength > 5_000) return null;
    segments.push({
      from: { ...from },
      to: { ...to },
      length: segmentLength,
      start: length,
      heading: bearing(from, to)
    });
    length += segmentLength;
  }
  return segments.length
    ? {
        key,
        direction: direction(pattern.direction),
        shapeId: pattern.shapeId,
        segments,
        length,
        stops: new Map()
      }
    : null;
}

function routeStops(route: RouteGeometry): Map<string, ILatLng> {
  if (!route.stopPositions) {
    route.stopPositions = new Map();
    for (const stop of route.stops) {
      const point = { lat: stop.lat, lng: stop.lon };
      if (validPosition(point)) route.stopPositions.set(stop.stopId, point);
    }
  }
  return route.stopPositions;
}

function nearSegment(
  point: ILatLng,
  segment: Segment,
  margin: number
): boolean {
  const latMargin = margin / 111_000;
  const lngMargin = latMargin / Math.max(0.01, Math.cos(radians(point.lat)));
  return (
    point.lat >= Math.min(segment.from.lat, segment.to.lat) - latMargin &&
    point.lat <= Math.max(segment.from.lat, segment.to.lat) + latMargin &&
    point.lng >= Math.min(segment.from.lng, segment.to.lng) - lngMargin &&
    point.lng <= Math.max(segment.from.lng, segment.to.lng) + lngMargin
  );
}

function stopProgress(
  pattern: Pattern,
  id: string,
  position: ILatLng
): number[] {
  const cached = pattern.stops.get(id);
  if (cached) return cached;
  const candidates = pattern.segments
    .filter((segment) => nearSegment(position, segment, 25))
    .map((segment) => project(position, segment))
    .filter((match) => match.distance <= 25)
    .sort((a, b) => a.progress - b.progress);
  const nearestDistance = candidates.reduce(
    (best, candidate) => Math.min(best, candidate.distance),
    Infinity
  );
  const progress = candidates
    .filter((candidate) => candidate.distance <= nearestDistance + 3)
    .map((match) => match.progress)
    .filter((value, index, values) => !index || value - values[index - 1] > 5);
  pattern.stops.set(id, progress);
  return progress;
}
/** Deterministic, SDK-independent motion. Source GPS and timestamps are immutable. */
export class VehicleMotionEstimator {
  private readonly routes = new Map<string, RouteGeometry>();
  private readonly tracks = new Map<string, Track>();

  setRouteGeometry(
    routeId: string,
    patterns: IPattern[],
    stops: IStop[]
  ): void {
    const existing = this.routes.get(routeId);
    if (existing?.patterns === patterns && existing.stops === stops) return;
    // Bulk registration is O(1). Compile only shapes an observed vehicle needs.
    this.routes.set(routeId, {
      patterns,
      stops,
      compiled: new Map(),
      stopPositions: null
    });
    // Changing geometry invalidates path continuity, not the observed GPS fix.
    for (const track of this.tracks.values()) {
      if (track.vehicle.routeId !== routeId) continue;
      track.sample.match = this.match(
        track.vehicle,
        track.sample.position,
        null,
        undefined
      );
      track.speed = 0;
      track.observedSpeed = null;
      track.correction = null;
      track.phases = [];
      if (track.paused) track.paused.progress = null;
    }
  }

  ingest(vehicle: IVehicle, receivedAt = Date.now()): void {
    const position = { lat: vehicle.lat, lng: vehicle.lon };
    if (!validPosition(position) || !Number.isFinite(receivedAt)) return;
    const parsedTime = Date.parse(vehicle.lastUpdate);
    const timestamp =
      Number.isFinite(parsedTime) && parsedTime <= receivedAt + 5_000
        ? parsedTime
        : null;
    const previous = this.tracks.get(vehicle.vid);
    if (
      previous?.sample.timestamp !== null &&
      previous?.sample.timestamp !== undefined &&
      timestamp !== null &&
      timestamp < previous.sample.timestamp
    )
      return;

    const sameJourney =
      !!previous &&
      previous.vehicle.routeId === vehicle.routeId &&
      previous.vehicle.tripId === vehicle.tripId &&
      direction(previous.vehicle.direction) === direction(vehicle.direction) &&
      previous.vehicle.shapeId === vehicle.shapeId;
    if (
      sameJourney &&
      timestamp !== null &&
      timestamp === previous.sample.timestamp
    ) {
      if (previous.paused) return;
      // Repeated HTTP snapshots must not create motion or renew source freshness.
      // New safety information can stop existing prediction, never accelerate it.
      if (
        vehicle.currentStatus === 'STOPPED_AT' ||
        vehicle.isDetoured ||
        vehicle.speed === 0
      ) {
        const previousDisplay = this.estimate(vehicle.vid, receivedAt)!;
        const previousProgress = previous.sample.match
          ? this.progress(previous, receivedAt)
          : null;
        previous.speed = 0;
        previous.correction = null;
        this.startCorrection(
          previous,
          previousDisplay,
          previousProgress,
          receivedAt
        );
      }
      return;
    }

    const elapsed =
      sameJourney && timestamp !== null && previous.sample.timestamp !== null
        ? (timestamp - previous.sample.timestamp) / 1_000
        : null;
    const usableHistory = elapsed !== null && elapsed >= 2 && elapsed <= 120;
    const rawDistance =
      elapsed !== null && elapsed > 0 && previous
        ? distance(previous!.sample.position, position)
        : 0;
    const impliedSpeed =
      elapsed !== null && elapsed > 0 ? rawDistance / elapsed : null;
    const teleport =
      impliedSpeed !== null &&
      impliedSpeed > VEHICLE_MOTION_LIMITS.maximumObservedSpeed;
    const history = usableHistory && !teleport ? (previous ?? null) : null;
    const inferredHeading =
      rawDistance >= 8 && history
        ? bearing(history.sample.position, position)
        : undefined;
    const match = this.match(vehicle, position, history, inferredHeading);
    const track: Track = {
      vehicle: { ...vehicle },
      sample: { position, timestamp, match },
      receivedAt,
      speed: 0,
      observedSpeed: null,
      quality: 0,
      stopAt: match?.pattern.length ?? 0,
      cadenceMs: history
        ? clamp(
            history.cadenceSamples
              ? history.cadenceMs * 0.6 +
                  Math.max(elapsed! * 1_000, receivedAt - history.receivedAt) *
                    0.4
              : Math.max(elapsed! * 1_000, receivedAt - history.receivedAt),
            10_000,
            60_000
          )
        : 60_000,
      cadenceSamples: history ? history.cadenceSamples + 1 : 0,
      fullSpeedSeconds: 0,
      horizonSeconds: 0,
      phases: [],
      paused: null,
      correction: null
    };
    const previousDisplay = previous
      ? this.estimate(vehicle.vid, receivedAt)
      : null;
    this.tracks.set(vehicle.vid, track);

    this.configureMotion(track, history, elapsed ?? 0, rawDistance, !previous);
    if (
      sameJourney &&
      !teleport &&
      previous &&
      timestamp !== null &&
      previous.sample.timestamp !== null
    ) {
      const previousMatch = previous.sample.match;
      const samePattern =
        previousMatch &&
        match &&
        previousMatch.pattern === match.pattern &&
        previousMatch.distance <= 15 &&
        match.distance <= 15;
      this.startCorrection(
        track,
        previousDisplay!,
        samePattern
          ? previous.paused
            ? previous.paused.progress
            : this.progress(previous, receivedAt)
          : null
      );
    }
  }
  estimate(vid: string, now = Date.now()): VehicleMotionEstimate | null {
    const track = this.tracks.get(vid);
    if (!track) return null;
    const clock = Number.isFinite(now) ? now : track.receivedAt;
    const ageMs =
      track.sample.timestamp === null
        ? null
        : Math.max(0, clock - track.sample.timestamp);
    const freshness =
      ageMs === null || ageMs > VEHICLE_MOTION_LIMITS.staleMs
        ? 'stale'
        : ageMs > VEHICLE_MOTION_LIMITS.freshMs
          ? 'aging'
          : 'fresh';
    const rawPosition = { ...track.sample.position };
    const result: VehicleMotionEstimate = {
      position: rawPosition,
      rawPosition: { ...rawPosition },
      heading: normalizedHeading(track.vehicle.heading),
      estimated: false,
      moving: false,
      freshness,
      confidence:
        ageMs === null
          ? 0
          : clamp(1 - ageMs / VEHICLE_MOTION_LIMITS.staleMs, 0, 1),
      sourceTimestamp: track.sample.timestamp,
      ageMs
    };
    if (track.paused) {
      result.position = { ...track.paused.position };
      result.heading = track.paused.heading;
      result.estimated = distance(rawPosition, result.position) >= 0.75;
      result.confidence = 0;
      return result;
    }
    const match = track.sample.match;
    if (
      match &&
      track.speed > 0 &&
      ageMs !== null &&
      clock >= track.receivedAt
    ) {
      const progress = this.progress(track, clock);
      const alongRoute = pointAt(match.pattern, progress);
      result.position = alongRoute.position;
      result.heading = alongRoute.heading;
      result.moving =
        ageMs < track.horizonSeconds * 1_000 && progress < track.stopAt - 0.01;
      result.confidence =
        track.quality * clamp(1 - ageMs / (track.horizonSeconds * 1_000), 0, 1);
    }
    const correction = track.correction;
    if (correction && clock < correction.startedAt + correction.duration) {
      const fraction = clamp(
        (clock - correction.startedAt) / correction.duration,
        0,
        1
      );
      if (correction.fromProgress !== null && match) {
        const targetProgress = this.progress(track, clock);
        const intermediate = pointAt(
          match.pattern,
          correction.fromProgress +
            (targetProgress - correction.fromProgress) * fraction
        );
        const startPoint = pointAt(
          match.pattern,
          correction.fromProgress
        ).position;
        const targetPoint = pointAt(match.pattern, targetProgress).position;
        result.position = {
          lat:
            intermediate.position.lat +
            (correction.from.lat - startPoint.lat) * (1 - fraction) +
            (result.position.lat - targetPoint.lat) * fraction,
          lng:
            intermediate.position.lng +
            (correction.from.lng - startPoint.lng) * (1 - fraction) +
            (result.position.lng - targetPoint.lng) * fraction
        };
        result.heading = intermediate.heading;
      } else {
        result.position = {
          lat:
            correction.from.lat +
            (result.position.lat - correction.from.lat) * fraction,
          lng:
            correction.from.lng +
            (result.position.lng - correction.from.lng) * fraction
        };
      }
      result.moving = true;
      result.confidence = Math.min(result.confidence, 0.7);
    }
    result.estimated = distance(rawPosition, result.position) >= 0.75;
    return result;
  }

  hasActiveMotion(now = Date.now()): boolean {
    for (const track of this.tracks.values()) {
      if (track.paused) continue;
      if (
        track.correction &&
        now < track.correction.startedAt + track.correction.duration
      )
        return true;
      const { match, timestamp } = track.sample;
      if (
        !match ||
        timestamp === null ||
        track.speed <= 0 ||
        now < track.receivedAt ||
        now - timestamp >= track.horizonSeconds * 1_000
      )
        continue;
      const progress = this.progress(track, now);
      if (progress < track.stopAt - 0.01) return true;
    }
    return false;
  }

  /** Freeze displayed motion during a provider outage without rewriting GPS. */
  pause(vid: string, displayedPosition?: ILatLng, now = Date.now()): void {
    const track = this.tracks.get(vid);
    if (!track || track.paused) return;
    const estimate = this.estimate(vid, now)!;
    const position =
      displayedPosition && validPosition(displayedPosition)
        ? displayedPosition
        : estimate.position;
    const match = track.sample.match;
    let progress: number | null = null;
    if (match) {
      const expected = this.progress(track, now);
      // Capture the actual rendered progress, including an unfinished slide.
      // The continuity tie-breaker disambiguates overlapping legs of a loop.
      const candidates = match.pattern.segments
        .filter((segment) => nearSegment(position, segment, 35))
        .map((segment) => project(position, segment))
        .filter((candidate) => candidate.distance <= 35)
        .sort(
          (a, b) =>
            a.distance +
            Math.abs(a.progress - expected) * 0.01 -
            (b.distance + Math.abs(b.progress - expected) * 0.01)
        );
      progress = candidates[0]?.progress ?? null;
    }
    track.paused = {
      position: { ...position },
      heading: estimate.heading,
      progress
    };
    track.correction = null;
  }

  remove(vid: string): void {
    this.tracks.delete(vid);
  }

  /** Clear vehicles between selections without refetching cached route geometry. */
  clear(): void {
    this.tracks.clear();
  }

  private startCorrection(
    track: Track,
    previousDisplay: VehicleMotionEstimate,
    fromProgress: number | null,
    now = track.receivedAt
  ): void {
    const target = this.estimate(track.vehicle.vid, now)!;
    const correctionDistance = Math.max(
      distance(previousDisplay.position, target.position),
      fromProgress === null
        ? 0
        : Math.abs(this.progress(track, now) - fromProgress)
    );
    if (
      correctionDistance < 1 ||
      correctionDistance >
        (fromProgress === null ? 100 : VEHICLE_MOTION_LIMITS.maximumDistance)
    )
      return;
    track.correction = {
      from: { ...previousDisplay.position },
      fromProgress,
      startedAt: now,
      duration: clamp(correctionDistance * 20, 600, 4_000)
    };
  }

  private configureMotion(
    track: Track,
    history: Track | null,
    elapsed: number,
    rawDistance: number,
    firstObservation: boolean
  ): void {
    const { vehicle, receivedAt } = track;
    const { match, timestamp } = track.sample;
    if (
      !match ||
      timestamp === null ||
      receivedAt - timestamp > VEHICLE_MOTION_LIMITS.maximumInitialAgeMs ||
      vehicle.source !== 'live' ||
      vehicle.isDetoured
    )
      return;
    const feedSpeed =
      typeof vehicle.speed === 'number' &&
      Number.isFinite(vehicle.speed) &&
      vehicle.speed >= 0 &&
      vehicle.speed <= VEHICLE_MOTION_LIMITS.maximumObservedSpeed
        ? vehicle.speed
        : null;
    if (
      vehicle.currentStatus === 'STOPPED_AT' ||
      (feedSpeed !== null && feedSpeed <= 0.7)
    )
      return;

    if (history?.sample.match?.pattern === match.pattern) {
      const progressDelta = match.progress - history.sample.match.progress;
      const observed = Math.max(0, progressDelta / elapsed);
      const physical =
        progressDelta >= -10 &&
        observed <= VEHICLE_MOTION_LIMITS.maximumObservedSpeed &&
        (history.observedSpeed === null ||
          Math.abs(observed - history.observedSpeed) / elapsed <= 3);
      if (!physical) return;
      track.observedSpeed = observed;
      if (rawDistance < 8 || progressDelta < 5) return;
      // Source-to-source progress includes real traffic delays. A faster
      // instantaneous feed speed cannot overrule that observed travel pace.
      track.speed = Math.min(
        observed,
        feedSpeed ?? observed * 0.8,
        VEHICLE_MOTION_LIMITS.maximumSpeed
      );
      track.quality = feedSpeed === null ? 0.65 : 0.85;
    } else {
      const heading = normalizedHeading(vehicle.heading);
      // Start without waiting for a second delayed packet only when independent
      // feed evidence agrees: exact trip shape, nearby GPS, heading and speed.
      if (
        !firstObservation ||
        !vehicle.shapeId ||
        vehicle.shapeId !== match.pattern.shapeId ||
        match.distance > 15 ||
        heading === undefined ||
        headingDifference(heading, match.heading) > 35 ||
        feedSpeed === null ||
        feedSpeed > VEHICLE_MOTION_LIMITS.maximumInitialSpeed
      )
        return;
      track.speed = Math.min(
        feedSpeed * 0.85,
        VEHICLE_MOTION_LIMITS.maximumSpeed
      );
      track.quality = 0.55;
    }
    track.quality *= clamp(1 - match.distance / 50, 0.3, 1);

    // Feed latency is not an outage. Extrapolate across that known latency,
    // then retain motion through the next expected distinct report. Repeated
    // HTTP copies never refresh receivedAt or the learned source cadence.
    const lagSeconds = Math.max(0, (receivedAt - timestamp) / 1_000);
    const continuationSeconds =
      clamp(track.cadenceMs * 1.5, 30_000, 90_000) / 1_000;
    const decaySeconds = clamp(track.cadenceMs, 20_000, 45_000) / 1_000;
    track.horizonSeconds = Math.min(
      VEHICLE_MOTION_LIMITS.horizonMs / 1_000,
      lagSeconds + continuationSeconds + decaySeconds
    );
    track.fullSpeedSeconds = Math.min(
      lagSeconds + continuationSeconds,
      track.horizonSeconds - Math.min(decaySeconds, 20)
    );
    this.planMotion(track);
  }

  private match(
    vehicle: IVehicle,
    position: ILatLng,
    previous: Track | null,
    inferredHeading: number | undefined
  ): Match | null {
    if (vehicle.isDetoured || vehicle.source !== 'live') return null;
    const route = this.routes.get(vehicle.routeId);
    if (!route) return null;
    let patterns = route.patterns.map((pattern, key) => ({ pattern, key }));
    if (vehicle.shapeId && patterns.some(({ pattern }) => !!pattern.shapeId)) {
      patterns = patterns.filter(
        ({ pattern }) => pattern.shapeId === vehicle.shapeId
      );
      if (!patterns.length) return null;
    }
    const travelDirection = direction(vehicle.direction);
    const heading = normalizedHeading(vehicle.heading) ?? inferredHeading;
    const candidates: Match[] = [];
    const elapsed =
      previous?.sample.timestamp !== null &&
      previous?.sample.timestamp !== undefined
        ? (Date.parse(vehicle.lastUpdate) - previous.sample.timestamp) / 1_000
        : 0;
    for (const { pattern: rawPattern, key } of patterns) {
      if (
        travelDirection &&
        rawPattern.direction &&
        travelDirection !== direction(rawPattern.direction)
      )
        continue;
      if (!route.compiled.has(key))
        route.compiled.set(key, compilePattern(rawPattern, key));
      const pattern = route.compiled.get(key);
      if (!pattern) continue;
      for (const segment of pattern.segments) {
        if (
          !nearSegment(
            position,
            segment,
            VEHICLE_MOTION_LIMITS.maximumRouteDistance
          )
        )
          continue;
        const projected = project(position, segment);
        if (projected.distance > VEHICLE_MOTION_LIMITS.maximumRouteDistance)
          continue;
        const angle =
          heading === undefined
            ? 0
            : headingDifference(heading, segment.heading);
        if (angle > 70) continue;
        const prior = previous?.sample.match;
        if (prior?.pattern === pattern) {
          const advance = projected.progress - prior.progress;
          if (
            advance < -15 ||
            advance >
              Math.max(
                20,
                elapsed * VEHICLE_MOTION_LIMITS.maximumObservedSpeed + 15
              )
          )
            continue;
        }
        candidates.push({
          pattern,
          progress: projected.progress,
          distance: projected.distance,
          heading: segment.heading,
          score: projected.distance + angle * 0.12
        });
      }
    }
    candidates.sort((a, b) => a.score - b.score);
    const best = candidates[0];
    if (!best) return null;
    const ambiguous = candidates
      .slice(1)
      .some(
        (candidate) =>
          candidate.score <= best.score + 8 &&
          (candidate.pattern !== best.pattern ||
            Math.abs(candidate.progress - best.progress) > 20)
      );
    return ambiguous ? null : best;
  }

  private planMotion(track: Track): void {
    const { vehicle, speed } = track;
    const match = track.sample.match!;
    const route = this.routes.get(vehicle.routeId)!;
    const stops = routeStops(route);
    track.stopAt = Math.min(
      match.pattern.length,
      match.progress + VEHICLE_MOTION_LIMITS.maximumDistance
    );
    const current = pointAt(match.pattern, match.progress).position;
    const upcoming = [...stops]
      .filter(
        ([, position]) =>
          distance(current, position) <=
          VEHICLE_MOTION_LIMITS.maximumDistance + 35
      )
      .flatMap(([id, position]) =>
        stopProgress(match.pattern, id, position).map((progress) => ({
          progress,
          // Route stop lists also contain stops served by other variants. Only
          // the feed's announced next stop justifies an assumed boarding dwell.
          dwell:
            id === vehicle.currentStopId &&
            (vehicle.currentStatus === 'IN_TRANSIT_TO' ||
              vehicle.currentStatus === 'INCOMING_AT')
        }))
      )
      .filter(
        (stop) =>
          stop.progress > match.progress + 0.5 &&
          stop.progress < track.stopAt - 1
      )
      .sort((a, b) => a.progress - b.progress);
    // Opposite-direction stop poles and shape vertices can project onto nearly
    // the same progress. Do not charge several slowdowns for one intersection.
    const distinct: Array<{ progress: number; dwell: boolean }> = [];
    for (const stop of upcoming) {
      const previous = distinct[distinct.length - 1];
      if (previous && stop.progress - previous.progress < 20) {
        if (stop.dwell) {
          previous.progress = stop.progress;
          previous.dwell = true;
        }
      } else distinct.push({ ...stop });
    }

    let progress = match.progress;
    let seconds = 0;
    const addPhase = (to: number, fromSpeed: number, toSpeed: number) => {
      if (to <= progress) return;
      const duration = (2 * (to - progress)) / (fromSpeed + toSpeed);
      track.phases.push({
        from: progress,
        to,
        start: seconds,
        end: seconds + duration,
        startSpeed: fromSpeed,
        endSpeed: toSpeed
      });
      seconds += duration;
      progress = to;
    };
    for (const [index, stop] of distinct.entries()) {
      if (stop.progress <= progress) continue;
      const approach = Math.max(progress, stop.progress - 25);
      addPhase(approach, speed, speed);
      const atStopSpeed = stop.dwell ? 0 : speed * 0.65;
      addPhase(stop.progress, speed, atStopSpeed);
      if (stop.dwell) {
        track.phases.push({
          from: progress,
          to: progress,
          start: seconds,
          end: seconds + 6,
          startSpeed: 0,
          endSpeed: 0
        });
        seconds += 6;
      }
      const nextStop = distinct[index + 1];
      const departTo = Math.min(
        stop.progress + 20,
        nextStop ? (stop.progress + nextStop.progress) / 2 : track.stopAt,
        track.stopAt
      );
      addPhase(departTo, atStopSpeed, speed);
    }
    addPhase(track.stopAt, speed, speed);
  }

  private progress(track: Track, now: number): number {
    const match = track.sample.match;
    if (!match || !track.speed || track.sample.timestamp === null)
      return match?.progress ?? 0;
    const seconds = clamp(
      (now - track.sample.timestamp) / 1_000,
      0,
      track.horizonSeconds
    );
    const decayingSeconds = Math.max(0, seconds - track.fullSpeedSeconds);
    const decayDuration = track.horizonSeconds - track.fullSpeedSeconds;
    const effectiveSeconds =
      Math.min(seconds, track.fullSpeedSeconds) +
      decayingSeconds -
      decayingSeconds ** 2 / (2 * decayDuration);
    let low = 0;
    let high = track.phases.length - 1;
    if (high < 0) return match.progress;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (track.phases[middle].end <= effectiveSeconds) low = middle + 1;
      else high = middle;
    }
    const phase = track.phases[low];
    const elapsed = clamp(
      effectiveSeconds - phase.start,
      0,
      phase.end - phase.start
    );
    const acceleration =
      (phase.endSpeed - phase.startSpeed) / (phase.end - phase.start);
    return clamp(
      phase.from +
        phase.startSpeed * elapsed +
        (acceleration * elapsed ** 2) / 2,
      phase.from,
      phase.to
    );
  }
}

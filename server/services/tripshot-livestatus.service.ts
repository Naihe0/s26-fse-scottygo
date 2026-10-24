/**
 * TripShot liveStatus Service
 *
 * Polls the TripShot liveStatus endpoint every 15 seconds and keeps CMU
 * shuttle vehicles, arrivals, and per-route schedule summaries in memory.
 *
 * Data is keyed by TripShot route/stop UUIDs (CMURouteMetadata.routeId);
 * callers translate "CMU-n" route IDs before querying this service.
 */

import { IVehicle, IPrediction } from '../../common/transit.interface';
import {
  TRIPSHOT_LIVE_STATUS_URL,
  TsLiveStatus,
  TsLiveVehicleStatus,
  TsLiveRide,
  TsStopState
} from './tripshot-api';
import { PollingFeed } from './polling-feed';
import { reconcileVehicleSnapshot } from './vehicle-snapshot';

/** Ignore arrivals that are already stale beyond this grace period. */
const STALE_PREDICTION_GRACE_MS = 60_000;
const EASTERN_TIME_ZONE = 'America/New_York';
const SECONDS_PER_DAY = 86_400;

/**
 * Per-route schedule summary aggregated from TripShot liveStatus rides.
 * Times are "HH:MM" in Eastern time so they align with GTFS schedule data.
 */
export interface TripShotRouteSchedule {
  /** Earliest `scheduledStart` across today's rides. */
  firstTrip: string;
  /** Latest `scheduledEnd` across today's rides. */
  lastTrip: string;
  /** Weekdays (0=Sun..6=Sat) with at least one ride in the current feed. */
  operatingDays: number[];
}

interface ILiveStatusIndex {
  vehicles: Map<string, IVehicle[]>;
  predictions: Map<string, IPrediction[]>;
  schedules: Map<string, TripShotRouteSchedule>;
}

type AwaitingStop = Extract<TsStopState, { Awaiting: unknown }>['Awaiting'];
type ScheduleSpan = { first: number; last: number; days: Set<number> };
type ClockTime = { hour: number; minute: number; second: number };

/** Normalize TripShot UUIDs so map keys are case-insensitive. */
function normalizeTsRouteId(routeId: string): string {
  return routeId.trim().toLowerCase();
}

function append<T>(map: Map<string, T[]>, key: string, value: T): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

function awaitingStops(ride: TsLiveRide): AwaitingStop[] {
  return ride.stopStatus
    .filter(
      (status): status is Extract<TsStopState, { Awaiting: unknown }> =>
        'Awaiting' in status
    )
    .map((status) => status.Awaiting);
}

const easternClock = new Intl.DateTimeFormat('en-US', {
  timeZone: EASTERN_TIME_ZONE,
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23'
});

function easternClockParts(value: Date): ClockTime {
  const parts = easternClock.formatToParts(value);
  const part = (type: string) =>
    parseInt(parts.find((p) => p.type === type)?.value ?? '0', 10);
  return { hour: part('hour'), minute: part('minute'), second: part('second') };
}

const pad2 = (value: number) => String(value).padStart(2, '0');

function formatEasternHourMinute(ms: number): string {
  const { hour, minute } = easternClockParts(new Date(ms));
  return `${pad2(hour)}:${pad2(minute)}`;
}

function parseClockTime(value: string): ClockTime | null {
  const match = value.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (!match) return null;
  return {
    hour: parseInt(match[1], 10),
    minute: parseInt(match[2], 10),
    second: match[3] ? parseInt(match[3], 10) : 0
  };
}

/**
 * Convert an "HH:MM[:SS]" Eastern-time string to Unix milliseconds, using the
 * ride's scheduledStart (ISO UTC) to anchor the calendar date.
 */
function parseScheduledAt(scheduledAt: string, rideStartIso: string): number {
  const time = parseClockTime(scheduledAt);
  const rideStart = new Date(rideStartIso);
  if (!time || !Number.isFinite(rideStart.getTime())) return NaN;

  // Treat the Eastern wall-clock time as UTC, see which Eastern time that
  // instant displays as, and shift by the difference.
  const easternDate = rideStart.toLocaleDateString('en-CA', {
    timeZone: EASTERN_TIME_ZONE
  });
  const candidate = new Date(
    `${easternDate}T${pad2(time.hour)}:${pad2(time.minute)}:${pad2(time.second)}Z`
  );
  const shown = easternClockParts(candidate);
  let offsetSeconds =
    (time.hour - shown.hour) * 3600 +
    (time.minute - shown.minute) * 60 +
    (time.second - shown.second);
  // Keep the shift within ±12 h for overnight routes that cross midnight.
  if (offsetSeconds > SECONDS_PER_DAY / 2) offsetSeconds -= SECONDS_PER_DAY;
  if (offsetSeconds < -SECONDS_PER_DAY / 2) offsetSeconds += SECONDS_PER_DAY;
  return candidate.getTime() + offsetSeconds * 1000;
}

/** A prediction for a stop, or null when its time is invalid or long past. */
function buildPrediction(
  stop: AwaitingStop,
  ride: TsLiveRide,
  vid: string,
  eta: number,
  now: number
): IPrediction | null {
  if (!Number.isFinite(eta) || eta < now - STALE_PREDICTION_GRACE_MS)
    return null;
  return {
    stopId: stop.stopId,
    routeId: ride.routeId,
    vid,
    predictedArrivalTime: eta,
    isDelayed: false, // TripShot does not expose a delay flag.
    minutes: Math.max(0, Math.round((eta - now) / 60_000))
  };
}

function toVehicle(
  status: TsLiveVehicleStatus,
  normalizedRouteId: string
): IVehicle {
  return {
    vid: (status.name || '').trim() || status.vehicleId,
    lat: status.location.lt,
    lon: status.location.lg,
    routeId: normalizedRouteId, // TripShot UUID; callers rewrite to CMU-n.
    heading:
      typeof status.bearing === 'number' &&
      Number.isFinite(status.bearing) &&
      status.bearing >= 0 &&
      status.bearing <= 360
        ? status.bearing
        : undefined,
    speed:
      typeof status.speed === 'number' &&
      Number.isFinite(status.speed) &&
      status.speed >= 0
        ? status.speed
        : undefined,
    source: 'live',
    lastUpdate: status.when,
    isDetoured: false
  };
}

function addScheduleSpan(
  spans: Map<string, ScheduleSpan>,
  normalizedRouteId: string,
  ride: TsLiveRide
): void {
  const start = Date.parse(ride.scheduledStart);
  const end = Date.parse(ride.scheduledEnd);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return;
  const day = new Date(start).getDay();
  const span = spans.get(normalizedRouteId);
  if (!span) {
    spans.set(normalizedRouteId, {
      first: start,
      last: end,
      days: new Set([day])
    });
    return;
  }
  span.first = Math.min(span.first, start);
  span.last = Math.max(span.last, end);
  span.days.add(day);
}

/**
 * Index a liveStatus payload. Every ride contributes to its route's schedule.
 * Active rides with live GPS contribute a vehicle and real-time arrivals;
 * not-yet-started rides contribute scheduled arrivals. Active rides without
 * GPS are skipped: their schedule no longer reflects where the bus is.
 */
function buildIndex(data: TsLiveStatus, now: number): ILiveStatusIndex {
  const statusByVehicle = new Map<string, TsLiveVehicleStatus>();
  for (const status of data.vehicleStatuses) {
    if (
      !status.location ||
      !Number.isFinite(status.location.lt) ||
      !Number.isFinite(status.location.lg) ||
      Math.abs(status.location.lt) > 90 ||
      Math.abs(status.location.lg) > 180
    )
      continue;
    const previous = statusByVehicle.get(status.vehicleId);
    const previousTime = previous ? Date.parse(previous.when) : NaN;
    const incomingTime = Date.parse(status.when);
    const previousValid =
      Number.isFinite(previousTime) && previousTime <= now + 5_000;
    const incomingValid =
      Number.isFinite(incomingTime) && incomingTime <= now + 5_000;
    if (
      !previous ||
      !previousValid ||
      (incomingValid && incomingTime > previousTime)
    )
      statusByVehicle.set(status.vehicleId, status);
  }
  const vehicles = new Map<string, IVehicle[]>();
  const predictions = new Map<string, IPrediction[]>();
  const spans = new Map<string, ScheduleSpan>();

  for (const ride of data.rides) {
    const routeId = normalizeTsRouteId(ride.routeId);
    addScheduleSpan(spans, routeId, ride);

    const status = ride.vehicleId ? statusByVehicle.get(ride.vehicleId) : null;
    if ('Active' in ride.state && status?.liveDataAvailable) {
      const vehicle = toVehicle(status, routeId);
      append(vehicles, routeId, vehicle);
      for (const stop of awaitingStops(ride)) {
        const eta = new Date(stop.expectedArrivalTime).getTime();
        const prediction = buildPrediction(stop, ride, vehicle.vid, eta, now);
        if (prediction) append(predictions, stop.stopId, prediction);
      }
    } else if ('Scheduled' in ride.state) {
      for (const stop of awaitingStops(ride)) {
        const eta = stop.scheduledDepartureTime
          ? new Date(stop.scheduledDepartureTime).getTime()
          : parseScheduledAt(stop.scheduledAt, ride.scheduledStart);
        const prediction = buildPrediction(stop, ride, 'Scheduled', eta, now);
        if (prediction) append(predictions, stop.stopId, prediction);
      }
    }
  }

  const schedules = new Map<string, TripShotRouteSchedule>();
  for (const [routeId, span] of spans) {
    schedules.set(routeId, {
      firstTrip: formatEasternHourMinute(span.first),
      lastTrip: formatEasternHourMinute(span.last),
      operatingDays: [...span.days].sort((a, b) => a - b)
    });
  }
  return { vehicles, predictions, schedules };
}

export class TripShotLiveStatusService extends PollingFeed<ILiveStatusIndex> {
  private vehiclesByTsRouteId = new Map<string, IVehicle[]>();
  private predictionsByStopId = new Map<string, IPrediction[]>();
  private scheduleByTsRouteId = new Map<string, TripShotRouteSchedule>();

  constructor() {
    super({
      name: 'TripShotLiveStatus',
      intervalMs: 15_000,
      timeoutMs: 10_000,
      maxAgeMs: 90_000
    });
  }

  /** Vehicles for a TripShot route UUID; empty before the first fetch. */
  getVehiclesByTsRouteId(tsRouteId: string): IVehicle[] {
    return this.vehiclesByTsRouteId.get(normalizeTsRouteId(tsRouteId)) ?? [];
  }

  /** Arrivals for a TripShot stop UUID, soonest first. */
  getPredictions(stopId: string): IPrediction[] {
    const now = Date.now();
    return (this.predictionsByStopId.get(stopId) ?? [])
      .filter((p) => p.predictedArrivalTime >= now - STALE_PREDICTION_GRACE_MS)
      .sort((a, b) => a.predictedArrivalTime - b.predictedArrivalTime);
  }

  /** Today's schedule summary for a TripShot route UUID, if any ride exists. */
  getScheduleByTsRouteId(tsRouteId: string): TripShotRouteSchedule | null {
    return this.scheduleByTsRouteId.get(normalizeTsRouteId(tsRouteId)) ?? null;
  }

  protected async fetchSnapshot(
    signal: AbortSignal
  ): Promise<ILiveStatusIndex> {
    const response = await this.fetchOk(TRIPSHOT_LIVE_STATUS_URL, signal);
    return buildIndex((await response.json()) as TsLiveStatus, Date.now());
  }

  protected applySnapshot(index: ILiveStatusIndex): void {
    const vehicles = reconcileVehicleSnapshot(
      [...index.vehicles.values()].flat(),
      [...this.vehiclesByTsRouteId.values()].flat()
    );
    this.vehiclesByTsRouteId = new Map();
    for (const vehicle of vehicles)
      append(this.vehiclesByTsRouteId, vehicle.routeId, vehicle);
    this.predictionsByStopId = index.predictions;
    this.scheduleByTsRouteId = index.schedules;
    let vehicleCount = 0;
    for (const list of index.vehicles.values()) vehicleCount += list.length;
    this.log.info(
      `Updated: ${vehicleCount} active vehicles across ` +
        `${index.vehicles.size} routes, ` +
        `${index.predictions.size} stops with predictions`
    );
  }
}

const tripshotLiveStatusService = new TripShotLiveStatusService();
export default tripshotLiveStatusService;

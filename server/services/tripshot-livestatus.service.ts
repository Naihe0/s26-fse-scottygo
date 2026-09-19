/**
 * TripShot liveStatus Service
 *
 * Polls the TripShot /v1/p/liveStatus endpoint every 30 seconds and stores
 * the decoded data in memory so that API responses have near-zero latency.
 *
 * Public access:
 *   tripshotLiveStatusService.getVehiclesByTsRouteId(tsRouteId) → IVehicle[]
 *   tripshotLiveStatusService.getPredictions(stopId)            → IPrediction[]
 *   tripshotLiveStatusService.start()  — begins the 30-second polling loop
 *   tripshotLiveStatusService.stop()   — clears the interval
 *
 * Only rides whose state contains an "Active" key are considered.  Vehicles
 * are keyed by TripShot route UUID (matches CMURouteMetadata.routeId); callers
 * are responsible for translating "CMU-n" route IDs to TripShot UUIDs before
 * querying this service.
 */

import { IVehicle, IPrediction, IStop } from '../../common/transit.interface';
import {
  TRIPSHOT_LIVE_STATUS_URL,
  TsLiveStatus,
  TsLiveVehicleStatus,
  TsLiveRide,
  TsStopState,
  isTsViaStop
} from './tripshot-api';

/** How often we re-fetch the feed (milliseconds). */
const POLL_INTERVAL_MS = 30_000; // 30 seconds

/** AbortSignal timeout for each fetch. */
const FETCH_TIMEOUT_MS = 10_000;
const MAX_FEED_AGE_MS = 90_000;
/** Ignore arrivals that are already stale beyond this grace period. */
const STALE_PREDICTION_GRACE_MS = 60_000;

function tag(): string {
  return `[TripShotLiveStatus ${new Date().toISOString()}]`;
}

/** Normalize TripShot UUIDs so map keys are case-insensitive. */
function normalizeTsRouteId(routeId: string): string {
  return routeId.trim().toLowerCase();
}

/**
 * Per-route schedule summary aggregated from TripShot `liveStatus` rides.
 * Times are expressed as `HH:MM` in the local time zone of the server so they
 * align with how GTFS schedule data is rendered in the Route Info popup.
 */
export interface TripShotRouteSchedule {
  /** Earliest `scheduledStart` time across today's rides, as "HH:MM". */
  firstTrip: string;
  /** Latest `scheduledEnd` time across today's rides, as "HH:MM". */
  lastTrip: string;
  /** Weekdays (0=Sun..6=Sat) that have at least one ride in the current feed. */
  operatingDays: number[];
}

export class TripShotLiveStatusService {
  /**
   * In-memory store: TripShot routeId UUID → IVehicle[]
   * Only active rides with live GPS data are included.
   */
  private vehiclesByTsRouteId = new Map<string, IVehicle[]>();

  /**
   * In-memory store: TripShot stopId UUID → IPrediction[]
   * Populated from the "Awaiting" entries in each active ride's stopStatus.
   */
  private predictionsByStopId = new Map<string, IPrediction[]>();

  /**
   * In-memory store: TripShot routeId UUID → IStop[]
   * Ordered stop list extracted from the vias of each active ride.
   * Only ViaStop entries are included (waypoints are skipped).
   */
  private stopsByTsRouteId = new Map<string, IStop[]>();

  /**
   * In-memory store: TripShot routeId UUID → TripShotRouteSchedule
   * Aggregates today's ride `scheduledStart`/`scheduledEnd` per route so the
   * Route Info popup can show first/last trip times for CMU shuttles.
   * All rides (Active, Scheduled, Completed) contribute; operatingDays is
   * derived from the set of weekdays covered by those rides.
   */
  private scheduleByTsRouteId = new Map<string, TripShotRouteSchedule>();

  /** Polling interval handle, if active. */
  private intervalId: ReturnType<typeof setInterval> | null = null;

  /** True while a feed fetch/decode cycle is in progress. */
  private fetchInProgress = false;
  private stopped = true;
  private activeRequest: AbortController | null = null;

  /** Timestamp of the last successful fetch. */
  private lastFetched: Date | null = null;

  /** Number of consecutive fetch failures (resets on success). */
  private consecutiveFailures = 0;

  /** Last error message, if the most recent fetch failed. */
  private lastError: string | null = null;

  /**
   * Optional callback invoked once after the first successful feed fetch.
   * Set by the composition root (app.ts) to trigger pattern cache warm-up
   * without creating a circular import between this service and tripshot.service.
   */
  onFirstSuccess: (() => void) | null = null;

  // ── Public API ───────────────────────────────────────────────────────

  /**
   * Return vehicles for a TripShot route UUID.
   * Returns an empty array when no active vehicles are found or the feed
   * has not been fetched yet.
   */
  getVehiclesByTsRouteId(tsRouteId: string): IVehicle[] {
    return this.vehiclesByTsRouteId.get(normalizeTsRouteId(tsRouteId)) ?? [];
  }

  /**
   * Return ETA predictions for a TripShot stop UUID.
   * Returns an empty array when no awaiting vehicles are found.
   */
  getPredictions(stopId: string): IPrediction[] {
    const now = Date.now();
    const predictions = this.predictionsByStopId.get(stopId) ?? [];
    return predictions
      .filter((p) => p.predictedArrivalTime >= now - STALE_PREDICTION_GRACE_MS)
      .sort((a, b) => a.predictedArrivalTime - b.predictedArrivalTime);
  }

  /**
   * Return the ordered stop list for a TripShot route UUID.
   * @param tsRouteId - TripShot route UUID (CMURouteMetadata.routeId)
   * @param cmuRouteId - Our "CMU-n" route ID written into each IStop.routes[]
   */
  getStopsByTsRouteId(tsRouteId: string, cmuRouteId: string): IStop[] {
    return (this.stopsByTsRouteId.get(normalizeTsRouteId(tsRouteId)) ?? []).map(
      (s) => ({
        ...s,
        routes: [cmuRouteId]
      })
    );
  }

  /**
   * Return today's schedule summary for a TripShot route UUID, or `null`
   * when the feed has not produced any rides for that route yet.
   */
  getScheduleByTsRouteId(tsRouteId: string): TripShotRouteSchedule | null {
    return this.scheduleByTsRouteId.get(normalizeTsRouteId(tsRouteId)) ?? null;
  }

  /** When the feed was last successfully fetched. */
  getLastFetched(): Date | null {
    return this.lastFetched;
  }

  /** A live feed is healthy only after a recent successful fetch. */
  isHealthy(): boolean {
    return (
      this.consecutiveFailures === 0 &&
      this.lastFetched !== null &&
      Date.now() - this.lastFetched.getTime() <= MAX_FEED_AGE_MS
    );
  }

  /** Number of consecutive failed fetches. */
  getConsecutiveFailures(): number {
    return this.consecutiveFailures;
  }

  /** Last error message (null if last fetch succeeded). */
  getLastError(): string | null {
    return this.lastError;
  }

  /**
   * Start the polling loop. The first fetch runs immediately so data is
   * available as soon as the server is ready.
   */
  start(): void {
    if (this.intervalId) {
      console.warn(`${tag()} Polling already running`);
      return;
    }
    this.stopped = false;
    console.log(
      `${tag()} Starting polling (every ${POLL_INTERVAL_MS / 1000}s)`
    );
    this.pollTick();
    this.intervalId = setInterval(() => this.pollTick(), POLL_INTERVAL_MS);
    this.intervalId.unref?.();
  }

  /** Stop the polling loop. */
  stop(): void {
    this.stopped = true;
    this.activeRequest?.abort();
    this.activeRequest = null;
    this.fetchInProgress = false;
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      console.log(`${tag()} Polling stopped`);
    }
  }

  // ── Internal ─────────────────────────────────────────────────────────

  private pollTick(): void {
    if (this.stopped) return;
    if (this.fetchInProgress) {
      console.warn(`${tag()} Skipping poll: previous fetch still in progress`);
      return;
    }
    this.fetchAndStore();
  }

  private async fetchAndStore(): Promise<void> {
    if (this.stopped) return;
    const request = new AbortController();
    this.activeRequest = request;
    this.fetchInProgress = true;
    const timeout = setTimeout(() => request.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(TRIPSHOT_LIVE_STATUS_URL, {
        signal: request.signal
      });

      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }

      const data: TsLiveStatus = await res.json();
      if (this.activeRequest !== request || this.stopped) return;

      const { newVehicles, newPredictions, newStops, newSchedules } =
        this.buildIndex(data);

      // Atomic swap — readers never see a half-built index
      this.vehiclesByTsRouteId = newVehicles;
      this.predictionsByStopId = newPredictions;
      this.stopsByTsRouteId = newStops;
      this.scheduleByTsRouteId = newSchedules;
      const isFirstSuccess = this.lastFetched === null;
      this.lastFetched = new Date();
      this.consecutiveFailures = 0;
      this.lastError = null;

      // Trigger a one-time background pattern warm-up after the first successful
      // poll so CMU route polylines are cached before any user selects them.
      if (isFirstSuccess && this.onFirstSuccess) {
        try {
          this.onFirstSuccess();
        } catch (err) {
          console.error(`${tag()} onFirstSuccess callback failed:`, err);
        }
      }

      const totalVehicles = [...newVehicles.values()].reduce(
        (sum, list) => sum + list.length,
        0
      );
      console.log(
        `${tag()} Updated: ${totalVehicles} active vehicles across ` +
          `${newVehicles.size} routes, ` +
          `${newPredictions.size} stops with predictions`
      );
    } catch (err) {
      if (this.activeRequest !== request || this.stopped) return;
      this.consecutiveFailures++;
      this.lastError = err instanceof Error ? err.message : String(err);
      console.error(
        `${tag()} Fetch failed (failures: ${this.consecutiveFailures}):`,
        err
      );
    } finally {
      clearTimeout(timeout);
      if (this.activeRequest === request) {
        this.activeRequest = null;
        this.fetchInProgress = false;
      }
    }
  }

  /**
   * Build fresh in-memory indexes from a raw liveStatus payload.
   * Only active rides are considered for vehicles and predictions.
   * Stops are extracted from ALL rides (active or not) so that routes
   * that have a scheduled ride today but aren't yet/currently active
   * still expose their stop list.
   */
  private buildIndex(data: TsLiveStatus): {
    newVehicles: Map<string, IVehicle[]>;
    newPredictions: Map<string, IPrediction[]>;
    newStops: Map<string, IStop[]>;
    newSchedules: Map<string, TripShotRouteSchedule>;
  } {
    const vsMap = new Map<string, TsLiveVehicleStatus>(
      data.vehicleStatuses.map((vs) => [vs.vehicleId, vs])
    );

    const newVehicles = new Map<string, IVehicle[]>();
    const newPredictions = new Map<string, IPrediction[]>();
    const newStops = new Map<string, IStop[]>();
    const scheduleAccum = new Map<
      string,
      { first: number; last: number; days: Set<number> }
    >();

    for (const ride of data.rides) {
      const normalizedRouteId = normalizeTsRouteId(ride.routeId);

      this.ensureRouteStopsIndexed(newStops, normalizedRouteId, ride);
      this.accumulateRouteSchedule(scheduleAccum, normalizedRouteId, ride);

      const isActive = this.isActive(ride);
      const isScheduled = !isActive && this.isScheduledState(ride);
      if (!isActive && !isScheduled) continue;

      const vs = ride.vehicleId ? vsMap.get(ride.vehicleId) : null;
      if (isActive && vs?.liveDataAvailable) {
        // Live GPS path: use real-time ETAs and show the bus on the map.
        const displayVid = this.addRouteVehicle(
          newVehicles,
          normalizedRouteId,
          vs
        );
        this.addRidePredictions(newPredictions, ride, displayVid);
      } else if (isScheduled) {
        // Not-yet-started trip: scheduledAt times are reliable since the bus
        // hasn't deviated from the schedule yet.  Active rides with no GPS are
        // intentionally skipped — scheduledAt can't reflect where a mid-run
        // bus actually is.
        this.addScheduledRidePredictions(newPredictions, ride);
      }
    }

    const newSchedules = this.finalizeRouteSchedules(scheduleAccum);

    return { newVehicles, newPredictions, newStops, newSchedules };
  }

  /**
   * Fold one ride's `scheduledStart` / `scheduledEnd` into the per-route
   * schedule accumulator.  Invalid or missing timestamps are skipped.
   */
  private accumulateRouteSchedule(
    accum: Map<string, { first: number; last: number; days: Set<number> }>,
    normalizedRouteId: string,
    ride: TsLiveRide
  ): void {
    const start = Date.parse(ride.scheduledStart);
    const end = Date.parse(ride.scheduledEnd);
    if (!Number.isFinite(start) || !Number.isFinite(end)) return;

    const existing = accum.get(normalizedRouteId);
    if (existing) {
      if (start < existing.first) existing.first = start;
      if (end > existing.last) existing.last = end;
      existing.days.add(new Date(start).getDay());
    } else {
      accum.set(normalizedRouteId, {
        first: start,
        last: end,
        days: new Set([new Date(start).getDay()])
      });
    }
  }

  /** Convert the mutable accumulator into the read-only schedule map. */
  private finalizeRouteSchedules(
    accum: Map<string, { first: number; last: number; days: Set<number> }>
  ): Map<string, TripShotRouteSchedule> {
    // TripShot timestamps are Eastern time; format in America/New_York so the
    // displayed first/last trip times match the local schedule regardless of
    // the server's own timezone (typically UTC in production).
    const easternFmt = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    });
    const fmt = (ms: number): string => {
      const parts = easternFmt.formatToParts(new Date(ms));
      const hour = parts.find((p) => p.type === 'hour')?.value ?? '00';
      const minute = parts.find((p) => p.type === 'minute')?.value ?? '00';
      return `${hour}:${minute}`;
    };

    const schedules = new Map<string, TripShotRouteSchedule>();
    for (const [routeId, entry] of accum) {
      schedules.set(routeId, {
        firstTrip: fmt(entry.first),
        lastTrip: fmt(entry.last),
        operatingDays: [...entry.days].sort((a, b) => a - b)
      });
    }
    return schedules;
  }

  private ensureRouteStopsIndexed(
    newStops: Map<string, IStop[]>,
    normalizedRouteId: string,
    ride: TsLiveRide
  ): void {
    // Only record the first ride's stops per route to avoid duplicates
    // (all rides for a route share the same stop sequence).
    if (newStops.has(normalizedRouteId)) {
      return;
    }

    const stops = this.extractStopsFromRide(ride);
    if (stops.length > 0) {
      newStops.set(normalizedRouteId, stops);
    }
  }

  private extractStopsFromRide(ride: TsLiveRide): IStop[] {
    const stops: IStop[] = [];

    for (const via of ride.vias) {
      if (!isTsViaStop(via)) continue;

      const s = via.ViaStop.stop;
      stops.push({
        stopId: s.stopId,
        stopName: s.name,
        lat: s.location.lt,
        lon: s.location.lg,
        routes: [], // caller fills in CMU-n route ID
        dtradd: [],
        dtrrem: []
      });
    }

    return stops;
  }

  private addRouteVehicle(
    newVehicles: Map<string, IVehicle[]>,
    normalizedRouteId: string,
    vs: TsLiveVehicleStatus
  ): string {
    const displayVid = (vs.name || '').trim() || vs.vehicleId;

    const vehicle: IVehicle = {
      vid: displayVid,
      lat: vs.location.lt,
      lon: vs.location.lg,
      routeId: normalizedRouteId, // TripShot UUID; callers rewrite to CMU-n
      heading: vs.bearing ?? 0,
      speed: vs.speed,
      source: 'live',
      lastUpdate: vs.when,
      isDetoured: false
    };

    const vehicleList = newVehicles.get(normalizedRouteId) ?? [];
    vehicleList.push(vehicle);
    newVehicles.set(normalizedRouteId, vehicleList);

    return displayVid;
  }

  private addRidePredictions(
    newPredictions: Map<string, IPrediction[]>,
    ride: TsLiveRide,
    displayVid: string
  ): void {
    for (const ss of ride.stopStatus) {
      if (!('Awaiting' in ss)) continue;
      this.addPrediction(newPredictions, ss, ride, displayVid);
    }
  }

  /** True only for rides whose state object contains the "Active" key. */
  private isActive(ride: TsLiveRide): boolean {
    return 'Active' in ride.state;
  }

  /** True for rides that are scheduled but not yet started. */
  private isScheduledState(ride: TsLiveRide): boolean {
    return 'Scheduled' in ride.state;
  }

  /**
   * Emit scheduled-time predictions for not-yet-started (Scheduled state) rides.
   * Uses `scheduledDepartureTime` (ISO UTC) when present, otherwise parses
   * `scheduledAt` ("HH:MM:SS" Eastern) against the ride's scheduledStart date.
   */
  private addScheduledRidePredictions(
    map: Map<string, IPrediction[]>,
    ride: TsLiveRide
  ): void {
    const now = Date.now();
    for (const ss of ride.stopStatus) {
      if (!('Awaiting' in ss)) continue;
      const awaiting = (ss as Extract<TsStopState, { Awaiting: unknown }>)
        .Awaiting;

      const eta = awaiting.scheduledDepartureTime
        ? new Date(awaiting.scheduledDepartureTime).getTime()
        : this.parseScheduledAt(awaiting.scheduledAt, ride.scheduledStart);

      if (!Number.isFinite(eta)) continue;
      if (eta < now - STALE_PREDICTION_GRACE_MS) continue;

      const minutesFromNow = Math.max(0, Math.round((eta - now) / 60_000));
      const prediction: IPrediction = {
        stopId: awaiting.stopId,
        routeId: ride.routeId,
        vid: 'Scheduled',
        predictedArrivalTime: eta,
        isDelayed: false,
        minutes: minutesFromNow
      };

      this.appendPrediction(map, awaiting.stopId, prediction);
    }
  }

  /**
   * Convert a "HH:MM:SS" Eastern-time string to a UTC millisecond timestamp.
   * The ride's `scheduledStart` (ISO UTC) anchors the calendar date.
   * Handles overnight routes by clamping the day-boundary offset to ±12 h.
   */
  private parseScheduledAt(
    scheduledAt: string,
    rideScheduledStart: string
  ): number {
    const timeParts = this.parseClockTime(scheduledAt);
    if (!timeParts) return NaN;

    const rideStart = new Date(rideScheduledStart);
    if (!Number.isFinite(rideStart.getTime())) return NaN;

    // Get the Eastern calendar date ("YYYY-MM-DD") for the ride's start.
    const dateStr = this.getEasternRideDateString(rideStart);

    // Build a UTC candidate by treating the Eastern local time as if it were UTC.
    const candidate = new Date(
      `${dateStr}T${String(timeParts.hour).padStart(2, '0')}:${String(timeParts.minute).padStart(2, '0')}:${String(timeParts.second).padStart(2, '0')}Z`
    );

    // Find what Eastern time the candidate actually displays as.
    const displayParts = this.getEasternClockParts(candidate);

    // Shift the candidate by the difference to land on the correct UTC instant.
    const diffSec = this.normalizeDayBoundaryOffsetSeconds(
      (timeParts.hour - displayParts.hour) * 3600 +
        (timeParts.minute - displayParts.minute) * 60 +
        (timeParts.second - displayParts.second)
    );

    return candidate.getTime() + diffSec * 1_000;
  }

  private parseClockTime(
    value: string
  ): { hour: number; minute: number; second: number } | null {
    const match = value.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
    if (!match) return null;

    return {
      hour: parseInt(match[1]),
      minute: parseInt(match[2]),
      second: match[3] ? parseInt(match[3]) : 0
    };
  }

  private getEasternRideDateString(rideStart: Date): string {
    return rideStart.toLocaleDateString('en-CA', {
      timeZone: 'America/New_York'
    });
  }

  private getEasternClockParts(value: Date): {
    hour: number;
    minute: number;
    second: number;
  } {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false
    }).formatToParts(value);

    return {
      hour: parseInt(parts.find((p) => p.type === 'hour')?.value ?? '0'),
      minute: parseInt(parts.find((p) => p.type === 'minute')?.value ?? '0'),
      second: parseInt(parts.find((p) => p.type === 'second')?.value ?? '0')
    };
  }

  private normalizeDayBoundaryOffsetSeconds(diffSeconds: number): number {
    // Clamp to ±12 h to handle overnight routes that cross midnight.
    if (diffSeconds > 43_200) return diffSeconds - 86_400;
    if (diffSeconds < -43_200) return diffSeconds + 86_400;
    return diffSeconds;
  }

  private appendPrediction(
    map: Map<string, IPrediction[]>,
    stopId: string,
    prediction: IPrediction
  ): void {
    const list = map.get(stopId) ?? [];
    list.push(prediction);
    map.set(stopId, list);
  }

  /** Push one IPrediction derived from an Awaiting stop status into the map. */
  private addPrediction(
    map: Map<string, IPrediction[]>,
    ss: TsStopState & { Awaiting: unknown },
    ride: TsLiveRide,
    vehicleId: string
  ): void {
    const awaiting = (ss as Extract<TsStopState, { Awaiting: unknown }>)
      .Awaiting;
    const eta = new Date(awaiting.expectedArrivalTime).getTime();
    if (!Number.isFinite(eta)) {
      return;
    }

    const now = Date.now();
    if (eta < now - STALE_PREDICTION_GRACE_MS) {
      return;
    }

    const minutesFromNow = Math.max(0, Math.round((eta - now) / 60_000));

    const prediction: IPrediction = {
      stopId: awaiting.stopId,
      routeId: ride.routeId,
      vid: vehicleId,
      predictedArrivalTime: eta,
      isDelayed: false, // TripShot does not expose a delay flag
      minutes: minutesFromNow
    };

    this.appendPrediction(map, awaiting.stopId, prediction);
  }
}

/** Singleton instance */
const tripshotLiveStatusService = new TripShotLiveStatusService();
export default tripshotLiveStatusService;

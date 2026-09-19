/**
 * GTFS-RT Trip Updates Service
 *
 * Fetches the PRT GTFS-RT trip updates protobuf feed every 30 seconds
 * and stores decoded arrival predictions **in memory** indexed by stopId
 * so that prediction lookups have near-zero latency.
 *
 * This replaces the per-request TrueTime `getpredictions` API call and
 * removes all remaining TrueTime per-request overhead.
 *
 * Public access:
 *   tripUpdatesService.getPredictions(stopId)  → IPrediction[]
 *   tripUpdatesService.start()  — begins the 30-second polling loop
 *   tripUpdatesService.stop()   — clears the interval
 */

import { transit_realtime } from 'gtfs-realtime-bindings';
import { IPrediction } from '../../common/transit.interface';

const GTFSRT_TRIPS_URL = 'https://truetime.portauthority.org/gtfsrt-bus/trips';

/** How often we re-fetch the feed (milliseconds). */
const POLL_INTERVAL_MS = 30_000; // 30 seconds
const FETCH_TIMEOUT_MS = 15_000;
const MAX_FEED_AGE_MS = 90_000;

/** Return a formatted log prefix with ISO timestamp. */
function tag(): string {
  return `[TripUpdates ${new Date().toISOString()}]`;
}

/** Log current process memory usage in MB. */
function logMemoryUsage(): void {
  const mem = process.memoryUsage();
  console.log(
    `${tag()} Memory — rss: ${(mem.rss / 1048576).toFixed(1)}MB, ` +
      `heapUsed: ${(mem.heapUsed / 1048576).toFixed(1)}MB, ` +
      `heapTotal: ${(mem.heapTotal / 1048576).toFixed(1)}MB, ` +
      `external: ${(mem.external / 1048576).toFixed(1)}MB`
  );
}

export class TripUpdatesService {
  /**
   * In-memory store: stopId → IPrediction[]
   * Sorted by arrival time (soonest first).
   */
  private predictionsByStop = new Map<string, IPrediction[]>();

  /** Polling interval handle, if active. */
  private intervalId: ReturnType<typeof setInterval> | null = null;

  /** True while a feed fetch/decode cycle is in progress. */
  private fetchInProgress = false;

  /** Whether an extra poll should run immediately after the current one finishes. */
  private pendingPollTick = false;
  private stopped = true;
  private activeRequest: AbortController | null = null;

  /** Timestamp of the last successful fetch. */
  private lastFetched: Date | null = null;

  /** Number of consecutive fetch failures (resets on success). */
  private consecutiveFailures = 0;

  /** Last error message, if the most recent fetch failed. */
  private lastError: string | null = null;

  // ── Public API ───────────────────────────────────────────────────────

  /**
   * Return upcoming predictions for the given stop.
   * Returns an empty array when no predictions exist or the feed
   * hasn't been fetched yet.
   */
  getPredictions(stopId: string): IPrediction[] {
    const now = Date.now();
    return (this.predictionsByStop.get(stopId) ?? [])
      .filter((prediction) => prediction.predictedArrivalTime >= now)
      .map((prediction) => ({
        ...prediction,
        minutes: Math.round((prediction.predictedArrivalTime - now) / 60_000)
      }));
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
   * Start the polling loop.  The first fetch is performed immediately so
   * that data is available as soon as the server is ready.
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

    // Immediate first fetch
    this.pollTick();

    this.intervalId = setInterval(() => {
      this.pollTick();
    }, POLL_INTERVAL_MS);
  }

  /** Stop the polling loop. */
  stop(): void {
    this.stopped = true;
    this.pendingPollTick = false;
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

  /** Run one poll cycle, skipping if a previous cycle is still in progress. */
  private pollTick(): void {
    if (this.stopped) return;
    if (this.fetchInProgress) {
      this.pendingPollTick = true;
      console.warn(
        `${tag()} Skipping poll tick: previous fetch still in progress`
      );
      return;
    }

    this.fetchAndStore();
  }

  /**
   * Fetch the GTFS-RT binary feed, decode it, and rebuild the in-memory
   * index.  Errors are logged but never thrown — the old data remains
   * available until the next successful fetch.
   */
  private async fetchAndStore(): Promise<void> {
    if (this.stopped) return;
    const request = new AbortController();
    this.activeRequest = request;
    this.fetchInProgress = true;
    const timeout = setTimeout(() => request.abort(), FETCH_TIMEOUT_MS);
    try {
      const response = await fetch(GTFSRT_TRIPS_URL, {
        headers: { Accept: 'application/x-protobuf' },
        signal: request.signal
      });

      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`HTTP ${response.status}`);
      }

      const buffer = await response.arrayBuffer();
      if (this.activeRequest !== request || this.stopped) return;
      const feed = transit_realtime.FeedMessage.decode(new Uint8Array(buffer));

      const nowSec = Math.floor(Date.now() / 1000);
      const byStop = new Map<string, IPrediction[]>();
      let totalPredictions = 0;

      for (const entity of feed.entity) {
        const tu = entity.tripUpdate;
        if (!tu?.trip) continue;

        const routeId = tu.trip.routeId ?? '';
        const vid = tu.vehicle?.id ?? '';

        if (!tu.stopTimeUpdate) continue;

        for (const stu of tu.stopTimeUpdate) {
          const stopId = stu.stopId;
          if (!stopId) continue;

          // Use arrival time if available, fall back to departure
          const arrivalTimeSec =
            (stu.arrival?.time != null
              ? typeof stu.arrival.time === 'number'
                ? stu.arrival.time
                : stu.arrival.time.toNumber()
              : null) ??
            (stu.departure?.time != null
              ? typeof stu.departure.time === 'number'
                ? stu.departure.time
                : stu.departure.time.toNumber()
              : null);

          if (!arrivalTimeSec || arrivalTimeSec < nowSec) continue; // skip past stops

          const minutes = Math.round((arrivalTimeSec - nowSec) / 60);

          const prediction: IPrediction = {
            stopId,
            routeId,
            vid: vid || undefined,
            predictedArrivalTime: arrivalTimeSec * 1000, // store as ms
            isDelayed: false, // GTFS-RT doesn't have a simple boolean
            minutes
          };

          totalPredictions++;
          const list = byStop.get(stopId);
          if (list) {
            list.push(prediction);
          } else {
            byStop.set(stopId, [prediction]);
          }
        }
      }

      // Sort each stop's predictions by arrival time (soonest first)
      for (const predictions of byStop.values()) {
        predictions.sort(
          (a, b) => a.predictedArrivalTime - b.predictedArrivalTime
        );
      }

      // Atomic swap
      this.predictionsByStop = byStop;
      this.lastFetched = new Date();
      this.consecutiveFailures = 0;
      this.lastError = null;

      console.log(
        `${tag()} Updated: ${totalPredictions} predictions across ${byStop.size} stops`
      );
      logMemoryUsage();
    } catch (err) {
      if (this.activeRequest !== request || this.stopped) return;
      this.consecutiveFailures++;
      this.lastError = request.signal.aborted
        ? 'Feed request timed out (>15 s)'
        : err instanceof Error
          ? err.message
          : String(err);
      console.error(
        `${tag()} Fetch failed (failures: ${this.consecutiveFailures}):`,
        err
      );
    } finally {
      clearTimeout(timeout);
      if (this.activeRequest === request) {
        this.activeRequest = null;
        this.fetchInProgress = false;
        if (this.pendingPollTick && !this.stopped) {
          this.pendingPollTick = false;
          void this.fetchAndStore();
        }
      }
    }
  }
}

/** Singleton instance */
const tripUpdatesService = new TripUpdatesService();
export default tripUpdatesService;

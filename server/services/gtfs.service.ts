// Service for Pittsburgh Regional Transit GTFS static schedule data
// GTFS spec: https://gtfs.org/schedule/reference/
// Feed URL: https://www.portauthority.org/business-center/developer-resources/

import { parse as createCsvParser } from 'csv-parse';
import { createWriteStream } from 'fs';
import { unlink } from 'fs/promises';
import { Readable, Writable } from 'stream';
import type { ReadableStream } from 'stream/web';
import { pipeline } from 'stream/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { spawn } from 'child_process';
import {
  IRoute,
  IPattern,
  IStop,
  IDirectionSchedule
} from '../../common/transit.interface';
import { IAppError } from '../../common/server.responses';

const GTFS_URL = 'https://www.rideprt.org/developerresources/GTFS.zip';
const DOWNLOAD_TIMEOUT_MS = 120_000;
const TABLE_TIMEOUT_MS = 5 * 60_000;
const MAX_LOAD_ATTEMPTS = 3;

// GTFS calendar days array indexed by JS getDay() (0=Sun, 1=Mon, ..., 6=Sat)
const GTFS_DAY_COLS = [
  'sunday',
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday'
];

interface ServiceCalendar {
  days: boolean[]; // indexed by JS getDay() — true if service runs that day
  start: string; // YYYYMMDD
  end: string; // YYYYMMDD
}

/** Convert a GTFS time string "HH:MM:SS" (hours may exceed 23) to minutes from midnight. */
export function timeToMinutes(gtfsTime: string): number {
  const parts = gtfsTime.split(':');
  return parseInt(parts[0]) * 60 + parseInt(parts[1]);
}

/** Format a Date as YYYYMMDD for comparison against GTFS date strings. */
export function toGtfsDate(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}${m}${d}`;
}

export class GTFSService {
  private loaded = false;
  private loadPromise: Promise<void> | null = null;

  private routeMap = new Map<string, IRoute>();
  private patternMap = new Map<string, IPattern[]>(); // routeId → patterns
  private stopMap = new Map<string, IStop>(); // stopId → stop details
  private routeStops = new Map<string, IStop[]>(); // routeId → stops (unordered unique)
  private routeDirectionStops = new Map<string, IStop[]>(); // "routeId:DIRECTION" → ordered stops

  // Schedule data
  private tripDirection = new Map<string, string>(); // tripId → direction (INBOUND|OUTBOUND)
  private calendar = new Map<string, ServiceCalendar>(); // serviceId → calendar
  private calendarExceptions = new Map<
    string,
    { added: Set<string>; removed: Set<string> }
  >(); // date (YYYYMMDD) → exceptions
  private tripService = new Map<string, string>(); // tripId → serviceId
  private tripRoute = new Map<string, string>(); // tripId → routeId
  // First and last departure minute (from midnight) per trip — used for time-based route filtering
  private tripTimeRange = new Map<string, { first: number; last: number }>();
  // "routeId:DIRECTION" → representative headsign text for that direction
  private routeDirectionHeadsign = new Map<string, string>();

  // ---------------------------------------------------------------------------
  // load() and its decomposed stages
  // ---------------------------------------------------------------------------

  /**
   * Download the GTFS zip and parse all relevant files.
   * Called once at server startup — non-blocking (fire-and-forget).
   */
  load(): Promise<void> {
    if (this.loaded) return Promise.resolve();
    if (!this.loadPromise) {
      this.loadPromise = this.loadWithRetries().finally(() => {
        this.loadPromise = null;
      });
    }
    return this.loadPromise;
  }

  private async loadWithRetries(): Promise<void> {
    for (let attempt = 1; attempt <= MAX_LOAD_ATTEMPTS; attempt++) {
      let zipPath: string | undefined;
      this.clearData();
      try {
        zipPath = await this.downloadFeed();
        await this.parseStaticFiles(zipPath);
        this.computeOperatingDays();
        await this.streamStopTimes(zipPath);
        this.loaded = true;
        console.log(
          `[GTFS ${new Date().toISOString()}] Ready: ${this.routeMap.size} routes, ${this.tripRoute.size} trips, ${this.stopMap.size} stops`
        );
        return;
      } catch (error) {
        this.clearData();
        if (attempt === MAX_LOAD_ATTEMPTS) throw error;
        console.warn(
          `[GTFS ${new Date().toISOString()}] Load attempt ${attempt} failed; retrying:`,
          error instanceof Error ? error.message : 'Unknown feed error'
        );
      } finally {
        if (zipPath) await unlink(zipPath).catch(() => undefined);
      }
      await new Promise((resolve) => setTimeout(resolve, attempt * 1000));
    }
  }

  private clearData(): void {
    this.loaded = false;
    this.routeMap.clear();
    this.patternMap.clear();
    this.stopMap.clear();
    this.routeStops.clear();
    this.routeDirectionStops.clear();
    this.tripDirection.clear();
    this.calendar.clear();
    this.calendarExceptions.clear();
    this.tripService.clear();
    this.tripRoute.clear();
    this.tripTimeRange.clear();
    this.routeDirectionHeadsign.clear();
  }

  /** Download the GTFS feed and persist the zip to a temp file. */
  private async downloadFeed(): Promise<string> {
    console.log(
      `[GTFS ${new Date().toISOString()}] Downloading feed from PRT...`
    );
    const zipPath = join(tmpdir(), `scottygo-gtfs-${randomUUID()}.zip`);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
    try {
      const res = await fetch(GTFS_URL, { signal: controller.signal });
      if (!res.ok || !res.body) {
        await res.body?.cancel();
        throw new Error(`[GTFS] Failed to download feed: HTTP ${res.status}`);
      }
      // Keep the compressed feed out of the V8 heap on the 512 MB instance.
      await pipeline(
        Readable.fromWeb(res.body as ReadableStream<Uint8Array>),
        createWriteStream(zipPath),
        { signal: controller.signal }
      );
      return zipPath;
    } catch (error) {
      await unlink(zipPath).catch(() => undefined);
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Open the zip and parse routes, stops, shapes, trips, calendar, and
   * calendar_dates into in-memory maps.
   */
  private async parseStaticFiles(zipPath: string): Promise<void> {
    await this.parseRoutes(zipPath);
    await this.parseStops(zipPath);
    const shapePoints = await this.parseShapes(zipPath);
    await this.parseTrips(zipPath, shapePoints);
    await this.parseCalendars(zipPath);
  }

  /** Parse routes.txt → routeMap. */
  private async parseRoutes(zipPath: string): Promise<void> {
    await this.streamTable(zipPath, 'routes.txt', (r) => {
      this.routeMap.set(r.route_id, {
        id: r.route_id,
        name: r.route_short_name || r.route_long_name,
        system: 'PRT',
        color:
          r.route_color && r.route_color.toUpperCase() !== 'FFFFFF'
            ? `#${r.route_color}`
            : '#1e90ff',
        directions: ['INBOUND', 'OUTBOUND'],
        activeStatus: true,
        operatingDays: []
      });
    });
  }

  /** Parse stops.txt → stopMap. */
  private async parseStops(zipPath: string): Promise<void> {
    await this.streamTable(zipPath, 'stops.txt', (s) => {
      this.stopMap.set(s.stop_id, {
        stopId: s.stop_id,
        stopName: s.stop_name,
        lat: parseFloat(s.stop_lat),
        lon: parseFloat(s.stop_lon),
        dtradd: [],
        dtrrem: []
      });
    });
  }

  /** Parse shapes.txt → sorted shape-point map (shapeId → lat/lng[]). */
  private async parseShapes(
    zipPath: string
  ): Promise<Map<string, { lat: number; lng: number }[]>> {
    const seqs = new Map<string, { seq: number; lat: number; lng: number }[]>();
    await this.streamTable(zipPath, 'shapes.txt', (p) => {
      if (!seqs.has(p.shape_id)) seqs.set(p.shape_id, []);
      seqs.get(p.shape_id)!.push({
        seq: parseFloat(p.shape_pt_sequence),
        lat: parseFloat(p.shape_pt_lat),
        lng: parseFloat(p.shape_pt_lon)
      });
    });
    const points = new Map<string, { lat: number; lng: number }[]>();
    for (const [id, pts] of seqs) {
      pts.sort((a, b) => a.seq - b.seq);
      points.set(
        id,
        pts.map((p) => ({ lat: p.lat, lng: p.lng }))
      );
      seqs.delete(id);
    }
    return points;
  }

  /**
   * Parse trips.txt → tripService, tripRoute, tripDirection, patternMap.
   * Consumes the shapePoints map built by parseShapes().
   */
  private async parseTrips(
    zipPath: string,
    shapePoints: Map<string, { lat: number; lng: number }[]>
  ): Promise<void> {
    const seenPatterns = new Set<string>();
    await this.streamTable(zipPath, 'trips.txt', (t) => {
      this.tripService.set(t.trip_id, t.service_id);
      this.tripRoute.set(t.trip_id, t.route_id);
      const tripDir = t.direction_id === '0' ? 'OUTBOUND' : 'INBOUND';
      this.tripDirection.set(t.trip_id, tripDir);

      if (t.trip_headsign) {
        const dirKey = `${t.route_id}:${tripDir}`;
        if (!this.routeDirectionHeadsign.has(dirKey)) {
          this.routeDirectionHeadsign.set(dirKey, t.trip_headsign);
        }
      }

      const patternKey = `${t.route_id}:${t.shape_id}`;
      if (t.shape_id && !seenPatterns.has(patternKey)) {
        seenPatterns.add(patternKey);
        const path = shapePoints.get(t.shape_id) ?? [];
        if (!this.patternMap.has(t.route_id)) {
          this.patternMap.set(t.route_id, []);
        }
        this.patternMap.get(t.route_id)!.push({ direction: tripDir, path });
      }
    });
  }

  /** Parse calendar.txt + calendar_dates.txt → calendar, calendarExceptions. */
  private async parseCalendars(zipPath: string): Promise<void> {
    await this.streamTable(zipPath, 'calendar.txt', (c) => {
      const days = GTFS_DAY_COLS.map((col) => c[col] === '1');
      this.calendar.set(c.service_id, {
        days,
        start: c.start_date,
        end: c.end_date
      });
    });
    await this.streamTable(zipPath, 'calendar_dates.txt', (d) => {
      if (!this.calendarExceptions.has(d.date)) {
        this.calendarExceptions.set(d.date, {
          added: new Set(),
          removed: new Set()
        });
      }
      const ex = this.calendarExceptions.get(d.date)!;
      if (d.exception_type === '1') ex.added.add(d.service_id);
      else if (d.exception_type === '2') ex.removed.add(d.service_id);
    });
  }

  /** Derive operatingDays per route by joining trips → services → calendar days. */
  private computeOperatingDays(): void {
    const routeActiveDays = new Map<string, Set<number>>();
    for (const [tripId, routeId] of this.tripRoute) {
      const serviceId = this.tripService.get(tripId);
      if (!serviceId) continue;
      const cal = this.calendar.get(serviceId);
      if (!cal) continue;
      if (!routeActiveDays.has(routeId))
        routeActiveDays.set(routeId, new Set());
      const days = routeActiveDays.get(routeId)!;
      for (let day = 0; day <= 6; day++) {
        if (cal.days[day]) days.add(day);
      }
    }
    for (const [routeId, days] of routeActiveDays) {
      const route = this.routeMap.get(routeId);
      if (route) route.operatingDays = [...days].sort((a, b) => a - b);
    }
  }

  /**
   * Stream-parse stop_times.txt to build trip time ranges, route→stop and
   * route+direction→stop mappings.  Uses `unzip -p` to avoid loading the
   * entire decompressed file into memory.
   */
  private async streamStopTimes(zipPath: string): Promise<void> {
    const routeStopIds = new Map<string, Set<string>>();
    const routeDirStopIds = new Map<string, Set<string>>();

    await this.streamTable(zipPath, 'stop_times.txt', (st) => {
      const minutes = timeToMinutes(st.departure_time);
      const existing = this.tripTimeRange.get(st.trip_id);
      if (!existing) {
        this.tripTimeRange.set(st.trip_id, { first: minutes, last: minutes });
      } else {
        if (minutes < existing.first) existing.first = minutes;
        if (minutes > existing.last) existing.last = minutes;
      }

      const routeId = this.tripRoute.get(st.trip_id);
      if (routeId && st.stop_id) {
        if (!routeStopIds.has(routeId)) routeStopIds.set(routeId, new Set());
        routeStopIds.get(routeId)!.add(st.stop_id);
        const dir = this.tripDirection.get(st.trip_id);
        if (dir) {
          const dirKey = `${routeId}:${dir}`;
          if (!routeDirStopIds.has(dirKey))
            routeDirStopIds.set(dirKey, new Set());
          routeDirStopIds.get(dirKey)!.add(st.stop_id);
        }
      }
    });

    this.resolveStopIds(routeStopIds, routeDirStopIds);
  }

  /** Stream each table with backpressure, a deadline, and child-process cleanup. */
  private async streamTable(
    zipPath: string,
    filename: string,
    consume: (record: Record<string, string>) => void
  ): Promise<void> {
    console.log(
      `[GTFS ${new Date().toISOString()}] Parsing ${filename} (streaming)...`
    );
    const child = spawn('unzip', ['-p', zipPath, filename]);
    child.stdin.end();
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-4096);
    });
    const parser = createCsvParser({ columns: true, skip_empty_lines: true });
    let rowsSinceYield = 0;
    const sink = new Writable({
      objectMode: true,
      write(record, _encoding, done) {
        try {
          consume(record as Record<string, string>);
          // Continuous pipe output can starve timers/HTTP callbacks even without
          // buffering the whole CSV. Periodically yield while preserving backpressure.
          if (++rowsSinceYield >= 2048) {
            rowsSinceYield = 0;
            setImmediate(done);
          } else {
            done();
          }
        } catch (error) {
          done(error instanceof Error ? error : new Error(String(error)));
        }
      }
    });
    const exited = new Promise<void>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code) => {
        if (code === 0) resolve();
        else
          reject(
            new Error(
              `[GTFS] unzip ${filename} failed (${code}): ${stderr.trim()}`
            )
          );
      });
    });
    const timeout = setTimeout(() => {
      parser.destroy(new Error(`[GTFS] Parsing ${filename} timed out`));
      child.kill();
    }, TABLE_TIMEOUT_MS);
    try {
      // EOF alone is not success: a corrupt/truncated ZIP can emit rows and exit nonzero.
      await Promise.all([pipeline(child.stdout, parser, sink), exited]);
    } finally {
      clearTimeout(timeout);
      if (child.exitCode === null) child.kill();
      child.stdout.destroy();
      parser.destroy();
      sink.destroy();
      // Release the ZIP file handle before the caller deletes its temporary file.
      await exited.catch(() => undefined);
    }
  }

  /** Map route→stopIds and direction→stopIds to resolved IStop objects. */
  private resolveStopIds(
    routeStopIds: Map<string, Set<string>>,
    routeDirStopIds: Map<string, Set<string>>
  ): void {
    for (const [routeId, stopIds] of routeStopIds) {
      const stops: IStop[] = [];
      for (const stopId of stopIds) {
        const stop = this.stopMap.get(stopId);
        if (stop) stops.push(stop);
      }
      this.routeStops.set(routeId, stops);
    }
    for (const [dirKey, stopIds] of routeDirStopIds) {
      const stops: IStop[] = [];
      for (const stopId of stopIds) {
        const stop = this.stopMap.get(stopId);
        if (stop) stops.push(stop);
      }
      this.routeDirectionStops.set(dirKey, stops);
    }
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  isLoaded(): boolean {
    return this.loaded;
  }

  getRoutes(): IRoute[] {
    return [...this.routeMap.values()];
  }

  getPatterns(routeId: string): IPattern[] {
    return this.patternMap.get(routeId) ?? [];
  }

  /**
   * Return the direction ('INBOUND' or 'OUTBOUND') for a given GTFS trip_id,
   * or undefined when the trip is not found in the loaded GTFS data.
   */
  getTripDirection(tripId: string): string | undefined {
    return this.tripDirection.get(tripId);
  }

  /** Return all stops for a route from static GTFS data. */
  getStops(routeId: string): IStop[] {
    return this.routeStops.get(routeId) ?? [];
  }

  /** Return stops for a route filtered by direction (INBOUND or OUTBOUND). */
  getStopsByDirection(routeId: string, direction: string): IStop[] {
    return this.routeDirectionStops.get(`${routeId}:${direction}`) ?? [];
  }

  /**
   * Return all unique stops across every route, with the `routes` field
   * populated to indicate which route IDs serve each stop.
   * Used by TransitSearchStrategy for keyword-based stop search.
   */
  getAllStops(): IStop[] {
    const stopRoutes = new Map<string, Set<string>>();

    for (const [routeId, stops] of this.routeStops.entries()) {
      for (const stop of stops) {
        if (!stopRoutes.has(stop.stopId)) {
          stopRoutes.set(stop.stopId, new Set());
        }
        stopRoutes.get(stop.stopId)!.add(routeId);
      }
    }

    const result: IStop[] = [];
    for (const stop of this.stopMap.values()) {
      result.push({
        ...stop,
        routes: [...(stopRoutes.get(stop.stopId) ?? [])]
      });
    }
    return result;
  }

  /**
   * Return routes that have at least one trip running on the given date,
   * based on GTFS calendar.txt and calendar_dates.txt.
   */

  private assertGtfsLoaded(): void {
    if (!this.loaded) {
      const err: IAppError = {
        type: 'ServerError',
        name: 'GetRequestFailure',
        message: 'GTFS schedule data is not yet loaded'
      };
      throw err;
    }
  }

  filterRoutesByDate(date: Date): IRoute[] {
    this.assertGtfsLoaded();

    const activeServices = this.getActiveServiceIds(date);
    const activeRouteIds = new Set<string>();

    for (const [tripId, serviceId] of this.tripService) {
      if (activeServices.has(serviceId)) {
        const routeId = this.tripRoute.get(tripId);
        if (routeId) activeRouteIds.add(routeId);
      }
    }

    return [...this.routeMap.values()].filter((r) => activeRouteIds.has(r.id));
  }

  /**
   * Return routes that have at least one trip actively running at `time` on the given date.
   * A trip is active if the query time falls within its first–last departure window.
   * @param time "HH:MM" in 24-hour format
   */
  filterRoutesByDateTime(date: Date, time: string): IRoute[] {
    this.assertGtfsLoaded();

    const [h, m] = time.split(':').map(Number);
    const queryMinutes = h * 60 + m;

    const activeServices = this.getActiveServiceIds(date);
    const activeRouteIds = new Set<string>();

    // A trip is considered active if the query time falls within its first–last departure window
    for (const [tripId, range] of this.tripTimeRange) {
      if (range.first <= queryMinutes && range.last >= queryMinutes) {
        const serviceId = this.tripService.get(tripId);
        if (serviceId && activeServices.has(serviceId)) {
          const routeId = this.tripRoute.get(tripId);
          if (routeId) activeRouteIds.add(routeId);
        }
      }
    }

    return [...this.routeMap.values()].filter((r) => activeRouteIds.has(r.id));
  }

  /**
   * Return the schedule summary for a specific route: operating days and
   * first/last trip times per direction.
   */
  getRouteSchedule(routeId: string): {
    operatingDays: number[];
    directions: IDirectionSchedule[];
  } | null {
    this.assertGtfsLoaded();

    const route = this.routeMap.get(routeId);
    if (!route) return null;

    // Collect all trips for this route
    const directionRanges = new Map<string, { first: number; last: number }>();

    for (const [tripId, rId] of this.tripRoute) {
      if (rId !== routeId) continue;
      const range = this.tripTimeRange.get(tripId);
      if (!range) continue;
      const dir = this.tripDirection.get(tripId) ?? 'UNKNOWN';

      const existing = directionRanges.get(dir);
      if (existing) {
        existing.first = Math.min(existing.first, range.first);
        existing.last = Math.max(existing.last, range.last);
      } else {
        directionRanges.set(dir, { first: range.first, last: range.last });
      }
    }

    const directions: IDirectionSchedule[] = [];
    for (const [dir, range] of directionRanges) {
      const fmtTime = (mins: number): string => {
        const h = Math.floor(mins / 60) % 24;
        const m = mins % 60;
        return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}`;
      };
      const headsign = this.routeDirectionHeadsign.get(`${routeId}:${dir}`);
      directions.push({
        direction: dir,
        firstTrip: fmtTime(range.first),
        lastTrip: fmtTime(range.last),
        ...(headsign ? { headsign } : {})
      });
    }

    return {
      operatingDays: route.operatingDays,
      directions
    };
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Compute the set of service_ids active on a given date by applying
   * calendar.txt (regular schedule) and calendar_dates.txt (exceptions).
   */
  private getActiveServiceIds(date: Date): Set<string> {
    const dateStr = toGtfsDate(date);
    const dayIdx = date.getDay(); // 0=Sun...6=Sat

    const active = new Set<string>();

    // Regular schedule
    for (const [serviceId, cal] of this.calendar) {
      if (dateStr >= cal.start && dateStr <= cal.end && cal.days[dayIdx]) {
        active.add(serviceId);
      }
    }

    // Exceptions (added or removed service on specific dates)
    const ex = this.calendarExceptions.get(dateStr);
    if (ex) {
      for (const id of ex.added) active.add(id);
      for (const id of ex.removed) active.delete(id);
    }

    return active;
  }
}

export default new GTFSService();

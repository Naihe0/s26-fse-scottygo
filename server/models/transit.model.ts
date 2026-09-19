// Transit model – in-memory caching layer for GTFS routes, stops, and patterns.
// TrueTime is called ONCE (on startup) solely to obtain route colors.
// Routes/patterns/stops live entirely in server memory (never written to MongoDB).
// Only detours are cached in MongoDB.
//
// Vehicles & predictions remain live (not cached) — they change every few seconds.

import DAC from '../db/dac';
import trueTimeService from '../services/truetime.service';
import gtfsService from '../services/gtfs.service';
import tripshotService from '../services/tripshot.service';
import { validateNearbyRadius } from '../services/transit-query-limits';
import type { IAppError } from '../../common/server.responses';
import {
  parseTransitDate,
  validateTransitTime
} from '../services/transit-date';
import {
  IRoute,
  IStop,
  IPattern,
  IDetour,
  IDetourGeometry,
  ITransitCache,
  IBulkTransitData,
  INearbyStop,
  INearbyStopsPayload,
  INearbyStopsFilters
} from '../../common/transit.interface';

/** How long a cache entry is considered fresh (24 hours in ms). */
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/** Retry interval for TrueTime color fetch when it fails (5 minutes). */
const COLOR_RETRY_INTERVAL_MS = 5 * 60 * 1000;

/** Maximum number of color retry attempts before giving up until next daily refresh. */
const COLOR_MAX_RETRIES = 12; // 12 × 5 min = 1 hour of retrying

const DETOUR_GEOMETRY_TTL_MS = 60_000;
const DETOUR_GEOMETRY_CAPACITY = 64;

// ── Nearby Stops Constants (TUC4 — Discover Stops & Schedules) ─────────

/** Default search radius for nearby stops in meters (TUC4 step 2: ~15 min walk). */
const DEFAULT_NEARBY_RADIUS_M = 1000;

/** Expanded search radius in meters when no stops found at default (TUC4 A6: ~30 min walk). */
const EXPANDED_NEARBY_RADIUS_M = 2000;

/** Walking-time heuristic: minutes to walk one kilometer (TUC4 R4). */
const WALK_MINUTES_PER_KM = 15;

/** Meters per kilometer — used to convert distance to walk-time estimate. */
const METERS_PER_KM = 1000;

/** Mean Earth radius in meters — used in haversine distance formula. */
const EARTH_RADIUS_M = 6_371_000;

// ── Helpers ────────────────────────────────────────────────────────────

/** Build a Date that is `ttl` ms from now. */
function expiresAt(ttl: number = CACHE_TTL_MS): Date {
  return new Date(Date.now() + ttl);
}

/**
 * Haversine formula — computes the great-circle distance between two
 * geographic coordinates on the Earth's surface, returned in meters.
 *
 * Formula:
 *   a = sin²(Δlat/2) + cos(lat1) · cos(lat2) · sin²(Δlon/2)
 *   distance = 2 · R · atan2(√a, √(1−a))
 *
 * where R is the mean Earth radius (6 371 000 m).
 *
 * Exported for unit testing (TUC4).
 */
export function haversineDistanceMeters(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number
): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return EARTH_RADIUS_M * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Walk-time heuristic (TUC4 R4):
 *   walkMinutesEstimate = ⌈(distanceMeters / 1000) × 15⌉
 *
 * Exported for unit testing.
 */
export function computeWalkMinutes(distanceMeters: number): number {
  return Math.ceil((distanceMeters / METERS_PER_KM) * WALK_MINUTES_PER_KM);
}

/** Try to read a non-expired cache entry from MongoDB. */
async function readCache<T>(cacheKey: string): Promise<T | null> {
  const entry = await DAC.db.getTransitCache(cacheKey);
  if (!entry) return null;
  return entry.data as T;
}

/** Write (upsert) a cache entry into MongoDB. */
async function writeCache(
  cacheKey: string,
  dataType: ITransitCache['dataType'],
  data: ITransitCache['data']
): Promise<void> {
  const now = new Date();
  await DAC.db.upsertTransitCache({
    cacheKey,
    dataType,
    data,
    lastUpdated: now,
    expiresAt: expiresAt()
  });
}

// ── Public API ─────────────────────────────────────────────────────────

export class TransitModel {
  /** Whether TrueTime colors have been successfully fetched. */
  private static hasColors = false;

  /** Handle for the color-retry timer (cleared once colors are obtained). */
  private static colorRetryTimer: ReturnType<typeof setInterval> | null = null;

  /** Number of consecutive color-retry failures. */
  private static colorRetryCount = 0;

  /**
   * In-memory snapshot of bulk transit data (routes + patterns + stops).
   * Populated by refreshAllCaches() so client requests never hit MongoDB.
   */
  private static bulkDataCache: IBulkTransitData | null = null;

  private static detourLoad: Promise<IDetour[]> | null = null;
  private static detourCacheClear: Promise<void> | null = null;
  private static detourCacheGeneration = 0;
  private static detourGeometryCache = new Map<
    string,
    { value: IDetourGeometry[]; expiresAt: number }
  >();
  private static detourGeometryLoads = new Map<
    string,
    Promise<IDetourGeometry[]>
  >();

  /** Whether route colors were fetched from TrueTime. */
  static get colorsAvailable(): boolean {
    return TransitModel.hasColors;
  }

  // -------------------------------------------------------------------
  // Routes  (GTFS + TrueTime colors, in-memory)
  // -------------------------------------------------------------------

  /** Return PRT routes from in-memory cache; on miss, build from GTFS. */
  static async getRoutes(): Promise<IRoute[]> {
    if (TransitModel.bulkDataCache) {
      console.log(
        `[TransitModel ${new Date().toISOString()}] Routes served from memory`
      );
      return TransitModel.bulkDataCache.routes;
    }

    console.log(
      `[TransitModel ${new Date().toISOString()}] Routes not in memory — building from GTFS`
    );
    return TransitModel.buildColoredRoutes();
  }

  // -------------------------------------------------------------------
  // Patterns  (GTFS only, in-memory)
  // -------------------------------------------------------------------

  /** Return patterns for a route from in-memory cache; on miss, read GTFS directly. */
  static async getPatterns(routeId: string): Promise<IPattern[]> {
    if (TransitModel.bulkDataCache) {
      console.log(
        `[TransitModel ${new Date().toISOString()}] Patterns for ${routeId} served from memory`
      );
      return TransitModel.bulkDataCache.patterns[routeId] ?? [];
    }

    console.log(
      `[TransitModel ${new Date().toISOString()}] Patterns not in memory for ${routeId} — reading from GTFS`
    );
    if (!gtfsService.isLoaded()) return [];
    return gtfsService.getPatterns(routeId);
  }

  // -------------------------------------------------------------------
  // Stops  (GTFS only, direction-aware, in-memory)
  // -------------------------------------------------------------------

  /** Return stops for a route/direction from in-memory cache; on miss, read GTFS directly. */
  static async getStops(routeId: string, direction: string): Promise<IStop[]> {
    // CMU routes are served by TripShot, not GTFS
    if (routeId.startsWith('CMU-')) {
      try {
        return await tripshotService.getStops(routeId, direction);
      } catch {
        return [];
      }
    }

    if (TransitModel.bulkDataCache) {
      console.log(
        `[TransitModel ${new Date().toISOString()}] Stops for ${routeId}/${direction} served from memory`
      );
      return TransitModel.bulkDataCache.stops[`${routeId}:${direction}`] ?? [];
    }

    console.log(
      `[TransitModel ${new Date().toISOString()}] Stops not in memory for ${routeId}/${direction} — reading from GTFS`
    );
    if (!gtfsService.isLoaded()) return [];
    return gtfsService.getStopsByDirection(routeId, direction);
  }

  // -------------------------------------------------------------------
  // Detours  (TrueTime only, cached)
  // -------------------------------------------------------------------

  /** Filter a detour list by route IDs using detour.routeIds metadata. */
  static filterDetoursByRouteIds(
    detours: IDetour[],
    routeIds?: string[]
  ): IDetour[] {
    if (!routeIds || routeIds.length === 0) return detours;
    // Note that ".filter(Boolean)" filters for truthy values, removing falsy values
    const wanted = new Set(routeIds.map((r) => r.trim()).filter(Boolean));
    if (wanted.size === 0) return detours;

    return detours.filter((d) => {
      const impacted = d.routeIds ?? [];
      return impacted.some((rt) => wanted.has(rt));
    });
  }

  /**
   * Return detours for route(s) using the all-routes cache as the source of truth.
   *
   * This avoids a cache-key mismatch where route-specific requests (e.g., detours:61C)
   * would miss even though detours:all was already cached.
   */
  static async getDetours(routeIds?: string[]): Promise<IDetour[]> {
    if (TransitModel.detourCacheClear) await TransitModel.detourCacheClear;
    const pending =
      TransitModel.detourLoad ??
      TransitModel.loadAllDetours(TransitModel.detourCacheGeneration);
    TransitModel.detourLoad = pending;
    try {
      return TransitModel.filterDetoursByRouteIds(await pending, routeIds);
    } finally {
      if (TransitModel.detourLoad === pending) TransitModel.detourLoad = null;
    }
  }

  private static async loadAllDetours(generation: number): Promise<IDetour[]> {
    const CACHE_KEY = 'detours:all';

    const cached = await readCache<IDetour[]>(CACHE_KEY);
    if (cached) {
      console.log(
        `[TransitModel ${new Date().toISOString()}] Detours (${CACHE_KEY}) served from cache`
      );
      return cached;
    }

    console.log(
      `[TransitModel ${new Date().toISOString()}] Detours cache miss (${CACHE_KEY}) — fetching from TrueTime`
    );
    // Cache ALL route detours at once to limit TrueTime API calls
    try {
      const detours = await trueTimeService.getDetours();
      if (generation === TransitModel.detourCacheGeneration)
        await writeCache(CACHE_KEY, 'detours', detours);
      console.log(
        `[TransitModel ${new Date().toISOString()}] Cached ${detours.length} detours`
      );

      return detours;
    } catch (err) {
      console.warn(
        `[TransitModel ${new Date().toISOString()}] Failed to cache detours:`,
        err
      );
      return [];
    }
  }

  private static async getDetourGeometry(
    routeId: string
  ): Promise<IDetourGeometry[]> {
    if (TransitModel.detourCacheClear) await TransitModel.detourCacheClear;
    const cached = TransitModel.detourGeometryCache.get(routeId);
    if (cached && cached.expiresAt > Date.now()) {
      // Refresh insertion order for least-recently-used eviction.
      TransitModel.detourGeometryCache.delete(routeId);
      TransitModel.detourGeometryCache.set(routeId, cached);
      return cached.value;
    }
    TransitModel.detourGeometryCache.delete(routeId);
    const existing = TransitModel.detourGeometryLoads.get(routeId);
    if (existing) return existing;
    if (TransitModel.detourGeometryLoads.size >= DETOUR_GEOMETRY_CAPACITY) {
      // Avoid unbounded concurrent provider requests from arbitrary distinct IDs.
      throw new Error('Detour geometry is busy; please retry shortly');
    }
    const generation = TransitModel.detourCacheGeneration;
    const pending = trueTimeService.getDetourGeometry(routeId).then((value) => {
      if (generation === TransitModel.detourCacheGeneration) {
        while (
          TransitModel.detourGeometryCache.size >= DETOUR_GEOMETRY_CAPACITY
        ) {
          const oldest = TransitModel.detourGeometryCache.keys().next().value!;
          TransitModel.detourGeometryCache.delete(oldest);
        }
        TransitModel.detourGeometryCache.set(routeId, {
          value,
          expiresAt: Date.now() + DETOUR_GEOMETRY_TTL_MS
        });
      }
      return value;
    });
    TransitModel.detourGeometryLoads.set(routeId, pending);
    try {
      return await pending;
    } finally {
      if (TransitModel.detourGeometryLoads.get(routeId) === pending)
        TransitModel.detourGeometryLoads.delete(routeId);
    }
  }

  /**
   * Return detours augmented with geometry for a single route.
   * Geometry is sourced from TrueTime getpatterns (dtrid/dtrpt fields).
   */
  static async getDetoursWithGeometry(routeId: string): Promise<IDetour[]> {
    const normalizedRouteId =
      typeof routeId === 'string' ? routeId.trim().toUpperCase() : '';
    if (!/^[A-Z0-9][A-Z0-9_-]{0,63}$/.test(normalizedRouteId)) {
      throw {
        type: 'ClientError',
        name: 'RouteNotFound',
        message: 'Invalid route ID'
      } as IAppError;
    }
    const [detours, geometry] = await Promise.all([
      TransitModel.getDetours([normalizedRouteId]),
      TransitModel.getDetourGeometry(normalizedRouteId).catch((err) => {
        console.warn(
          `[TransitModel ${new Date().toISOString()}] Failed to fetch detour geometry for ${routeId}:`,
          err
        );
        return [] as IDetourGeometry[];
      })
    ]);

    if (geometry.length === 0) {
      return detours;
    }

    const geometryByDetourId = new Map<string, IDetourGeometry[]>();
    for (const geom of geometry) {
      const list = geometryByDetourId.get(geom.detourId) ?? [];
      list.push(geom);
      geometryByDetourId.set(geom.detourId, list);
    }

    const merged = detours.map((detour) => ({
      ...detour,
      geometry: geometryByDetourId.get(detour.id) ?? []
    }));

    // Include geometry-only detours if metadata endpoint omitted route linkage.
    for (const [detourId, geom] of geometryByDetourId.entries()) {
      if (!merged.some((d) => d.id === detourId)) {
        merged.push({
          id: detourId,
          description: 'Detour active',
          startdt: '',
          enddt: '',
          routeIds: [normalizedRouteId],
          geometry: geom
        });
      }
    }

    return merged;
  }

  // -------------------------------------------------------------------
  // Bulk data  (routes + patterns + stops in a single response)
  // -------------------------------------------------------------------

  /**
   * Return every piece of static transit data the client needs in one shot.
   * Served entirely from in-memory cache (populated by refreshAllCaches).
   * If memory is empty (before first refresh), builds from GTFS directly.
   */
  static async getAllTransitData(): Promise<IBulkTransitData> {
    // Serve from in-memory cache if available (populated by refreshAllCaches)
    if (TransitModel.bulkDataCache) {
      const c = TransitModel.bulkDataCache;
      console.log(
        `[TransitModel ${new Date().toISOString()}] Bulk data served from memory: ` +
          `${c.routes.length} routes, ${Object.keys(c.patterns).length} pattern sets, ` +
          `${Object.keys(c.stops).length} stop sets`
      );
      return c;
    }

    // Memory empty (before first refresh) — build directly from GTFS
    console.log(
      `[TransitModel ${new Date().toISOString()}] Bulk data not in memory — building from GTFS`
    );

    if (!gtfsService.isLoaded()) {
      return { routes: [], patterns: {}, stops: {} };
    }

    const routes = await TransitModel.buildColoredRoutes();
    const patterns: Record<string, IPattern[]> = {};
    const stops: Record<string, IStop[]> = {};

    for (const route of routes) {
      const p = gtfsService.getPatterns(route.id);
      if (p.length > 0) patterns[route.id] = p;
      for (const dir of route.directions) {
        const s = gtfsService.getStopsByDirection(route.id, dir);
        if (s.length > 0) stops[`${route.id}:${dir}`] = s;
      }
    }

    TransitModel.bulkDataCache = { routes, patterns, stops };
    console.log(
      `[TransitModel ${new Date().toISOString()}] Bulk data built from GTFS: ` +
        `${routes.length} routes, ${Object.keys(patterns).length} pattern sets, ` +
        `${Object.keys(stops).length} stop sets`
    );

    return TransitModel.bulkDataCache;
  }

  // -------------------------------------------------------------------
  // Bulk Refresh  (called once on startup / scheduled daily)
  // -------------------------------------------------------------------

  /**
   * Build the in-memory transit data cache from GTFS + TrueTime colors.
   *
   * 1. Call TrueTime getRoutes **once** to obtain route colors.
   * 2. Merge those colors into the GTFS route list.
   * 3. Build in-memory snapshot of routes, patterns, and stops.
   * 4. Cache detours in MongoDB (the only transit data that uses DB).
   */
  static async refreshAllCaches(): Promise<void> {
    console.log(
      `[TransitModel ${new Date().toISOString()}] ── Starting full cache refresh ──`
    );

    if (!gtfsService.isLoaded()) {
      console.warn(
        `[TransitModel ${new Date().toISOString()}] GTFS not loaded yet — skipping cache refresh`
      );
      return;
    }

    try {
      // 1. Build routes (GTFS base + TrueTime colors)
      const routes = await TransitModel.buildColoredRoutes();
      console.log(
        `[TransitModel ${new Date().toISOString()}] Built ${routes.length} routes`
      );

      // 2. Build in-memory bulk snapshot (routes + patterns + stops)
      const patterns: Record<string, IPattern[]> = {};
      const stops: Record<string, IStop[]> = {};
      for (const route of routes) {
        const p = gtfsService.getPatterns(route.id);
        if (p.length > 0) patterns[route.id] = p;
        for (const dir of route.directions) {
          const s = gtfsService.getStopsByDirection(route.id, dir);
          if (s.length > 0) stops[`${route.id}:${dir}`] = s;
        }
      }
      TransitModel.bulkDataCache = { routes, patterns, stops };
      console.log(
        `[TransitModel ${new Date().toISOString()}] In-memory data ready ` +
          `(${routes.length} routes, ${Object.keys(patterns).length} pattern sets, ` +
          `${Object.keys(stops).length} stop sets)`
      );

      // 3. Cache detours in MongoDB (only transit data that uses DB)
      try {
        const detours = await trueTimeService.getDetours();
        await writeCache('detours:all', 'detours', detours);
        console.log(
          `[TransitModel ${new Date().toISOString()}] Cached ${detours.length} detours`
        );
      } catch (err) {
        console.warn(
          `[TransitModel ${new Date().toISOString()}] Failed to cache detours:`,
          err
        );
      }

      console.log(
        `[TransitModel ${new Date().toISOString()}] ── Cache refresh complete ──`
      );
    } catch (err) {
      console.error(
        `[TransitModel ${new Date().toISOString()}] Cache refresh failed:`,
        err
      );
    }
  }

  // -------------------------------------------------------------------
  // Nearby Stops  (TUC4 — Discover Stops & Schedules)
  // -------------------------------------------------------------------

  /**
   * Return stops within `radiusMeters` of the given coordinates, sorted by
   * distance.  Each result includes the straight-line distance and a walking
   * time estimate computed with the heuristic 1 km = 15 min (TUC4 R4).
   *
   * If no stops are found within 1 000 m the radius is automatically
   * expanded to 2 000 m (TUC4 A6).
   */
  static async getNearbyStops(
    lat: number,
    lon: number,
    radiusMeters: number = DEFAULT_NEARBY_RADIUS_M,
    filters?: INearbyStopsFilters
  ): Promise<INearbyStopsPayload> {
    validateNearbyRadius(radiusMeters);
    // 1. Collect candidate routes
    let routes = await TransitModel.getRoutes();

    // Add CMU routes if available and not filtered to PRT only
    if (!filters?.system || filters.system === 'CMU') {
      try {
        if (tripshotService.isConfigured()) {
          const cmuRoutes = await tripshotService.getRoutes();
          routes = [...routes, ...cmuRoutes];
        }
      } catch {
        // Tripshot unavailable — continue with PRT only
      }
    }

    // Apply system filter
    if (filters?.system) {
      routes = routes.filter((r) => r.system === filters.system);
    }

    // Apply routeId filter
    if (filters?.routeId) {
      routes = routes.filter((r) => r.id === filters.routeId);
    }

    // Apply date/time filter (schedule-aware)
    if (filters?.date && filters?.time) {
      validateTransitTime(filters.time);
      const activeRoutes = gtfsService.filterRoutesByDateTime(
        parseTransitDate(filters.date),
        filters.time
      );
      const activeIds = new Set(activeRoutes.map((r) => r.id));
      routes = routes.filter((r) => activeIds.has(r.id));
    } else if (filters?.date) {
      const activeRoutes = gtfsService.filterRoutesByDate(
        parseTransitDate(filters.date)
      );
      const activeIds = new Set(activeRoutes.map((r) => r.id));
      routes = routes.filter((r) => activeIds.has(r.id));
    }

    // 2. Collect all unique stops from candidate routes
    const stopDataMap = new Map<
      string,
      { stop: IStop; routeIds: Set<string> }
    >();

    for (const route of routes) {
      const directions = filters?.direction
        ? [filters.direction]
        : route.directions;

      for (const dir of directions) {
        const stops = await TransitModel.getStops(route.id, dir);
        for (const stop of stops) {
          const existing = stopDataMap.get(stop.stopId);
          if (existing) {
            existing.routeIds.add(route.id);
          } else {
            stopDataMap.set(stop.stopId, {
              stop,
              routeIds: new Set([route.id])
            });
          }
        }
      }
    }

    // includeRoutes defaults to true per REST spec; when false, omit route IDs
    // from each result to reduce payload size.
    const includeRoutes = filters?.includeRoutes !== false;

    // 3. Filter by distance and build result
    const buildNearbyStops = (radius: number): INearbyStop[] => {
      const result: INearbyStop[] = [];
      for (const { stop, routeIds } of stopDataMap.values()) {
        // Compute straight-line (haversine) distance from member to stop
        const distanceMeters = haversineDistanceMeters(
          lat,
          lon,
          stop.lat,
          stop.lon
        );
        if (distanceMeters <= radius) {
          // Walk-time heuristic (TUC4 R4): 1 km ≈ 15 min of slow walking
          // walkMinutesEstimate = ⌈(distanceMeters / 1000) × 15⌉  (TUC4 R4)
          const walkMinutesEstimate = computeWalkMinutes(distanceMeters);

          result.push({
            stop,
            distanceMeters: Math.round(distanceMeters),
            walkMinutesEstimate,
            routesServingStop: includeRoutes ? [...routeIds] : []
          });
        }
      }
      // Sort ascending so the closest stops appear first
      result.sort((a, b) => a.distanceMeters - b.distanceMeters);
      return result;
    };

    let nearbyStops = buildNearbyStops(radiusMeters);
    let expandedRadiusApplied = false;

    // TUC4 A6: if no stops within the default 1 km radius, automatically
    // double to 2 km (~30 min walk) and flag the expansion in the response.
    if (nearbyStops.length === 0 && radiusMeters === DEFAULT_NEARBY_RADIUS_M) {
      radiusMeters = EXPANDED_NEARBY_RADIUS_M;
      expandedRadiusApplied = true;
      nearbyStops = buildNearbyStops(radiusMeters);
    }

    return {
      center: { lat, lon },
      radiusMeters,
      expandedRadiusApplied,
      stops: nearbyStops
    };
  }

  // -------------------------------------------------------------------
  // Manual cache invalidation
  // -------------------------------------------------------------------

  /** Clear all transit cache entries, or only entries of a specific type. */
  static async clearCache(dataType?: ITransitCache['dataType']): Promise<void> {
    if (!dataType || dataType === 'detours') {
      const priorClear = TransitModel.detourCacheClear;
      const pendingLoad = TransitModel.detourLoad;
      TransitModel.detourCacheGeneration++;
      TransitModel.detourGeometryCache.clear();
      TransitModel.detourGeometryLoads.clear();
      const clearing = (async () => {
        // Finish already-started writes before deleting; new reads wait above.
        await priorClear?.catch(() => undefined);
        await pendingLoad?.catch(() => undefined);
        await DAC.db.clearTransitCache(dataType);
      })();
      TransitModel.detourCacheClear = clearing;
      try {
        await clearing;
      } finally {
        if (TransitModel.detourCacheClear === clearing)
          TransitModel.detourCacheClear = null;
      }
    } else {
      await DAC.db.clearTransitCache(dataType);
    }
    TransitModel.bulkDataCache = null;
    console.log(
      `[TransitModel ${new Date().toISOString()}] Cache cleared${dataType ? ` (type: ${dataType})` : ''}`
    );
  }

  // -------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------

  /**
   * Build the route list from GTFS, then call TrueTime getRoutes **once**
   * to merge real colors.  If TrueTime is unavailable the GTFS default
   * color (#1e90ff) is used instead, and a retry timer is started.
   */
  private static async buildColoredRoutes(): Promise<IRoute[]> {
    if (!gtfsService.isLoaded()) return [];

    const gtfsRoutes = gtfsService.getRoutes();

    // One TrueTime call for colors
    let colorMap = new Map<string, string>();
    try {
      const ttRoutes = await trueTimeService.getRoutes();
      colorMap = new Map(ttRoutes.map((r) => [r.id, r.color]));
      console.log(
        `[TransitModel ${new Date().toISOString()}] Fetched colors for ${colorMap.size} routes from TrueTime`
      );
      TransitModel.hasColors = true;
      TransitModel.stopColorRetry(); // cancel any pending retries
    } catch (err) {
      console.warn(
        `[TransitModel ${new Date().toISOString()}] TrueTime unavailable — using GTFS default colors`
      );
      TransitModel.startColorRetry(); // schedule retry if not already running
    }

    // Merge: use TrueTime color if available, otherwise keep GTFS color
    return gtfsRoutes.map((r) => ({
      ...r,
      color: colorMap.get(r.id) ?? r.color
    }));
  }

  /**
   * Start a periodic retry to fetch TrueTime colors if not already running.
   * Retries every 5 minutes, up to COLOR_MAX_RETRIES times.
   */
  private static startColorRetry(): void {
    if (TransitModel.colorRetryTimer) return; // already running

    TransitModel.colorRetryCount = 0;
    console.log(
      `[TransitModel ${new Date().toISOString()}] Scheduling TrueTime color retry every ${COLOR_RETRY_INTERVAL_MS / 1000}s`
    );

    TransitModel.colorRetryTimer = setInterval(async () => {
      TransitModel.colorRetryCount++;
      console.log(
        `[TransitModel ${new Date().toISOString()}] Color retry attempt ${TransitModel.colorRetryCount}/${COLOR_MAX_RETRIES}`
      );

      try {
        const ttRoutes = await trueTimeService.getRoutes();
        const colorMap = new Map(ttRoutes.map((r) => [r.id, r.color]));
        console.log(
          `[TransitModel ${new Date().toISOString()}] Color retry succeeded — ${colorMap.size} route colors`
        );
        TransitModel.hasColors = true;

        // Rebuild routes with colors and update in-memory cache
        if (gtfsService.isLoaded() && TransitModel.bulkDataCache) {
          const gtfsRoutes = gtfsService.getRoutes();
          const coloredRoutes = gtfsRoutes.map((r) => ({
            ...r,
            color: colorMap.get(r.id) ?? r.color
          }));
          TransitModel.bulkDataCache = {
            ...TransitModel.bulkDataCache,
            routes: coloredRoutes
          };
          console.log(
            `[TransitModel ${new Date().toISOString()}] Updated in-memory routes with TrueTime colors`
          );
        }

        TransitModel.stopColorRetry();
      } catch (err) {
        console.warn(
          `[TransitModel ${new Date().toISOString()}] Color retry ${TransitModel.colorRetryCount} failed:`,
          err instanceof Error ? err.message : err
        );
        if (TransitModel.colorRetryCount >= COLOR_MAX_RETRIES) {
          console.warn(
            `[TransitModel ${new Date().toISOString()}] Max color retries reached — giving up until next daily refresh`
          );
          TransitModel.stopColorRetry();
        }
      }
    }, COLOR_RETRY_INTERVAL_MS);
  }

  /** Stop the color-retry timer. */
  private static stopColorRetry(): void {
    if (TransitModel.colorRetryTimer) {
      clearInterval(TransitModel.colorRetryTimer);
      TransitModel.colorRetryTimer = null;
      TransitModel.colorRetryCount = 0;
    }
  }
}

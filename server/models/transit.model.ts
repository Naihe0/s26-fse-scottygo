// Transit model: in-memory routes, patterns, and stops built from static GTFS,
// with official route colors from TrueTime. Only detours are cached in
// MongoDB. Live vehicles and arrivals come from the GTFS-RT pollers instead.

import DAC from '../db/dac';
import trueTimeService from '../services/truetime.service';
import gtfsService from '../services/gtfs.service';
import tripshotService from '../services/tripshot.service';
import {
  parseTransitDate,
  validateNearbyRadius,
  validateTransitTime
} from '../services/transit-validation';
import { clientError } from '../errors';
import { createLogger, errorMessage } from '../logger';
import { haversineMeters } from '../../common/geo';
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

/** How long a MongoDB detour cache entry stays fresh. */
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/** TrueTime color retries: every 5 minutes for up to an hour. */
const COLOR_RETRY_INTERVAL_MS = 5 * 60 * 1000;
const COLOR_MAX_RETRIES = 12;

const DETOURS_CACHE_KEY = 'detours:all';
const DETOUR_GEOMETRY_TTL_MS = 60_000;
const DETOUR_GEOMETRY_CAPACITY = 64;

/** Default nearby-stop radius (~15 min walk) and its fallback (~30 min). */
const DEFAULT_NEARBY_RADIUS_M = 1000;
const EXPANDED_NEARBY_RADIUS_M = 2000;

/** Walking-time heuristic: minutes to walk one kilometer. */
const WALK_MINUTES_PER_KM = 15;

const log = createLogger('TransitModel');

/** Walk-time heuristic: ⌈(distanceMeters / 1000) × 15⌉ minutes. */
export function computeWalkMinutes(distanceMeters: number): number {
  return Math.ceil((distanceMeters / 1000) * WALK_MINUTES_PER_KM);
}

async function readCache<T>(cacheKey: string): Promise<T | null> {
  const entry = await DAC.db.getTransitCache(cacheKey);
  return entry ? (entry.data as T) : null;
}

async function writeCache(
  cacheKey: string,
  dataType: ITransitCache['dataType'],
  data: ITransitCache['data']
): Promise<void> {
  await DAC.db.upsertTransitCache({
    cacheKey,
    dataType,
    data,
    lastUpdated: new Date(),
    expiresAt: new Date(Date.now() + CACHE_TTL_MS)
  });
}

/** Snapshot of every route's patterns and per-direction stops from GTFS. */
function buildBulkSnapshot(routes: IRoute[]): IBulkTransitData {
  const patterns: Record<string, IPattern[]> = {};
  const stops: Record<string, IStop[]> = {};
  for (const route of routes) {
    const routePatterns = gtfsService.getPatterns(route.id);
    if (routePatterns.length > 0) patterns[route.id] = routePatterns;
    for (const direction of route.directions) {
      const routeStops = gtfsService.getStopsByDirection(route.id, direction);
      if (routeStops.length > 0) stops[`${route.id}:${direction}`] = routeStops;
    }
  }
  return { routes, patterns, stops };
}

function describeSnapshot(snapshot: IBulkTransitData): string {
  return (
    `${snapshot.routes.length} routes, ` +
    `${Object.keys(snapshot.patterns).length} pattern sets, ` +
    `${Object.keys(snapshot.stops).length} stop sets`
  );
}

/** Route ID → official color from TrueTime. Throws when TrueTime fails. */
async function fetchRouteColors(): Promise<Map<string, string>> {
  const routes = await trueTimeService.getRoutes();
  return new Map(routes.map((route) => [route.id, route.color]));
}

function applyRouteColors(
  routes: IRoute[],
  colors: Map<string, string>
): IRoute[] {
  return routes.map((route) => ({
    ...route,
    color: colors.get(route.id) ?? route.color
  }));
}

export class TransitModel {
  private static hasColors = false;
  private static colorRetryTimer: ReturnType<typeof setInterval> | null = null;
  private static colorRetryCount = 0;

  /** Routes, patterns, and stops; populated by refreshAllCaches(). */
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

  // ── Routes, patterns, and stops ─────────────────────────────────────

  /** PRT routes from memory; before the first refresh, built from GTFS. */
  static async getRoutes(): Promise<IRoute[]> {
    return (
      TransitModel.bulkDataCache?.routes ?? TransitModel.buildColoredRoutes()
    );
  }

  static async getPatterns(routeId: string): Promise<IPattern[]> {
    if (TransitModel.bulkDataCache) {
      return TransitModel.bulkDataCache.patterns[routeId] ?? [];
    }
    return gtfsService.isLoaded() ? gtfsService.getPatterns(routeId) : [];
  }

  /** Stops for a route direction. CMU routes are served by TripShot data. */
  static async getStops(routeId: string, direction: string): Promise<IStop[]> {
    if (routeId.startsWith('CMU-')) {
      return tripshotService.getStops(routeId, direction).catch(() => []);
    }
    if (TransitModel.bulkDataCache) {
      return TransitModel.bulkDataCache.stops[`${routeId}:${direction}`] ?? [];
    }
    return gtfsService.isLoaded()
      ? gtfsService.getStopsByDirection(routeId, direction)
      : [];
  }

  /** Routes, patterns, and stops in one payload, built once from GTFS. */
  static async getAllTransitData(): Promise<IBulkTransitData> {
    if (TransitModel.bulkDataCache) return TransitModel.bulkDataCache;
    if (!gtfsService.isLoaded()) return { routes: [], patterns: {}, stops: {} };

    const snapshot = buildBulkSnapshot(await TransitModel.buildColoredRoutes());
    TransitModel.bulkDataCache = snapshot;
    log.info(`Bulk data built from GTFS: ${describeSnapshot(snapshot)}`);
    return snapshot;
  }

  /**
   * Rebuild the in-memory snapshot from GTFS and TrueTime colors, then
   * refresh the MongoDB detour cache. Runs at startup and daily.
   */
  static async refreshAllCaches(): Promise<void> {
    if (!gtfsService.isLoaded()) {
      log.warn('GTFS not loaded yet — skipping cache refresh');
      return;
    }

    try {
      const snapshot = buildBulkSnapshot(
        await TransitModel.buildColoredRoutes()
      );
      TransitModel.bulkDataCache = snapshot;
      log.info(`In-memory data ready (${describeSnapshot(snapshot)})`);

      try {
        const detours = await trueTimeService.getDetours();
        await writeCache(DETOURS_CACHE_KEY, 'detours', detours);
        log.info(`Cached ${detours.length} detours`);
      } catch (err) {
        log.warn('Failed to cache detours:', err);
      }
    } catch (err) {
      log.error('Cache refresh failed:', err);
    }
  }

  // ── Detours ─────────────────────────────────────────────────────────

  /** Keep detours whose routeIds intersect the requested routes. */
  static filterDetoursByRouteIds(
    detours: IDetour[],
    routeIds?: string[]
  ): IDetour[] {
    const wanted = new Set(
      (routeIds ?? []).map((id) => id.trim()).filter(Boolean)
    );
    if (wanted.size === 0) return detours;
    return detours.filter((detour) =>
      (detour.routeIds ?? []).some((id) => wanted.has(id))
    );
  }

  /**
   * Detours for some routes, filtered from the all-routes cache entry so a
   * route-specific request never misses an already cached "all" entry.
   * Concurrent callers share one upstream load.
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
    const cached = await readCache<IDetour[]>(DETOURS_CACHE_KEY);
    if (cached) return cached;

    try {
      const detours = await trueTimeService.getDetours();
      if (generation === TransitModel.detourCacheGeneration)
        await writeCache(DETOURS_CACHE_KEY, 'detours', detours);
      log.info(`Cached ${detours.length} detours`);
      return detours;
    } catch (err) {
      log.warn('Failed to cache detours:', err);
      return [];
    }
  }

  /** Detour geometry with a short, bounded, least-recently-used cache. */
  private static async getDetourGeometry(
    routeId: string
  ): Promise<IDetourGeometry[]> {
    if (TransitModel.detourCacheClear) await TransitModel.detourCacheClear;
    const cache = TransitModel.detourGeometryCache;
    const cached = cache.get(routeId);
    if (cached && cached.expiresAt > Date.now()) {
      // Re-insert to refresh least-recently-used order.
      cache.delete(routeId);
      cache.set(routeId, cached);
      return cached.value;
    }
    cache.delete(routeId);

    const existing = TransitModel.detourGeometryLoads.get(routeId);
    if (existing) return existing;
    if (TransitModel.detourGeometryLoads.size >= DETOUR_GEOMETRY_CAPACITY) {
      // Avoid unbounded concurrent provider requests from arbitrary distinct IDs.
      throw new Error('Detour geometry is busy; please retry shortly');
    }

    const generation = TransitModel.detourCacheGeneration;
    const pending = trueTimeService.getDetourGeometry(routeId).then((value) => {
      if (generation === TransitModel.detourCacheGeneration) {
        while (cache.size >= DETOUR_GEOMETRY_CAPACITY) {
          cache.delete(cache.keys().next().value!);
        }
        cache.set(routeId, {
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
   * Detours for one route with their geometry attached. Geometry-only
   * detours are included even when the metadata feed omits them.
   */
  static async getDetoursWithGeometry(routeId: string): Promise<IDetour[]> {
    const normalizedRouteId =
      typeof routeId === 'string' ? routeId.trim().toUpperCase() : '';
    if (!/^[A-Z0-9][A-Z0-9_-]{0,63}$/.test(normalizedRouteId)) {
      throw clientError('RouteNotFound', 'Invalid route ID');
    }
    const [detours, geometry] = await Promise.all([
      TransitModel.getDetours([normalizedRouteId]),
      TransitModel.getDetourGeometry(normalizedRouteId).catch((err) => {
        log.warn(
          `Failed to fetch detour geometry for ${routeId}:`,
          errorMessage(err)
        );
        return [] as IDetourGeometry[];
      })
    ]);
    if (geometry.length === 0) return detours;

    const geometryByDetourId = new Map<string, IDetourGeometry[]>();
    for (const item of geometry) {
      const list = geometryByDetourId.get(item.detourId) ?? [];
      list.push(item);
      geometryByDetourId.set(item.detourId, list);
    }

    const merged = detours.map((detour) => ({
      ...detour,
      geometry: geometryByDetourId.get(detour.id) ?? []
    }));
    for (const [detourId, detourGeometry] of geometryByDetourId) {
      if (!merged.some((detour) => detour.id === detourId)) {
        merged.push({
          id: detourId,
          description: 'Detour active',
          startdt: '',
          enddt: '',
          routeIds: [normalizedRouteId],
          geometry: detourGeometry
        });
      }
    }
    return merged;
  }

  // ── Nearby stops ────────────────────────────────────────────────────

  /**
   * Stops within `radiusMeters` (straight-line), closest first, with a
   * walking-time estimate. A default-radius search with no results is
   * retried at the expanded radius and flagged in the response.
   */
  static async getNearbyStops(
    lat: number,
    lon: number,
    radiusMeters: number = DEFAULT_NEARBY_RADIUS_M,
    filters: INearbyStopsFilters = {}
  ): Promise<INearbyStopsPayload> {
    validateNearbyRadius(radiusMeters);
    const routes = await TransitModel.getCandidateRoutes(filters);

    const stopsById = new Map<string, { stop: IStop; routeIds: Set<string> }>();
    for (const route of routes) {
      const directions = filters.direction
        ? [filters.direction]
        : route.directions;
      for (const direction of directions) {
        for (const stop of await TransitModel.getStops(route.id, direction)) {
          const entry = stopsById.get(stop.stopId);
          if (entry) entry.routeIds.add(route.id);
          else stopsById.set(stop.stopId, { stop, routeIds: new Set([route.id]) });
        }
      }
    }

    const includeRoutes = filters.includeRoutes !== false;
    const stopsWithin = (radius: number): INearbyStop[] => {
      const result: INearbyStop[] = [];
      for (const { stop, routeIds } of stopsById.values()) {
        const distance = haversineMeters(
          { lat, lng: lon },
          { lat: stop.lat, lng: stop.lon }
        );
        if (distance > radius) continue;
        result.push({
          stop,
          distanceMeters: Math.round(distance),
          walkMinutesEstimate: computeWalkMinutes(distance),
          routesServingStop: includeRoutes ? [...routeIds] : []
        });
      }
      return result.sort((a, b) => a.distanceMeters - b.distanceMeters);
    };

    let stops = stopsWithin(radiusMeters);
    let expandedRadiusApplied = false;
    if (stops.length === 0 && radiusMeters === DEFAULT_NEARBY_RADIUS_M) {
      radiusMeters = EXPANDED_NEARBY_RADIUS_M;
      expandedRadiusApplied = true;
      stops = stopsWithin(radiusMeters);
    }

    return {
      center: { lat, lon },
      radiusMeters,
      expandedRadiusApplied,
      stops
    };
  }

  /** Routes matching the system, route, and schedule filters. */
  private static async getCandidateRoutes(
    filters: INearbyStopsFilters
  ): Promise<IRoute[]> {
    let routes = await TransitModel.getRoutes();
    if (!filters.system || filters.system === 'CMU') {
      routes = routes.concat(await tripshotService.getRoutes().catch(() => []));
    }
    if (filters.system) {
      routes = routes.filter((route) => route.system === filters.system);
    }
    if (filters.routeId) {
      routes = routes.filter((route) => route.id === filters.routeId);
    }
    if (filters.date) {
      const date = parseTransitDate(filters.date);
      if (filters.time) validateTransitTime(filters.time);
      const scheduled = filters.time
        ? gtfsService.filterRoutesByDateTime(date, filters.time)
        : gtfsService.filterRoutesByDate(date);
      const scheduledIds = new Set(scheduled.map((route) => route.id));
      routes = routes.filter((route) => scheduledIds.has(route.id));
    }
    return routes;
  }

  // ── Cache maintenance ───────────────────────────────────────────────

  /** Clear all cached transit data, or only entries of one type. */
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
    log.info(`Cache cleared${dataType ? ` (type: ${dataType})` : ''}`);
  }

  // ── Route colors ────────────────────────────────────────────────────

  /**
   * GTFS routes with TrueTime colors. When TrueTime is unavailable, GTFS
   * colors are kept and a background retry is started.
   */
  private static async buildColoredRoutes(): Promise<IRoute[]> {
    if (!gtfsService.isLoaded()) return [];
    const gtfsRoutes = gtfsService.getRoutes();
    try {
      const colors = await fetchRouteColors();
      log.info(`Fetched colors for ${colors.size} routes from TrueTime`);
      TransitModel.hasColors = true;
      TransitModel.stopColorRetry();
      return applyRouteColors(gtfsRoutes, colors);
    } catch {
      log.warn('TrueTime unavailable — using GTFS default colors');
      TransitModel.startColorRetry();
      return gtfsRoutes;
    }
  }

  /** Retry TrueTime colors periodically until success or the retry limit. */
  private static startColorRetry(): void {
    if (TransitModel.colorRetryTimer) return;
    TransitModel.colorRetryCount = 0;
    TransitModel.colorRetryTimer = setInterval(
      () => void TransitModel.retryRouteColors(),
      COLOR_RETRY_INTERVAL_MS
    );
    TransitModel.colorRetryTimer.unref?.();
  }

  private static async retryRouteColors(): Promise<void> {
    TransitModel.colorRetryCount++;
    try {
      const colors = await fetchRouteColors();
      TransitModel.hasColors = true;
      if (gtfsService.isLoaded() && TransitModel.bulkDataCache) {
        TransitModel.bulkDataCache = {
          ...TransitModel.bulkDataCache,
          routes: applyRouteColors(gtfsService.getRoutes(), colors)
        };
      }
      log.info(`Color retry succeeded — ${colors.size} route colors`);
      TransitModel.stopColorRetry();
    } catch (err) {
      log.warn(
        `Color retry ${TransitModel.colorRetryCount}/${COLOR_MAX_RETRIES} failed:`,
        errorMessage(err)
      );
      if (TransitModel.colorRetryCount >= COLOR_MAX_RETRIES) {
        log.warn('Max color retries reached — giving up until next daily refresh');
        TransitModel.stopColorRetry();
      }
    }
  }

  private static stopColorRetry(): void {
    if (TransitModel.colorRetryTimer) {
      clearInterval(TransitModel.colorRetryTimer);
      TransitModel.colorRetryTimer = null;
      TransitModel.colorRetryCount = 0;
    }
  }
}

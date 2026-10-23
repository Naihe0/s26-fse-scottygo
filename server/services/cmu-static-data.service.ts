// CMU shuttle route names, geometry, and stops from the CSVs in assets/,
// produced by tools/export-cmu-static-from-tripshot.ts. Loaded lazily once.

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { parse } from 'csv-parse/sync';
import { IPattern, IStop } from '../../common/transit.interface';
import { createLogger } from '../logger';

interface IRouteNameRow {
  index: string;
  route_name: string;
}

interface IRouteShapeRow {
  route_id: string;
  pattern_id: string;
  point_index: string;
  lat: string;
  lng: string;
}

interface IRouteStopRow {
  route_id: string;
  stop_order: string;
  stop_id: string;
  stop_name: string;
  lat: string;
  lng: string;
}

type OrderedPoint = { order: number; lat: number; lng: number };
type OrderedStop = IStop & { order: number };

const ASSETS_DIR = join(process.cwd(), 'assets');
const ROUTE_NAMES_CSV = join(ASSETS_DIR, 'CMU_Shuttle_Route_Names.csv');
const ROUTE_SHAPES_CSV = join(ASSETS_DIR, 'cmu_route_shapes.csv');
const ROUTE_STOPS_CSV = join(ASSETS_DIR, 'cmu_route_stops.csv');

const log = createLogger('CMU Static');

function readCsv<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  return parse(readFileSync(path, 'utf8'), {
    columns: true,
    skip_empty_lines: true
  }) as T[];
}

const normalizeRouteId = (routeId: string) => routeId.trim().toLowerCase();

/** Rows without a numeric order sort last. */
function parseOrder(value: string | undefined): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : Number.MAX_SAFE_INTEGER;
}

function groupBy<T>(rows: T[], key: (row: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    const group = groups.get(key(row));
    if (group) group.push(row);
    else groups.set(key(row), [row]);
  }
  return groups;
}

function loadRouteNames(): Map<string, string> {
  const names = new Map<string, string>();
  for (const row of readCsv<IRouteNameRow>(ROUTE_NAMES_CSV)) {
    const index = row.index?.trim();
    const name = row.route_name?.trim();
    if (index && name) names.set(`CMU-${index}`, name);
  }
  return names;
}

/** TripShot route UUID → patterns, each an ordered path of 2+ points. */
function loadRoutePatterns(): Map<string, IPattern[]> {
  const points = new Map<string, Map<string, OrderedPoint[]>>();
  for (const row of readCsv<IRouteShapeRow>(ROUTE_SHAPES_CSV)) {
    const routeId = normalizeRouteId(row.route_id ?? '');
    const point = {
      order: Number(row.point_index),
      lat: Number(row.lat),
      lng: Number(row.lng)
    };
    if (!routeId || !Object.values(point).every(Number.isFinite)) continue;
    const byPattern = points.get(routeId) ?? new Map<string, OrderedPoint[]>();
    points.set(routeId, byPattern);
    const patternId = row.pattern_id?.trim() || 'p0';
    const path = byPattern.get(patternId);
    if (path) path.push(point);
    else byPattern.set(patternId, [point]);
  }

  const patterns = new Map<string, IPattern[]>();
  for (const [routeId, byPattern] of points) {
    const routePatterns = [...byPattern.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([, pathPoints]) =>
        pathPoints
          .sort((a, b) => a.order - b.order)
          .map(({ lat, lng }) => ({ lat, lng }))
      )
      .filter((path) => path.length >= 2)
      .map((path): IPattern => ({ direction: 'OUTBOUND', path }));
    if (routePatterns.length > 0) patterns.set(routeId, routePatterns);
  }
  return patterns;
}

/** TripShot route UUID → unique stops in route order (then by name). */
function loadRouteStops(): Map<string, IStop[]> {
  const rows = readCsv<IRouteStopRow>(ROUTE_STOPS_CSV);
  const stops = new Map<string, IStop[]>();
  for (const [routeId, routeRows] of groupBy(rows, (row) =>
    normalizeRouteId(row.route_id ?? '')
  )) {
    if (!routeId) continue;
    // A stop visited more than once keeps its earliest position.
    const byStopId = new Map<string, OrderedStop>();
    for (const row of routeRows) {
      const stopId = row.stop_id?.trim();
      const stopName = row.stop_name?.trim();
      const lat = Number(row.lat);
      const lon = Number(row.lng);
      const order = parseOrder(row.stop_order);
      if (!stopId || !stopName || !Number.isFinite(lat) || !Number.isFinite(lon))
        continue;
      const existing = byStopId.get(stopId);
      if (!existing || order < existing.order) {
        byStopId.set(stopId, {
          stopId,
          stopName,
          lat,
          lon,
          dtradd: [],
          dtrrem: [],
          order
        });
      }
    }
    const ordered = [...byStopId.values()]
      .sort((a, b) => a.order - b.order || a.stopName.localeCompare(b.stopName))
      .map(({ order: _order, ...stop }) => stop);
    if (ordered.length > 0) stops.set(routeId, ordered);
  }
  return stops;
}

class CmuStaticDataService {
  private data: {
    routeNames: Map<string, string>;
    patterns: Map<string, IPattern[]>;
    stops: Map<string, IStop[]>;
  } | null = null;

  private load() {
    if (!this.data) {
      this.data = {
        routeNames: loadRouteNames(),
        patterns: loadRoutePatterns(),
        stops: loadRouteStops()
      };
      log.info(
        `Loaded static CSV data: ${this.data.routeNames.size} route names, ` +
          `${this.data.patterns.size} route patterns, ` +
          `${this.data.stops.size} route stop sets`
      );
    }
    return this.data;
  }

  getRouteName(cmuRouteId: string): string | null {
    return this.load().routeNames.get(cmuRouteId) ?? null;
  }

  getPatternsForTripshotRoute(tripshotRouteId: string): IPattern[] {
    return this.load().patterns.get(normalizeRouteId(tripshotRouteId)) ?? [];
  }

  /** Stops for a TripShot route, each tagged with the public "CMU-n" ID. */
  getStopsForTripshotRoute(
    tripshotRouteId: string,
    cmuRouteId: string
  ): IStop[] {
    const stops =
      this.load().stops.get(normalizeRouteId(tripshotRouteId)) ?? [];
    return stops.map((stop) => ({ ...stop, routes: [cmuRouteId] }));
  }
}

const cmuStaticDataService = new CmuStaticDataService();
export default cmuStaticDataService;

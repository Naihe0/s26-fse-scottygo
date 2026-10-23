import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';
import { parse } from 'csv-parse/sync';
import {
  decodePolyline,
  isTsViaStop,
  TRIPSHOT_BASE_URL,
  type TripshotRouteResponse
} from './tripshot-route-summary';

interface IRouteRow {
  index: string;
  route_name: string;
  Route_ID?: string;
  route_id?: string;
}

interface IRouteMeta {
  cmuRouteId: string;
  routeName: string;
  tripshotRouteId: string;
}

interface IPoint {
  lat: number;
  lng: number;
}

interface IStopAggregate {
  stopId: string;
  stopName: string;
  lat: number;
  lng: number;
  order: number;
}

interface ISegmentAggregate {
  fromStopId: string;
  toStopId: string;
  distanceMeters: number;
  durationSeconds: number;
}

interface IRouteAggregate {
  patternsBySignature: Map<string, IPoint[]>;
  stopsById: Map<string, IStopAggregate>;
  segmentsByKey: Map<string, ISegmentAggregate>;
}

interface IOptions {
  days: number;
  startDate: string;
  outDir: string;
  timeoutMs: number;
  delayMs: number;
  routeLimit: number | null;
}

const CSV_OPTS = { columns: true as const, skip_empty_lines: true };
const DEFAULT_DAYS = 21;
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_DELAY_MS = 50;
const ROUTE_LIST_CSV = join(
  process.cwd(),
  'assets',
  'CMU_Shuttle_Route_Names.csv'
);

function toIsoDateString(date: Date): string {
  return date.toISOString().split('T')[0];
}

function parseNumberArg(flag: string, fallback: number): number {
  const args = process.argv.slice(2);
  const idx = args.indexOf(flag);
  if (idx < 0 || !args[idx + 1]) {
    return fallback;
  }
  const value = Number(args[idx + 1]);
  return Number.isFinite(value) ? value : fallback;
}

function parseStringArg(flag: string, fallback: string): string {
  const args = process.argv.slice(2);
  const idx = args.indexOf(flag);
  if (idx < 0 || !args[idx + 1]) {
    return fallback;
  }
  return args[idx + 1];
}

function hasFlag(flag: string): boolean {
  return process.argv.slice(2).includes(flag);
}

function parseOptions(): IOptions {
  const startDateDefault = toIsoDateString(new Date());
  const options: IOptions = {
    days: Math.max(1, Math.floor(parseNumberArg('--days', DEFAULT_DAYS))),
    startDate: parseStringArg('--start', startDateDefault),
    outDir: parseStringArg('--out-dir', join(process.cwd(), 'assets')),
    timeoutMs: Math.max(
      1_000,
      Math.floor(parseNumberArg('--timeout-ms', DEFAULT_TIMEOUT_MS))
    ),
    delayMs: Math.max(
      0,
      Math.floor(parseNumberArg('--delay-ms', DEFAULT_DELAY_MS))
    ),
    routeLimit: null
  };

  const routeLimit = parseNumberArg('--route-limit', -1);
  if (routeLimit > 0) {
    options.routeLimit = Math.floor(routeLimit);
  }

  const parsedDate = new Date(`${options.startDate}T00:00:00.000Z`);
  if (Number.isNaN(parsedDate.getTime())) {
    throw new Error(
      `Invalid --start value (${options.startDate}); expected YYYY-MM-DD`
    );
  }

  return options;
}

function printHelp(): void {
  console.log(
    'Export CMU static route geometry/stops from TripShot routeSummary'
  );
  console.log('');
  console.log('Usage:');
  console.log(
    '  npx ts-node tools/export-cmu-static-from-tripshot.ts [options]'
  );
  console.log('');
  console.log('Options:');
  console.log('  --days <n>         Number of days to probe (default: 21)');
  console.log(
    '  --start <date>     Start date YYYY-MM-DD (default: today UTC)'
  );
  console.log('  --out-dir <path>   Output directory (default: assets)');
  console.log('  --route-limit <n>  Process first n routes (debug)');
  console.log('  --timeout-ms <n>   Request timeout in ms (default: 10000)');
  console.log(
    '  --delay-ms <n>     Delay between requests in ms (default: 50)'
  );
  console.log('  --help             Show this help message');
}

function normalizeRouteId(routeId: string): string {
  return routeId.trim().toLowerCase();
}

function readRoutes(): IRouteMeta[] {
  const rows = parse(readFileSync(ROUTE_LIST_CSV, 'utf8'), CSV_OPTS) as
    | IRouteRow[]
    | undefined;
  if (!rows || rows.length === 0) {
    return [];
  }

  const routes: IRouteMeta[] = [];
  const seenCmuRouteIds = new Set<string>();
  const cmuRouteIdByTripshotRouteId = new Map<string, string>();

  for (const row of rows) {
    const index = row.index?.trim();
    const routeName = row.route_name?.trim();
    const routeIdRaw = (row.Route_ID ?? row.route_id)?.trim();

    if (!index || !routeName || !routeIdRaw) {
      continue;
    }

    const cmuRouteId = `CMU-${index}`;
    const tripshotRouteId = normalizeRouteId(routeIdRaw);

    if (seenCmuRouteIds.has(cmuRouteId)) {
      console.warn(
        `[CMU Static Export] Skipping duplicate CMU route row: ${cmuRouteId} (${routeName})`
      );
      continue;
    }

    const existingCmuRouteId = cmuRouteIdByTripshotRouteId.get(tripshotRouteId);
    if (existingCmuRouteId) {
      console.warn(
        `[CMU Static Export] Skipping ${cmuRouteId} (${routeName}) because TripShot route ID ${tripshotRouteId} is already used by ${existingCmuRouteId}`
      );
      continue;
    }

    routes.push({
      cmuRouteId,
      routeName,
      tripshotRouteId
    });

    seenCmuRouteIds.add(cmuRouteId);
    cmuRouteIdByTripshotRouteId.set(tripshotRouteId, cmuRouteId);
  }

  return routes;
}

function getDateByOffset(startDate: string, offset: number): string {
  const baseDate = new Date(`${startDate}T00:00:00.000Z`);
  baseDate.setUTCDate(baseDate.getUTCDate() + offset);
  return toIsoDateString(baseDate);
}

async function fetchRouteSummary(
  routeId: string,
  day: string,
  timeoutMs: number
): Promise<TripshotRouteResponse | null> {
  const url = `${TRIPSHOT_BASE_URL}/routeSummary/${routeId}?day=${day}&withNavigation=true&embedStops=true`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      return null;
    }

    const data = (await response.json()) as TripshotRouteResponse;
    return data;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function toPatternSignature(path: IPoint[]): string {
  const first = path[0];
  const last = path[path.length - 1];
  return `${path.length}:${first.lat.toFixed(5)},${first.lng.toFixed(5)}:${last.lat.toFixed(5)},${last.lng.toFixed(5)}`;
}

function addPatternsFromResponse(
  aggregate: IRouteAggregate,
  data: TripshotRouteResponse
): void {
  for (const service of data.services ?? []) {
    const path: IPoint[] = [];

    for (const leg of service.legs ?? []) {
      for (const step of leg.steps ?? []) {
        const decoded = decodePolyline(step.polyline);
        path.push(...decoded);
      }
    }

    if (path.length < 2) {
      continue;
    }

    const signature = toPatternSignature(path);
    if (!aggregate.patternsBySignature.has(signature)) {
      aggregate.patternsBySignature.set(signature, path);
    }
  }
}

function addStopsFromResponse(
  aggregate: IRouteAggregate,
  data: TripshotRouteResponse
): void {
  for (const ride of data.rides ?? []) {
    let stopOrder = 0;

    for (const via of ride.vias ?? []) {
      if (!isTsViaStop(via)) {
        continue;
      }

      const stop = via.ViaStop.stop;
      const stopId = stop.stopId?.trim();
      const stopName = stop.name?.trim();
      if (!stopId || !stopName) {
        continue;
      }

      const lat = stop.location.lt;
      const lng = stop.location.lg;
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
        continue;
      }

      const existing = aggregate.stopsById.get(stopId);
      if (!existing || stopOrder < existing.order) {
        aggregate.stopsById.set(stopId, {
          stopId,
          stopName,
          lat,
          lng,
          order: stopOrder
        });
      }

      stopOrder += 1;
    }
  }
}

function addSegmentsFromResponse(
  aggregate: IRouteAggregate,
  data: TripshotRouteResponse
): void {
  for (const service of data.services ?? []) {
    for (const leg of service.legs ?? []) {
      const fromStopId = leg.startPoint?.NavViaStop?.stopId?.trim();
      const toStopId = leg.endPoint?.NavViaStop?.stopId?.trim();
      if (!fromStopId || !toStopId) {
        continue;
      }

      const distanceMeters = (leg.steps ?? []).reduce(
        (sum, step) => sum + (Number(step.distanceMeters) || 0),
        0
      );
      const durationSeconds = (leg.steps ?? []).reduce(
        (sum, step) => sum + (Number(step.durationSec) || 0),
        0
      );

      const key = `${fromStopId}>${toStopId}`;
      const existing = aggregate.segmentsByKey.get(key);
      if (!existing) {
        aggregate.segmentsByKey.set(key, {
          fromStopId,
          toStopId,
          distanceMeters,
          durationSeconds
        });
        continue;
      }

      if (distanceMeters > 0 && distanceMeters < existing.distanceMeters) {
        existing.distanceMeters = distanceMeters;
      }
      if (durationSeconds > 0 && durationSeconds < existing.durationSeconds) {
        existing.durationSeconds = durationSeconds;
      }
    }
  }
}

function createAggregate(): IRouteAggregate {
  return {
    patternsBySignature: new Map(),
    stopsById: new Map(),
    segmentsByKey: new Map()
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => {
    setTimeout(resolvePromise, ms);
  });
}

function escapeCsvCell(value: string | number): string {
  const str = String(value);
  if (/[",\n\r]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function dedupeRows(rows: Array<Array<string | number>>): {
  rows: Array<Array<string | number>>;
  removed: number;
} {
  const seen = new Set<string>();
  const deduped: Array<Array<string | number>> = [];
  let removed = 0;

  for (const row of rows) {
    const key = row.map((cell) => String(cell)).join('\u001f');
    if (seen.has(key)) {
      removed += 1;
      continue;
    }
    seen.add(key);
    deduped.push(row);
  }

  return { rows: deduped, removed };
}

function writeCsv(
  outPath: string,
  headers: string[],
  rows: Array<Array<string | number>>
): void {
  const lines = [headers.join(',')];
  for (const row of rows) {
    lines.push(row.map((cell) => escapeCsvCell(cell)).join(','));
  }
  writeFileSync(outPath, `${lines.join('\n')}\n`, 'utf8');
}

async function main(): Promise<void> {
  if (hasFlag('--help')) {
    printHelp();
    return;
  }

  const options = parseOptions();
  const routes = readRoutes();
  if (routes.length === 0) {
    throw new Error('No routes found in assets/CMU_Shuttle_Route_Names.csv');
  }

  const selectedRoutes =
    options.routeLimit && options.routeLimit > 0
      ? routes.slice(0, options.routeLimit)
      : routes;

  const shapeRows: Array<Array<string | number>> = [];
  const stopRows: Array<Array<string | number>> = [];
  const segmentRows: Array<Array<string | number>> = [];

  let totalRequests = 0;
  let successfulResponses = 0;

  console.log(
    `[CMU Static Export] Processing ${selectedRoutes.length} routes over ${options.days} day(s) starting ${options.startDate}`
  );

  for (const route of selectedRoutes) {
    const aggregate = createAggregate();
    let routeHits = 0;

    for (let dayOffset = 0; dayOffset < options.days; dayOffset++) {
      const day = getDateByOffset(options.startDate, dayOffset);
      totalRequests += 1;

      const data = await fetchRouteSummary(
        route.tripshotRouteId,
        day,
        options.timeoutMs
      );

      if (data) {
        routeHits += 1;
        successfulResponses += 1;
        addPatternsFromResponse(aggregate, data);
        addStopsFromResponse(aggregate, data);
        addSegmentsFromResponse(aggregate, data);
      }

      if (options.delayMs > 0) {
        await sleep(options.delayMs);
      }
    }

    const patterns = [...aggregate.patternsBySignature.values()];
    patterns.forEach((path, patternIdx) => {
      const patternId = `p${patternIdx + 1}`;
      path.forEach((point, pointIdx) => {
        shapeRows.push([
          route.tripshotRouteId,
          patternId,
          pointIdx,
          point.lat,
          point.lng
        ]);
      });
    });

    const stops = [...aggregate.stopsById.values()].sort((a, b) => {
      if (a.order !== b.order) {
        return a.order - b.order;
      }
      return a.stopName.localeCompare(b.stopName);
    });
    stops.forEach((stop) => {
      stopRows.push([
        route.tripshotRouteId,
        stop.order,
        stop.stopId,
        stop.stopName,
        stop.lat,
        stop.lng
      ]);
    });

    const segments = [...aggregate.segmentsByKey.values()].sort((a, b) => {
      const keyA = `${a.fromStopId}>${a.toStopId}`;
      const keyB = `${b.fromStopId}>${b.toStopId}`;
      return keyA.localeCompare(keyB);
    });
    segments.forEach((segment, idx) => {
      segmentRows.push([
        route.tripshotRouteId,
        idx,
        segment.fromStopId,
        segment.toStopId,
        Math.round(segment.distanceMeters),
        Math.round(segment.durationSeconds)
      ]);
    });

    console.log(
      `[CMU Static Export] ${route.cmuRouteId} ${route.routeName}: ` +
        `${patterns.length} pattern(s), ${stops.length} stop(s), ${segments.length} segment(s), ${routeHits}/${options.days} day(s) yielded data`
    );
  }

  const outDir = resolve(options.outDir);
  mkdirSync(outDir, { recursive: true });

  const shapesCsv = join(outDir, 'cmu_route_shapes.csv');
  const stopsCsv = join(outDir, 'cmu_route_stops.csv');
  const segmentsCsv = join(outDir, 'cmu_route_segments.csv');

  const dedupedShapeRows = dedupeRows(shapeRows);
  const dedupedStopRows = dedupeRows(stopRows);
  const dedupedSegmentRows = dedupeRows(segmentRows);

  if (
    dedupedShapeRows.removed > 0 ||
    dedupedStopRows.removed > 0 ||
    dedupedSegmentRows.removed > 0
  ) {
    console.warn(
      `[CMU Static Export] Removed duplicate rows: ` +
        `shapes=${dedupedShapeRows.removed}, ` +
        `stops=${dedupedStopRows.removed}, ` +
        `segments=${dedupedSegmentRows.removed}`
    );
  }

  writeCsv(
    shapesCsv,
    ['route_id', 'pattern_id', 'point_index', 'lat', 'lng'],
    dedupedShapeRows.rows
  );
  writeCsv(
    stopsCsv,
    ['route_id', 'stop_order', 'stop_id', 'stop_name', 'lat', 'lng'],
    dedupedStopRows.rows
  );
  writeCsv(
    segmentsCsv,
    [
      'route_id',
      'segment_index',
      'from_stop_id',
      'to_stop_id',
      'distance_meters',
      'duration_seconds'
    ],
    dedupedSegmentRows.rows
  );
  console.log(
    `[CMU Static Export] Complete. Requests=${totalRequests}, responses=${successfulResponses}`
  );
  console.log(`[CMU Static Export] Wrote ${shapesCsv}`);
  console.log(`[CMU Static Export] Wrote ${stopsCsv}`);
  console.log(`[CMU Static Export] Wrote ${segmentsCsv}`);
}

main().catch((error) => {
  console.error('[CMU Static Export] Fatal error:', error);
  process.exit(1);
});

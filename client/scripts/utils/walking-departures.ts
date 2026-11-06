import type { ILatLng } from '../../../common/map.interface';
import type { IPrediction } from '../../../common/transit.interface';
import { keyArrivalRows } from './arrival-identity';

const validTime = (time: number): boolean =>
  Number.isFinite(time) && Number.isFinite(new Date(time).getTime());

/** Keys come from the complete original board, not just the selected subset.
 * Keep the rider's selected visit when it disappears; never choose a substitute. */
export function reconcileWalkingDepartures(
  previous: IPrediction[],
  keys: string[],
  fresh: IPrediction[]
): { rows: IPrediction[]; missingKeys: string[] } {
  const current = new Map(
    [...keyArrivalRows(fresh)].map(([row, key]) => [key, row])
  );
  const counts = new Map<string, number>();
  for (const key of keys) counts.set(key, (counts.get(key) ?? 0) + 1);
  const missingKeys: string[] = [];
  const rows = previous.map((row, index) => {
    const key = keys[index] ?? '';
    const candidate = current.get(key);
    if (key && counts.get(key) === 1 && candidate &&
      candidate.stopId === row.stopId && candidate.routeId === row.routeId &&
      validTime(candidate.predictedArrivalTime)) return candidate;
    missingKeys.push(key);
    return row;
  });
  return { rows, missingKeys };
}

/** Available must include the caller's feed, visit and walking-route freshness checks. */
export function walkingConnection(
  predictionTime: number,
  walkArrival: number,
  buffer: 0 | 2 | 5,
  available: boolean
): { label: string; tight: boolean } | null {
  if (!available || !validTime(predictionTime) || !validTime(walkArrival) ||
    ![0, 2, 5].includes(buffer)) return null;
  const margin = (predictionTime - walkArrival) / 60_000;
  if (margin < 0) return { label: 'May leave before you arrive', tight: true };
  if (buffer > 0 && margin < buffer)
    return { label: `Less than ${buffer} min boarding buffer`, tight: true };
  const spare = Math.floor(margin - buffer);
  return spare < 1
    ? { label: 'Tight connection', tight: true }
    : { label: `About ${spare} min to spare`, tight: false };
}

function validPoint(point: ILatLng): boolean {
  return point !== null && typeof point === 'object' &&
    Number.isFinite(point.lat) && Math.abs(point.lat) <= 90 &&
    Number.isFinite(point.lng) && Math.abs(point.lng) <= 180;
}

/** Official HTTPS links: Apple unified Maps URLs and Google Maps URLs.
 * An omitted origin lets the chosen app obtain its own current location.
 * https://developer.apple.com/documentation/mapkit/unified-map-urls
 * https://developers.google.com/maps/documentation/urls/get-started */
export function walkingMapLinks(
  destination: ILatLng,
  plannedOrigin?: ILatLng
): { apple: string; google: string } | null {
  if (!validPoint(destination) || (plannedOrigin !== undefined && !validPoint(plannedOrigin))) return null;
  const coordinate = (point: ILatLng) => `${point.lat},${point.lng}`;
  const apple = new URL('https://maps.apple.com/directions');
  apple.searchParams.set('destination', coordinate(destination));
  apple.searchParams.set('mode', 'walking');
  const google = new URL('https://www.google.com/maps/dir/');
  google.searchParams.set('api', '1');
  google.searchParams.set('destination', coordinate(destination));
  google.searchParams.set('travelmode', 'walking');
  if (plannedOrigin !== undefined) {
    apple.searchParams.set('source', coordinate(plannedOrigin));
    google.searchParams.set('origin', coordinate(plannedOrigin));
  }
  return { apple: apple.href, google: google.href };
}

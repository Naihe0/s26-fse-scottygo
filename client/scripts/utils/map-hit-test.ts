import type {
  ILatLng,
  IMapSelectionMetadata
} from '../../../common/map.interface';

export interface MapHitTarget {
  selection: IMapSelectionMetadata;
  position?: ILatLng;
  path?: readonly ILatLng[];
  select: () => void;
}

export interface MapHit extends MapHitTarget {
  distance: number;
}

const KIND_ORDER = { bus: 0, stop: 1, route: 2 };
const MAX_LATITUDE = 85.05112878;

/** CSS pixels in an unrotated Web Mercator map; no map SDK or GPS dependency. */
function project(
  position: ILatLng,
  worldSize: number
): { x: number; y: number } {
  const latitude = Math.max(
    -MAX_LATITUDE,
    Math.min(MAX_LATITUDE, position.lat)
  );
  const sin = Math.sin((latitude * Math.PI) / 180);
  return {
    x: ((position.lng + 180) / 360) * worldSize,
    y: (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * worldSize
  };
}

function valid(position: ILatLng): boolean {
  return Number.isFinite(position.lat) && Number.isFinite(position.lng);
}

function segmentDistance(
  a: { x: number; y: number },
  b: { x: number; y: number }
): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSquared = dx * dx + dy * dy;
  const t = lengthSquared
    ? Math.max(0, Math.min(1, -(a.x * dx + a.y * dy) / lengthSquared))
    : 0;
  return Math.hypot(a.x + t * dx, a.y + t * dy);
}

/** Gather nearby visible objects supplied by the provider, deduplicating route casings. */
export function findMapHits(
  position: ILatLng,
  zoom: number,
  targets: readonly MapHitTarget[],
  radius = 24,
  clickedId?: string
): MapHit[] {
  if (!valid(position) || !Number.isFinite(zoom)) return [];
  const worldSize = 256 * 2 ** zoom;
  const origin = project(position, worldSize);
  const relative = (point: ILatLng) => {
    const projected = project(point, worldSize);
    let dx = projected.x - origin.x;
    // Keep points adjacent across the antimeridian adjacent on screen too.
    dx -= Math.round(dx / worldSize) * worldSize;
    return { x: dx, y: projected.y - origin.y };
  };
  const unique = new Map<string, MapHit>();
  for (const target of targets) {
    let distance = Number.POSITIVE_INFINITY;
    if (target.position && valid(target.position)) {
      const point = relative(target.position);
      distance = Math.hypot(point.x, point.y);
    } else if (target.path) {
      for (let i = 1; i < target.path.length; i += 1) {
        if (!valid(target.path[i - 1]) || !valid(target.path[i])) continue;
        distance = Math.min(
          distance,
          segmentDistance(
            relative(target.path[i - 1]),
            relative(target.path[i])
          )
        );
      }
    }
    if (distance > radius && target.selection.id !== clickedId) continue;
    const existing = unique.get(target.selection.id);
    if (!existing || distance < existing.distance)
      unique.set(target.selection.id, { ...target, distance });
  }
  return [...unique.values()].sort(
    (a, b) =>
      KIND_ORDER[a.selection.kind] - KIND_ORDER[b.selection.kind] ||
      a.distance - b.distance ||
      a.selection.label.localeCompare(b.selection.label) ||
      a.selection.id.localeCompare(b.selection.id)
  );
}

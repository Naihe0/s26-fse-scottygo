import type { ILatLng } from '../../../common/map.interface';
import type { IStop } from '../../../common/transit.interface';
import type { IMapState } from '../state/map-state';
import { getToken } from '../services/session';

export type ShortcutFilters = Pick<
  IMapState,
  'selectedRouteId' | 'selectedSystems' | 'selectedDirections'
>;
export type SavedStop = Pick<IStop, 'stopId' | 'stopName' | 'lat' | 'lon'> & {
  routes: string[];
};
export interface SavedPlace extends ILatLng {
  id: string;
  name: string;
  label: string;
}
export interface SavedView {
  id: string;
  name: string;
  filters: ShortcutFilters;
}
export type RecentShortcut =
  | { id: string; kind: 'route'; routeId: string; label: string }
  | { id: string; kind: 'stop'; stop: SavedStop };
export interface RiderShortcuts {
  stops: SavedStop[];
  places: SavedPlace[];
  views: SavedView[];
  recent: RecentShortcut[];
}
export interface ShortcutResult {
  ok: boolean;
  message: string;
}

export const SHORTCUT_LIMITS = {
  stops: 20,
  places: 8,
  views: 8,
  recent: 8
} as const;
const PREFIX = 'scottygo:rider-shortcuts:v2:';
const memory = new Map<string, RiderShortcuts>();
const unavailable = new Set<string>();
const listeners = new Set<(accountChanged?: boolean) => void>();
let lastScope = { key: `${PREFIX}anonymous`, persistent: false };
const temporaryScopes = new Map<string, string>();
let nextId = 0;
const blank = (): RiderShortcuts => ({
  stops: [],
  places: [],
  views: [],
  recent: []
});
const record = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown, max = 160): string =>
  typeof value === 'string' ? value.trim().slice(0, max) : '';
const routeId = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(value);
export const validShortcutStopId = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,119}$/.test(value);
const coordinates = (lat: unknown, lng: unknown): boolean =>
  typeof lat === 'number' &&
  typeof lng === 'number' &&
  Number.isFinite(lat) &&
  Number.isFinite(lng) &&
  Math.abs(lat) <= 90 &&
  Math.abs(lng) <= 180;

function storageScope(): { key: string; persistent: boolean } {
  try {
    const token = getToken();
    if (!token) lastScope = { key: `${PREFIX}anonymous`, persistent: false };
    else {
      let userId: unknown;
      try {
        const encoded = token.split('.')[1];
        const padded = encoded
          .replace(/-/g, '+')
          .replace(/_/g, '/')
          .padEnd(Math.ceil(encoded.length / 4) * 4, '=');
        const payload: unknown = JSON.parse(atob(padded));
        if (record(payload)) userId = payload.userId;
      } catch {
        /* An opaque or malformed session only gets temporary storage. */
      }
      if (typeof userId === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(userId)) {
        // This claim selects a local storage namespace; server auth verifies the JWT.
        // Never read or migrate mutable-username keys from the earlier prototype.
        lastScope = {
          key: `${PREFIX}${encodeURIComponent(`user:${userId}`)}`,
          persistent: true
        };
      } else {
        let key = temporaryScopes.get(token);
        if (!key) {
          key = `${PREFIX}temporary:${temporaryScopes.size + 1}`;
          temporaryScopes.set(token, key);
        }
        lastScope = { key, persistent: false };
      }
    }
  } catch {
    /* Continue the current account's in-memory session. */
  }
  return lastScope;
}

function cleanStop(value: unknown): SavedStop | null {
  if (
    !record(value) ||
    !validShortcutStopId(value.stopId) ||
    !text(value.stopName) ||
    !coordinates(value.lat, value.lon)
  )
    return null;
  return {
    stopId: value.stopId,
    stopName: text(value.stopName),
    lat: value.lat as number,
    lon: value.lon as number,
    routes: Array.isArray(value.routes)
      ? [...new Set(value.routes.filter(routeId))].slice(0, 20)
      : []
  };
}

function cleanFilters(value: unknown): ShortcutFilters | null {
  if (
    !record(value) ||
    !record(value.selectedSystems) ||
    !record(value.selectedDirections)
  )
    return null;
  if (value.selectedRouteId !== null && !routeId(value.selectedRouteId))
    return null;
  const { prt, cmu } = value.selectedSystems;
  const { inbound, outbound } = value.selectedDirections;
  if ([prt, cmu, inbound, outbound].some((flag) => typeof flag !== 'boolean'))
    return null;
  return {
    selectedRouteId: value.selectedRouteId as string | null,
    selectedSystems: { prt: prt as boolean, cmu: cmu as boolean },
    selectedDirections: {
      inbound: inbound as boolean,
      outbound: outbound as boolean
    }
  };
}

function unique<T>(
  values: T[],
  identity: (value: T) => string,
  limit: number
): T[] {
  const ids = new Set<string>();
  return values
    .filter((value) => {
      const id = identity(value);
      if (ids.has(id)) return false;
      ids.add(id);
      return true;
    })
    .slice(0, limit);
}

function clean(value: unknown): RiderShortcuts {
  if (!record(value)) return blank();
  const result = blank();
  if (Array.isArray(value.stops))
    result.stops = unique(
      value.stops
        .map(cleanStop)
        .filter((stop): stop is SavedStop => stop !== null),
      (stop) => stop.stopId,
      SHORTCUT_LIMITS.stops
    );
  if (Array.isArray(value.places)) {
    for (const place of value.places) {
      if (
        !record(place) ||
        !text(place.id, 80) ||
        !text(place.name, 60) ||
        !coordinates(place.lat, place.lng)
      )
        continue;
      result.places.push({
        id: text(place.id, 80),
        name: text(place.name, 60),
        label: text(place.label),
        lat: place.lat as number,
        lng: place.lng as number
      });
    }
    result.places = unique(
      result.places,
      (place) => place.id,
      SHORTCUT_LIMITS.places
    );
  }
  if (Array.isArray(value.views)) {
    for (const view of value.views) {
      if (!record(view) || !text(view.id, 80) || !text(view.name, 60)) continue;
      const filters = cleanFilters(view.filters);
      if (filters)
        result.views.push({
          id: text(view.id, 80),
          name: text(view.name, 60),
          filters
        });
    }
    result.views = unique(
      result.views,
      (view) => view.id,
      SHORTCUT_LIMITS.views
    );
  }
  if (Array.isArray(value.recent)) {
    for (const item of value.recent) {
      if (!record(item)) continue;
      if (item.kind === 'route' && routeId(item.routeId))
        result.recent.push({
          id: `route:${item.routeId}`,
          kind: 'route',
          routeId: item.routeId,
          label: text(item.label) || `Route ${item.routeId}`
        });
      if (item.kind === 'stop') {
        const stop = cleanStop(item.stop);
        if (stop)
          result.recent.push({ id: `stop:${stop.stopId}`, kind: 'stop', stop });
      }
    }
    result.recent = unique(
      result.recent,
      (item) => item.id,
      SHORTCUT_LIMITS.recent
    );
  }
  return result;
}

/** Local to the immutable account ID and browser. Never persists tokens or automatic GPS history. */
export function getRiderShortcuts(): RiderShortcuts {
  const { key, persistent } = storageScope();
  if (!persistent || unavailable.has(key)) return clean(memory.get(key));
  let stored: string | null;
  try {
    stored = localStorage.getItem(key);
  } catch {
    return clean(memory.get(key));
  }
  try {
    const result =
      stored && stored.length < 100_000 ? clean(JSON.parse(stored)) : blank();
    memory.set(key, result);
    return clean(result);
  } catch {
    memory.set(key, blank());
    return blank();
  }
}

function write(data: RiderShortcuts): void {
  const { key, persistent } = storageScope();
  const safe = clean(data);
  memory.set(key, safe);
  if (persistent) {
    try {
      localStorage.setItem(key, JSON.stringify(safe));
      unavailable.delete(key);
    } catch {
      unavailable.add(key);
    }
  }
  listeners.forEach((listener) => listener());
}

function onStorage(event: StorageEvent): void {
  const previousKey = lastScope.key;
  const { key } = storageScope();
  if (event.key === 'token' || (event.key === null && previousKey !== key)) {
    listeners.forEach((listener) => listener(previousKey !== key));
    return;
  }
  if (event.key !== null && event.key !== key) return;
  unavailable.delete(key);
  memory.delete(key);
  listeners.forEach((listener) => listener());
}

export function subscribeRiderShortcuts(
  listener: (accountChanged?: boolean) => void
): () => void {
  if (listeners.size === 0) window.addEventListener('storage', onStorage);
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) window.removeEventListener('storage', onStorage);
  };
}

export function isStopSaved(stopId: string): boolean {
  return getRiderShortcuts().stops.some((stop) => stop.stopId === stopId);
}

export function toggleSavedStop(
  stop: Pick<IStop, 'stopId' | 'stopName' | 'lat' | 'lon' | 'routes'>
): ShortcutResult & { saved: boolean } {
  const safe = cleanStop(stop);
  if (!safe)
    return {
      ok: false,
      saved: false,
      message: 'This stop cannot be saved yet.'
    };
  const data = getRiderShortcuts();
  const existing = data.stops.findIndex((item) => item.stopId === safe.stopId);
  if (existing >= 0) {
    data.stops.splice(existing, 1);
    write(data);
    return { ok: true, saved: false, message: 'Stop removed from My places.' };
  }
  if (data.stops.length >= SHORTCUT_LIMITS.stops)
    return {
      ok: false,
      saved: false,
      message: 'You have 20 saved stops. Remove one to save another.'
    };
  data.stops.unshift(safe);
  write(data);
  return { ok: true, saved: true, message: 'Stop saved in My places.' };
}

function newId(): string {
  nextId += 1;
  return `${Date.now().toString(36)}-${nextId}`;
}

export function savePlace(
  name: string,
  position: ILatLng,
  label = ''
): ShortcutResult {
  if (!text(name, 60) || !coordinates(position.lat, position.lng))
    return {
      ok: false,
      message: 'Enter a name and choose a valid planning location.'
    };
  const data = getRiderShortcuts();
  if (data.places.length >= SHORTCUT_LIMITS.places)
    return {
      ok: false,
      message: 'You have 8 places. Remove one to add another.'
    };
  data.places.unshift({
    id: newId(),
    name: text(name, 60),
    lat: position.lat,
    lng: position.lng,
    label: text(label)
  });
  write(data);
  return { ok: true, message: 'Planning place saved.' };
}

export function saveFilterView(
  name: string,
  filters: ShortcutFilters
): ShortcutResult {
  const safe = cleanFilters(filters);
  if (!text(name, 60) || !safe)
    return { ok: false, message: 'Enter a name for this map view.' };
  const data = getRiderShortcuts();
  if (data.views.length >= SHORTCUT_LIMITS.views)
    return {
      ok: false,
      message: 'You have 8 views. Remove one to add another.'
    };
  data.views.unshift({ id: newId(), name: text(name, 60), filters: safe });
  write(data);
  return { ok: true, message: 'Map view saved.' };
}

export function renameShortcut(
  kind: 'place' | 'view',
  id: string,
  name: string
): ShortcutResult {
  if (!text(name, 60)) return { ok: false, message: 'Enter a name.' };
  const data = getRiderShortcuts();
  const item = (kind === 'place' ? data.places : data.views).find(
    (entry) => entry.id === id
  );
  if (!item)
    return { ok: false, message: 'This shortcut is no longer available.' };
  item.name = text(name, 60);
  write(data);
  return { ok: true, message: 'Name updated.' };
}

export function removeShortcut(
  kind: 'stop' | 'place' | 'view' | 'recent',
  id: string
): void {
  const data = getRiderShortcuts();
  if (kind === 'stop')
    data.stops = data.stops.filter((stop) => stop.stopId !== id);
  if (kind === 'place')
    data.places = data.places.filter((place) => place.id !== id);
  if (kind === 'view') data.views = data.views.filter((view) => view.id !== id);
  if (kind === 'recent')
    data.recent = data.recent.filter((item) => item.id !== id);
  write(data);
}

export function clearRecentShortcuts(): void {
  const data = getRiderShortcuts();
  data.recent = [];
  write(data);
}

function recordRecent(item: RecentShortcut): void {
  const data = getRiderShortcuts();
  data.recent = [
    item,
    ...data.recent.filter((existing) => existing.id !== item.id)
  ].slice(0, SHORTCUT_LIMITS.recent);
  write(data);
}

export function recordRecentStop(
  stop: Pick<IStop, 'stopId' | 'stopName' | 'lat' | 'lon' | 'routes'>
): void {
  const safe = cleanStop(stop);
  if (safe)
    recordRecent({ id: `stop:${safe.stopId}`, kind: 'stop', stop: safe });
}

export function recordRecentRoute(id: string, label = `Route ${id}`): void {
  if (routeId(id))
    recordRecent({
      id: `route:${id}`,
      kind: 'route',
      routeId: id,
      label: text(label) || `Route ${id}`
    });
}

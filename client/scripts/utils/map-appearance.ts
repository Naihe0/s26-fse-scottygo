import {
  DEFAULT_MAP_APPEARANCE,
  normalizeMapAppearance,
  type MapAppearance
} from '../../../common/map-appearance';

const KEY = 'scottygo.mapAppearance.v1';
let lastKnown: MapAppearance = { ...DEFAULT_MAP_APPEARANCE };
let unsaved: MapAppearance | null = null;

/** These browser-wide preferences contain no location, journey or account data. */
export function readMapAppearance(): MapAppearance {
  if (unsaved) return { ...unsaved };
  try {
    const raw = localStorage.getItem(KEY);
    try {
      lastKnown = normalizeMapAppearance(raw === null ? null : JSON.parse(raw));
    } catch {
      lastKnown = { ...DEFAULT_MAP_APPEARANCE };
    }
  } catch {
    // Storage restrictions leave the current page's choice usable.
  }
  return { ...lastKnown };
}

/** Apply immediately in memory and report whether the preference was persisted. */
export function writeMapAppearance(value: MapAppearance): boolean {
  lastKnown = normalizeMapAppearance(value);
  try {
    localStorage.setItem(KEY, JSON.stringify(lastKnown));
    unsaved = null;
    return true;
  } catch {
    unsaved = { ...lastKnown };
    return false;
  }
}

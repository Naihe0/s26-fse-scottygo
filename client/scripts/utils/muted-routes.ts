// Foreground popup choices belong to the immutable account in this browser.
// The legacy browser-wide list has no known owner and is left untouched.
import { getSessionUserId, getToken } from '../services/session';
import { normalizeRouteId } from './route-display';

export type RoutePopupPreference =
  | { mode: 'enabled' | 'muted' }
  | { mode: 'paused'; resumeAt: number };
type Reason = 'preferences' | 'session';
type Preferences = Map<string, RoutePopupPreference>;
const PREFIX = 'scottygo:route-popups:v2:';
const memory = new Map<string, Preferences>();
const dirty = new Set<string>();
const temporary = new Map<string | null, string>();
const listeners = new Set<(reason: Reason) => void>();
let expiryTimer: ReturnType<typeof setTimeout> | undefined;
let observedToken: string | null = null;
let lastScope = { key: PREFIX + 'signed-out', persistent: false };

function currentToken(): string | null {
  try { return getToken(); } catch { return observedToken; }
}

function scope(): typeof lastScope {
  const token = currentToken();
  const id = getSessionUserId(token);
  if (id) lastScope = { key: PREFIX + encodeURIComponent('user:' + id), persistent: true };
  else {
    if (!temporary.has(token)) temporary.set(token, PREFIX + 'temporary:' + temporary.size);
    lastScope = { key: temporary.get(token)!, persistent: false };
  }
  return lastScope;
}

function routeKey(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const key = normalizeRouteId(value);
  return /^[a-z0-9_-]{1,80}$/.test(key) ? key : null;
}

function normalize(value: unknown): RoutePopupPreference {
  if (value && typeof value === 'object') {
    const p = value as { mode?: unknown; resumeAt?: unknown };
    if (p.mode === 'muted') return { mode: 'muted' };
    if (p.mode === 'paused' && typeof p.resumeAt === 'number' &&
        Number.isFinite(p.resumeAt) && p.resumeAt > Date.now() &&
        p.resumeAt <= Date.now() + 86_400_000)
      return { mode: 'paused', resumeAt: p.resumeAt };
  }
  return { mode: 'enabled' };
}

function read(): Preferences {
  const { key, persistent } = scope();
  let entries: unknown = Array.from(memory.get(key) ?? []);
  if (persistent && !dirty.has(key)) {
    try { entries = JSON.parse(localStorage.getItem(key) ?? '[]'); }
    catch { /* Keep this account's current-page choices when storage fails. */ }
  }
  const clean: Preferences = new Map();
  if (Array.isArray(entries)) for (const entry of entries.slice(0, 512)) {
    if (!Array.isArray(entry) || entry.length !== 2) continue;
    const route = routeKey(entry[0]);
    const preference = normalize(entry[1]);
    if (route && preference.mode !== 'enabled') clean.set(route, preference);
  }
  memory.set(key, clean);
  return clean;
}

function scheduleExpiry(): void {
  clearTimeout(expiryTimer);
  expiryTimer = undefined;
  if (!listeners.size || document.hidden) return;
  const next = Math.min(...Array.from(read().values()).map(p =>
    p.mode === 'paused' ? p.resumeAt : Infinity));
  if (Number.isFinite(next)) expiryTimer = setTimeout(() => notify(), Math.max(1, next - Date.now()));
}

function notify(): void {
  const token = currentToken();
  const reason: Reason = token === observedToken ? 'preferences' : 'session';
  observedToken = token;
  scheduleExpiry();
  for (const listener of [...listeners]) listener(reason);
}

const onStorage = (event: StorageEvent) => {
  const { key } = scope();
  if (event.key !== null && event.key !== key && event.key !== 'token') return;
  if (event.key === key || event.key === null) dirty.delete(key);
  notify();
};
const onVisible = () => {
  if (!document.hidden) notify();
  else scheduleExpiry();
};

export function getRoutePopupPreference(routeId: string): RoutePopupPreference {
  const key = routeKey(routeId);
  return key ? { ...(read().get(key) ?? { mode: 'enabled' }) } : { mode: 'enabled' };
}

export function setRoutePopupPreference(routeId: string, preference: RoutePopupPreference): void {
  const route = routeKey(routeId);
  if (!route) return;
  const choices = read();
  const next = normalize(preference);
  if (next.mode === 'enabled') choices.delete(route);
  else choices.set(route, next);
  const { key, persistent } = scope();
  memory.set(key, choices);
  if (persistent) {
    try { localStorage.setItem(key, JSON.stringify([...choices])); dirty.delete(key); }
    catch { dirty.add(key); }
  }
  notify();
}

/** One expiry timer while there are subscribers; no background polling. */
export function subscribeRoutePopupPreferences(listener: (reason: Reason) => void): () => void {
  if (!listeners.size) {
    observedToken = currentToken();
    window.addEventListener('storage', onStorage);
    window.addEventListener('pageshow', onVisible);
    document.addEventListener('visibilitychange', onVisible);
  }
  listeners.add(listener);
  scheduleExpiry();
  return () => {
    listeners.delete(listener);
    if (!listeners.size) {
      clearTimeout(expiryTimer);
      expiryTimer = undefined;
      window.removeEventListener('storage', onStorage);
      window.removeEventListener('pageshow', onVisible);
      document.removeEventListener('visibilitychange', onVisible);
    }
  };
}

export function isRouteMuted(routeId: string): boolean {
  return getRoutePopupPreference(routeId).mode !== 'enabled';
}

export function setRouteMuted(routeId: string, muted: boolean): void {
  setRoutePopupPreference(routeId, { mode: muted ? 'muted' : 'enabled' });
}

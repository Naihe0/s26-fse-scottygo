// Routes whose foreground notification popups the rider muted. Stored per
// browser; muting never removes the server-side subscription.

import { normalizeRouteId } from './route-display';

const MUTED_ROUTES_KEY = 'scottygo_muted_routes';

function readMutedRoutes(): Set<string> {
  try {
    const stored = JSON.parse(localStorage.getItem(MUTED_ROUTES_KEY) ?? '[]');
    return new Set(
      Array.isArray(stored)
        ? stored.filter((value) => typeof value === 'string')
        : []
    );
  } catch {
    return new Set();
  }
}

function writeMutedRoutes(routes: Set<string>): void {
  try {
    localStorage.setItem(MUTED_ROUTES_KEY, JSON.stringify([...routes]));
  } catch {
    // Subscription room changes still work when browser storage is unavailable.
  }
}

export function isRouteMuted(routeId: string): boolean {
  return readMutedRoutes().has(normalizeRouteId(routeId));
}

export function setRouteMuted(routeId: string, muted: boolean): void {
  const routes = readMutedRoutes();
  if (muted) routes.add(normalizeRouteId(routeId));
  else routes.delete(normalizeRouteId(routeId));
  writeMutedRoutes(routes);
}

import type { IRoute } from '../../../common/transit.interface';

export interface IRouteDisplayMeta {
  id: string;
  name: string;
  system?: 'PRT' | 'CMU';
}

export interface IRouteDisplay {
  title: string;
  subtitle: string;
}

type RouteLookup = Map<string, IRouteDisplayMeta> | IRouteDisplayMeta[];

export function normalizeRouteId(routeId: string): string {
  return routeId.trim().toLowerCase();
}

function isCmuRouteId(routeId: string): boolean {
  return normalizeRouteId(routeId).startsWith('cmu-');
}

function getRouteMeta(
  routeId: string,
  routeLookup?: RouteLookup
): IRouteDisplayMeta | undefined {
  if (!routeLookup) return undefined;

  if (routeLookup instanceof Map) {
    return routeLookup.get(normalizeRouteId(routeId));
  }

  const target = normalizeRouteId(routeId);
  return routeLookup.find((route) => normalizeRouteId(route.id) === target);
}

export function buildRouteDisplayMap(
  routes: IRouteDisplayMeta[]
): Map<string, IRouteDisplayMeta> {
  const routeDisplayById = new Map<string, IRouteDisplayMeta>();
  for (const route of routes) {
    routeDisplayById.set(normalizeRouteId(route.id), route);
  }
  return routeDisplayById;
}

export function getRouteDisplay(
  routeId: string,
  routeLookup?: RouteLookup
): IRouteDisplay {
  const route = getRouteMeta(routeId, routeLookup);

  if (route?.system === 'CMU' || isCmuRouteId(routeId)) {
    return {
      title: route?.name ?? routeId,
      subtitle: 'CMU Shuttle Route'
    };
  }

  return {
    title: `Route ${routeId}`,
    subtitle: 'Pittsburgh Regional Transit Route'
  };
}

export function getRouteTitle(
  routeId: string,
  routeLookup?: RouteLookup
): string {
  return getRouteDisplay(routeId, routeLookup).title;
}

export function formatNotificationMessage(
  message: string,
  routeLookup?: RouteLookup
): string {
  // Agency and rider links must retain their exact destination when route names
  // are expanded in surrounding prose.
  return message.replace(
    /\bhttps?:\/\/[^\s<>"']+|\bCMU-\d+\b/gi,
    (rawRouteId: string) => {
      if (/^https?:\/\//i.test(rawRouteId)) return rawRouteId;
      const routeId = rawRouteId.toUpperCase();
      const title = getRouteTitle(routeId, routeLookup);
      return title === routeId ? rawRouteId : title;
    }
  );
}

export async function fetchRouteDisplayMap(
  headers: Record<string, string>
): Promise<Map<string, IRouteDisplayMeta>> {
  try {
    const res = await fetch('/transit/routes', { headers });
    if (!res.ok) return new Map<string, IRouteDisplayMeta>();

    const data = await res.json();
    const routes: IRouteDisplayMeta[] = (data.payload ?? []) as IRoute[];
    return buildRouteDisplayMap(routes);
  } catch {
    return new Map<string, IRouteDisplayMeta>();
  }
}

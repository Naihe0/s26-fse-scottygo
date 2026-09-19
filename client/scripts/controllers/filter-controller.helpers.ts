import type { IRoute } from '../../../common/transit.interface';
import type { ILatLng } from '../../../common/map.interface';
import type { IRouteOption } from '../components/route-selector';

const EARTH_RADIUS_M = 6_371_000;

export const formatRouteName = (route: IRoute): string => {
  if (route.system === 'CMU') {
    return route.name.replace(/\s+Transit\s+/g, ' ').trim();
  }
  return route.id;
};

export const buildRouteOptions = (routes: IRoute[]): IRouteOption[] =>
  routes.map((route) => ({
    id: route.id,
    name: formatRouteName(route)
  }));

export const haversineMeters = (a: ILatLng, b: ILatLng): number => {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const sinDLat = Math.sin(dLat / 2);
  const sinDLng = Math.sin(dLng / 2);
  const h =
    sinDLat * sinDLat +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * sinDLng * sinDLng;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(h));
};

export const estimateWalkMinutes = (
  userLocation: ILatLng | null,
  stopLat: number,
  stopLon: number,
  walkMinutesPerKm: number
): number | null => {
  if (!userLocation) return null;
  const distMeters = haversineMeters(userLocation, {
    lat: stopLat,
    lng: stopLon
  });
  return Math.ceil((distMeters / 1000) * walkMinutesPerKm);
};

const escapeHtml = (text: string): string =>
  text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');

export const buildServiceBannerMarkup = (
  issues: string[],
  title = 'Some services are currently unavailable'
): string => {
  const issueList = issues
    .map((issue) => `<li>${escapeHtml(issue)}</li>`)
    .join('');

  return `
    <div class="service-status-banner__content">
      <span class="material-icons-outlined service-status-banner__icon">cloud_off</span>
      <div class="service-status-banner__text">
        <strong>${escapeHtml(title)}</strong>
        <ul>${issueList}</ul>
      </div>
      <button class="service-status-banner__close" aria-label="Dismiss">&times;</button>
    </div>
  `;
};

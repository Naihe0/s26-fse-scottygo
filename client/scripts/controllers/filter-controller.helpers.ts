import type { IRoute } from '../../../common/transit.interface';
import type { ILatLng } from '../../../common/map.interface';
import { haversineMeters } from '../../../common/geo';
import type { IRouteOption } from '../components/route-selector';
import { escapeHtml } from '../utils/html';

/** Walking-time heuristic: minutes to walk one kilometer. */
const WALK_MINUTES_PER_KM = 15;

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

/** Straight-line walking estimate in minutes, or null without a location. */
export const estimateWalkMinutes = (
  userLocation: ILatLng | null,
  stopLat: number,
  stopLon: number
): number | null => {
  if (!userLocation) return null;
  const distanceMeters = haversineMeters(userLocation, {
    lat: stopLat,
    lng: stopLon
  });
  return Math.ceil((distanceMeters / 1000) * WALK_MINUTES_PER_KM);
};

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

// Geographic helpers shared by the server and the browser.

import type { ILatLng } from './map.interface';

/** Mean Earth radius in meters. */
export const EARTH_RADIUS_METERS = 6_371_000;

export const METERS_PER_MILE = 1609.344;

const toRadians = (degrees: number): number => (degrees * Math.PI) / 180;

/** Great-circle (haversine) distance between two points, in meters. */
export function haversineMeters(a: ILatLng, b: ILatLng): number {
  const dLat = toRadians(b.lat - a.lat);
  const dLng = toRadians(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRadians(a.lat)) *
      Math.cos(toRadians(b.lat)) *
      Math.sin(dLng / 2) ** 2;
  // Clamp floating-point overshoot so asin never receives a value above 1.
  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.sqrt(Math.min(1, h)));
}

// Validation for transit query parameters. Failures throw an OutOfBounds
// client error.

import { clientError } from '../errors';

/** Nearby stops are a walking-area query, not a network-wide stop export. */
export const MAX_NEARBY_RADIUS_METERS = 10_000;

function outOfBounds(message: string): never {
  throw clientError('OutOfBounds', message);
}

/** Treat a requested schedule date as a calendar day, not midnight UTC. */
export function parseTransitDate(value: unknown): Date {
  const message = 'Date must be a valid calendar date in YYYY-MM-DD format';
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return outOfBounds(message);
  }
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(year, month - 1, day);
  if (
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day
  ) {
    return outOfBounds(message);
  }
  return date;
}

export function validateTransitTime(value: unknown): void {
  if (typeof value !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) {
    outOfBounds('Time must be in HH:MM format between 00:00 and 23:59');
  }
}

export function validateNearbyRadius(
  radius: unknown
): asserts radius is number {
  if (
    typeof radius !== 'number' ||
    !Number.isFinite(radius) ||
    radius <= 0 ||
    radius > MAX_NEARBY_RADIUS_METERS
  ) {
    outOfBounds(
      `radiusMeters must be a positive number no greater than ${MAX_NEARBY_RADIUS_METERS}`
    );
  }
}

/** True for finite WGS84 coordinates. */
export function isValidCoordinate(lat: unknown, lon: unknown): boolean {
  return (
    typeof lat === 'number' &&
    typeof lon === 'number' &&
    Number.isFinite(lat) &&
    Number.isFinite(lon) &&
    Math.abs(lat) <= 90 &&
    Math.abs(lon) <= 180
  );
}

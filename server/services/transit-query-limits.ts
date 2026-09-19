import type { IAppError } from '../../common/server.responses';

/** Nearby stops are a walking-area query, not a network-wide stop export. */
export const MAX_NEARBY_RADIUS_METERS = 10_000;

export function validateNearbyRadius(
  radius: unknown
): asserts radius is number {
  if (
    typeof radius !== 'number' ||
    !Number.isFinite(radius) ||
    radius <= 0 ||
    radius > MAX_NEARBY_RADIUS_METERS
  ) {
    throw {
      type: 'ClientError',
      name: 'OutOfBounds',
      message: `radiusMeters must be a positive number no greater than ${MAX_NEARBY_RADIUS_METERS}`
    } as IAppError;
  }
}

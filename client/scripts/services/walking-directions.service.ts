import type { ILatLng } from '../../../common/map.interface';

export interface IDirectionsResult {
  polyline: ILatLng[];
  durationSeconds: number;
  distanceMeters: number;
  warnings?: string[];
}

// The installed Maps type definitions predate the Routes API's Route class.
// Keep the adapter limited to the fields documented for computeRoutes.
interface WalkingRoutesLibrary {
  Route: {
    computeRoutes(request: {
      origin: ILatLng;
      destination: ILatLng;
      travelMode: 'WALKING';
      fields: string[];
    }): Promise<{
      routes?: {
        path?: ILatLng[];
        durationMillis?: number;
        distanceMeters?: number;
        warnings?: string[];
      }[];
    }>;
  };
}

export const DIRECTIONS_TIMEOUT_MS = 15_000;

/** Request a walking route without allowing a stalled SDK call to trap the UI. */
export function requestWalkingDirections(
  origin: ILatLng,
  destination: ILatLng,
  signal: AbortSignal
): Promise<IDirectionsResult> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }

    let settled = false;
    const finish = (result?: IDirectionsResult, error?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal.removeEventListener('abort', onAbort);
      if (result) resolve(result);
      else reject(error);
    };
    const onAbort = () =>
      finish(undefined, new DOMException('Aborted', 'AbortError'));
    const timeout = setTimeout(
      () =>
        finish(
          undefined,
          new DOMException(
            'Walking directions timed out. Please try again.',
            'TimeoutError'
          )
        ),
      DIRECTIONS_TIMEOUT_MS
    );
    signal.addEventListener('abort', onAbort, { once: true });

    const compute = async (): Promise<IDirectionsResult> => {
      if (typeof google === 'undefined' || !google.maps?.importLibrary) {
        throw new Error(
          'Walking directions are unavailable. Please try again.'
        );
      }
      const { Route } = (await google.maps.importLibrary(
        'routes'
      )) as unknown as WalkingRoutesLibrary;
      if (settled) throw new DOMException('Aborted', 'AbortError');

      // New Google Cloud projects cannot use the legacy DirectionsService.
      const { routes } = await Route.computeRoutes({
        origin,
        destination,
        travelMode: 'WALKING',
        fields: ['path', 'durationMillis', 'distanceMeters', 'warnings']
      });
      const route = routes?.[0];
      if (
        !route?.path?.length ||
        !route.path.every(
          (point) => Number.isFinite(point.lat) && Number.isFinite(point.lng)
        ) ||
        typeof route.durationMillis !== 'number' ||
        !Number.isFinite(route.durationMillis) ||
        route.durationMillis < 0 ||
        typeof route.distanceMeters !== 'number' ||
        !Number.isFinite(route.distanceMeters) ||
        route.distanceMeters < 0
      ) {
        throw new Error('No walking route was found for this stop.');
      }
      return {
        polyline: route.path.map((point) => ({
          lat: point.lat,
          lng: point.lng
        })),
        durationSeconds: route.durationMillis / 1000,
        distanceMeters: route.distanceMeters,
        warnings: route.warnings ?? []
      };
    };

    // The SDK cannot cancel a network request; ignore its result after exit/timeout.
    void compute().then(
      (result) => finish(result),
      (error) => finish(undefined, error)
    );
  });
}

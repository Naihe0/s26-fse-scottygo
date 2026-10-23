// PRT TrueTime API client. Vehicles and arrivals come from GTFS-RT; TrueTime
// supplies only route colors, detours, and detour geometry.
// Docs: https://truetime.portauthority.org/bustime/apidoc/docs/DeveloperAPIGuide3_0.pdf

import { TRUETIME_KEY, TRUETIME_BASE_URL } from '../env';
import {
  IRoute,
  IDetour,
  IDetourGeometry
} from '../../common/transit.interface';
import { serverError } from '../errors';

const TIMEOUT_MS = 5000;
const RTPI_DATA_FEED = 'Port Authority Bus'; // required by multi-feed endpoints
const DEFAULT_ROUTE_COLOR = '#1e90ff';

interface TrueTimeError {
  msg: string;
}

interface TrueTimeRoute {
  rt: string;
  rtnm: string;
  rtclr?: string;
}

interface TrueTimeDetourDirection {
  rt?: string;
  dir?: string;
}

interface TrueTimeDetour {
  id: string;
  desc: string;
  rtdirs?: {
    rtdir?: TrueTimeDetourDirection | TrueTimeDetourDirection[];
  };
  startdt: string;
  enddt?: string;
}

interface TrueTimePoint {
  seq: number;
  lat: number;
  lon: number;
  typ: 'S' | 'W'; // S = stop, W = waypoint
}

interface TrueTimePattern {
  pid: string;
  rtdir: string;
  pt: TrueTimePoint[];
  dtrid?: string;
  dtrpt?: TrueTimePoint | TrueTimePoint[];
}

/** TrueTime returns single items unwrapped and lists as arrays. */
function asArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

const toLatLng = (point: TrueTimePoint) => ({ lat: point.lat, lng: point.lon });

/** The API guide defines this exact error as an empty result, not a failed feed. */
function validateDetourErrors(errors?: TrueTimeError[]): void {
  if (
    errors?.some(
      (error) =>
        error.msg?.trim().toLowerCase() !== 'no data found for parameter(s)'
    )
  ) {
    throw serverError('UpstreamError', 'TrueTime could not return detour data');
  }
}

/** Convert a local "YYYYMMDD HH:MM[:SS]" TrueTime timestamp to ISO 8601. */
function toISOString(timestamp: string): string {
  const part = (start: number, end: number) =>
    parseInt(timestamp.substring(start, end), 10);
  const seconds = timestamp.length > 15 ? part(15, 17) : 0;
  return new Date(
    part(0, 4),
    part(4, 6) - 1,
    part(6, 8),
    part(9, 11),
    part(12, 14),
    seconds
  ).toISOString();
}

class TrueTimeService {
  /** Call an endpoint and return its unwrapped `bustime-response` body. */
  private async call<T>(
    endpoint: string,
    params: Record<string, string> = {}
  ): Promise<T> {
    const url = new URL(`${TRUETIME_BASE_URL}/${endpoint}`);
    url.searchParams.set('key', TRUETIME_KEY);
    url.searchParams.set('format', 'json');
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value);
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(url.toString(), { signal: controller.signal });
      if (!res.ok) {
        throw serverError(
          'UpstreamError',
          `TrueTime API returned HTTP ${res.status}`
        );
      }
      const body = JSON.parse(await res.text()) as { 'bustime-response': T };
      return body['bustime-response'];
    } catch (error: unknown) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw serverError(
          'UpstreamError',
          'TrueTime API request timed out (>5 s)'
        );
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  /** PRT routes; used only for their official colors. */
  async getRoutes(): Promise<IRoute[]> {
    const data = await this.call<{
      routes?: TrueTimeRoute[];
      error?: TrueTimeError[];
    }>('getroutes');

    if (data.error?.length || !data.routes?.length) {
      throw serverError('UpstreamError', 'TrueTime did not return route colors');
    }

    return data.routes.map((route) => ({
      id: route.rt,
      name: route.rtnm,
      system: 'PRT' as const,
      color: route.rtclr ?? DEFAULT_ROUTE_COLOR,
      directions: ['INBOUND', 'OUTBOUND'],
      activeStatus: true,
      operatingDays: [0, 1, 2, 3, 4, 5, 6]
    }));
  }

  /**
   * Detour paths for a route. TrueTime getpatterns marks detoured patterns
   * with dtrid and may include dtrpt as the original path being replaced.
   */
  async getDetourGeometry(routeId: string): Promise<IDetourGeometry[]> {
    const data = await this.call<{
      ptr?: TrueTimePattern[];
      error?: TrueTimeError[];
    }>('getpatterns', { rt: routeId, rtpidatafeed: RTPI_DATA_FEED });

    validateDetourErrors(data.error);
    return (data.ptr ?? [])
      .filter((pattern) => typeof pattern.dtrid === 'string' && !!pattern.dtrid)
      .map((pattern) => ({
        detourId: pattern.dtrid as string,
        direction: pattern.rtdir,
        detourPath: pattern.pt.map(toLatLng),
        originalPath: asArray(pattern.dtrpt).map(toLatLng)
      }));
  }

  /** Active detours, optionally limited to some routes. */
  async getDetours(routeIds?: string[]): Promise<IDetour[]> {
    const params: Record<string, string> = { rtpidatafeed: RTPI_DATA_FEED };
    if (routeIds?.length) params.rt = routeIds.join(',');

    const data = await this.call<{
      dtrs?: TrueTimeDetour[];
      error?: TrueTimeError[];
    }>('getdetours', params);

    validateDetourErrors(data.error);
    return (data.dtrs ?? []).map((detour) => ({
      id: detour.id,
      description: detour.desc,
      routeIds: asArray(detour.rtdirs?.rtdir)
        .map((direction) => direction.rt)
        .filter((rt): rt is string => typeof rt === 'string' && rt.length > 0),
      startdt: toISOString(detour.startdt),
      enddt: detour.enddt ? toISOString(detour.enddt) : ''
    }));
  }
}

export default new TrueTimeService();

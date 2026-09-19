// Service for interfacing with the PRT TrueTime API
// Docs: https://truetime.portauthority.org/bustime/apidoc/docs/DeveloperAPIGuide3_0.pdf

import { TRUETIME_KEY, TRUETIME_BASE_URL } from '../env';
import {
  IRoute,
  IVehicle,
  IStop,
  IPrediction,
  IDetour,
  IPattern,
  IDetourGeometry
} from '../../common/transit.interface';
import { IAppError } from '../../common/server.responses';

const TIMEOUT_MS = 5000; // R3: wait no longer than 5 seconds for TrueTime
const RTPI_DATA_FEED = 'Port Authority Bus'; // required by TrueTime multi-feed endpoints

// Raw TrueTime API response shapes (unexported — internal to this service)

interface TrueTimeEnvelope<T> {
  'bustime-response': T;
}

interface TrueTimeError {
  msg: string;
}

interface TrueTimeRoute {
  rt: string;
  rtnm: string;
  rtclr?: string;
}

interface TrueTimeStop {
  stpid: string;
  stpnm: string;
  lat: number;
  lon: number;
  dtradd?: string[];
  dtrrem?: string[];
}

interface TrueTimeVehicle {
  vid: string;
  tmstmp: string;
  lat: string;
  lon: string;
  hdg: string;
  rt: string;
  dly?: boolean;
  spd?: number;
}

interface TrueTimePrediction {
  stpid: string;
  rt: string;
  vid?: string;
  prdtm: string;
  dly: boolean;
  prdctdn: string;
}

interface TrueTimeDetour {
  id: string;
  desc: string;
  rtdirs?: {
    rtdir?:
      | {
          rt?: string;
          dir?: string;
        }
      | Array<{
          rt?: string;
          dir?: string;
        }>;
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

// Date helpers

/** Convert TrueTime timestamp "YYYYMMDD HH:MM" → ISO 8601 string (YYYY-MM-DDThh:mm:ss.sssZ) */
function toISOString(tmstmp: string): string {
  return new Date(toUnixMs(tmstmp)).toISOString();
}

/** Convert TrueTime timestamp "YYYYMMDD HH:MM" or "YYYYMMDD HH:MM:SS" → Unix milliseconds */
function toUnixMs(tmstmp: string): number {
  const year = parseInt(tmstmp.substring(0, 4));
  const month = parseInt(tmstmp.substring(4, 6)) - 1; // 0-indexed
  const day = parseInt(tmstmp.substring(6, 8));
  const hour = parseInt(tmstmp.substring(9, 11));
  const minute = parseInt(tmstmp.substring(12, 14));
  const second = tmstmp.length > 15 ? parseInt(tmstmp.substring(15, 17)) : 0;
  return new Date(year, month, day, hour, minute, second).getTime();
}

// Service interface

export interface ITrueTimeService {
  getRoutes(): Promise<IRoute[]>;
  getPatterns(routeId: string): Promise<IPattern[]>;
  getDetourGeometry(routeId: string): Promise<IDetourGeometry[]>;
  getStops(routeId: string, direction: string): Promise<IStop[]>;
  getVehicles(routeId: string): Promise<IVehicle[]>;
  getPredictions(stopId: string): Promise<IPrediction[]>;
  getDetours(routeIds?: string[]): Promise<IDetour[]>;
}

// Implementation

class TrueTimeService implements ITrueTimeService {
  /**
   * Low-level fetch wrapper.
   * Builds the URL, enforces the 5-second timeout, and returns the
   * unwrapped `bustime-response` body. Throws an IAppError on failure.
   */
  private async call<T>(
    endpoint: string,
    params: Record<string, string> = {}
  ): Promise<T> {
    const url = new URL(`${TRUETIME_BASE_URL}/${endpoint}`);
    url.searchParams.set('key', TRUETIME_KEY);
    url.searchParams.set('format', 'json');
    for (const [k, v] of Object.entries(params)) {
      url.searchParams.set(k, v);
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

    try {
      const res = await fetch(url.toString(), { signal: controller.signal });

      if (!res.ok) {
        const err: IAppError = {
          type: 'ServerError',
          name: 'UpstreamError',
          message: `TrueTime API returned HTTP ${res.status}`
        };
        throw err;
      }

      const text = await res.text();
      const body = JSON.parse(text) as TrueTimeEnvelope<T>;
      return body['bustime-response'];
    } catch (error: unknown) {
      if (error instanceof Error && error.name === 'AbortError') {
        const err: IAppError = {
          type: 'ServerError',
          name: 'UpstreamError',
          message: 'TrueTime API request timed out (>5 s)'
        };
        throw err;
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Retrieve all active PRT routes. */
  async getRoutes(): Promise<IRoute[]> {
    const data = await this.call<{
      routes?: TrueTimeRoute[];
      error?: TrueTimeError[];
    }>('getroutes');

    if (data.error?.length || !data.routes || data.routes.length === 0) {
      const error: IAppError = {
        type: 'ServerError',
        name: 'UpstreamError',
        message: 'TrueTime did not return route colors'
      };
      throw error;
    }

    return data.routes.map((r) => ({
      id: r.rt,
      name: r.rtnm,
      system: 'PRT' as const,
      color: r.rtclr ?? '#1e90ff',
      directions: ['INBOUND', 'OUTBOUND'],
      activeStatus: true,
      operatingDays: [0, 1, 2, 3, 4, 5, 6]
    }));
  }

  /** Retrieve route geometry (ordered lat/lng points) for each direction of a route. */
  async getPatterns(routeId: string): Promise<IPattern[]> {
    const data = await this.call<{
      ptr?: TrueTimePattern[];
      error?: TrueTimeError[];
    }>('getpatterns', { rt: routeId, rtpidatafeed: RTPI_DATA_FEED });

    if (!data.ptr || data.ptr.length === 0) return [];

    return data.ptr.map((pattern) => ({
      direction: pattern.rtdir,
      path: pattern.pt.map((p) => ({ lat: p.lat, lng: p.lon }))
    }));
  }

  /**
   * Retrieve detour-specific geometry from detoured patterns.
   *
   * TrueTime getpatterns marks detoured patterns with dtrid and may include
   * dtrpt as the original path that is temporarily replaced.
   */
  async getDetourGeometry(routeId: string): Promise<IDetourGeometry[]> {
    const data = await this.call<{
      ptr?: TrueTimePattern[];
      error?: TrueTimeError[];
    }>('getpatterns', { rt: routeId, rtpidatafeed: RTPI_DATA_FEED });

    if (!data.ptr || data.ptr.length === 0) {
      return [];
    }

    const normalizePoints = (
      points?: TrueTimePoint | TrueTimePoint[]
    ): TrueTimePoint[] => {
      if (!points) return [];
      return Array.isArray(points) ? points : [points];
    };

    return data.ptr
      .filter((pattern) => typeof pattern.dtrid === 'string' && !!pattern.dtrid)
      .map((pattern) => {
        const dtrpt = normalizePoints(pattern.dtrpt);

        return {
          detourId: pattern.dtrid as string,
          direction: pattern.rtdir,
          detourPath: pattern.pt.map((p) => ({ lat: p.lat, lng: p.lon })),
          originalPath: dtrpt.map((p) => ({ lat: p.lat, lng: p.lon }))
        };
      });
  }

  /** Retrieve stops for a route in a specific direction (INBOUND or OUTBOUND). */
  async getStops(routeId: string, direction: string): Promise<IStop[]> {
    const data = await this.call<{
      stops?: TrueTimeStop[];
      error?: TrueTimeError[];
    }>('getstops', {
      rt: routeId,
      dir: direction,
      rtpidatafeed: RTPI_DATA_FEED
    });

    if (!data.stops || data.stops.length === 0) {
      const errMsg = data.error?.[0]?.msg ?? '';
      if (errMsg.toLowerCase().includes('no data')) {
        const err: IAppError = {
          type: 'ClientError',
          name: 'RouteNotFound',
          message: `Route ${routeId} not found for direction ${direction}`
        };
        throw err;
      }
      return [];
    }

    return data.stops.map((s) => ({
      stopId: s.stpid,
      stopName: s.stpnm,
      lat: s.lat,
      lon: s.lon,
      dtradd: s.dtradd ?? [],
      dtrrem: s.dtrrem ?? []
    }));
  }

  /** Retrieve real-time vehicle locations for a route. */
  async getVehicles(routeId: string): Promise<IVehicle[]> {
    const data = await this.call<{
      vehicle?: TrueTimeVehicle[];
      error?: TrueTimeError[];
    }>('getvehicles', { rt: routeId, rtpidatafeed: RTPI_DATA_FEED });

    // TrueTime returns an error object (not HTTP error) when no vehicles are active
    if (!data.vehicle || data.vehicle.length === 0) {
      return [];
    }

    return data.vehicle.map((v) => ({
      vid: v.vid,
      lat: parseFloat(v.lat),
      lon: parseFloat(v.lon),
      routeId: v.rt,
      heading: parseInt(v.hdg),
      source: 'live' as const,
      lastUpdate: toISOString(v.tmstmp),
      isDetoured: false
    }));
  }

  /** Retrieve arrival predictions for a stop. */
  async getPredictions(stopId: string): Promise<IPrediction[]> {
    const data = await this.call<{
      prd?: TrueTimePrediction[];
      error?: TrueTimeError[];
    }>('getpredictions', { stpid: stopId, rtpidatafeed: RTPI_DATA_FEED });

    if (!data.prd || data.prd.length === 0) {
      const errMsg = data.error?.[0]?.msg ?? '';
      if (errMsg.toLowerCase().includes('no data')) {
        const err: IAppError = {
          type: 'ClientError',
          name: 'StopNotFound',
          message: `Stop ${stopId} not found`
        };
        throw err;
      }
      return [];
    }

    return data.prd.map((p) => ({
      stopId: p.stpid,
      routeId: p.rt,
      vid: p.vid,
      predictedArrivalTime: toUnixMs(p.prdtm),
      isDelayed: p.dly,
      minutes: p.prdctdn === 'DUE' ? 0 : parseInt(p.prdctdn)
    }));
  }

  /**
   * Retrieve active detours.
   * @param routeIds - optional route filter; omit to get all active detours
   */
  async getDetours(routeIds?: string[]): Promise<IDetour[]> {
    const params: Record<string, string> = { rtpidatafeed: RTPI_DATA_FEED };
    if (routeIds && routeIds.length > 0) {
      params['rt'] = routeIds.join(',');
    }

    const data = await this.call<{
      dtrs?: TrueTimeDetour[];
      error?: TrueTimeError[];
    }>('getdetours', params);

    if (!data.dtrs || data.dtrs.length === 0) {
      return [];
    }

    return data.dtrs.map((d) => {
      const rawRtdir = d.rtdirs?.rtdir;
      const rtdirs = Array.isArray(rawRtdir)
        ? rawRtdir
        : rawRtdir
          ? [rawRtdir]
          : [];

      return {
        id: d.id,
        description: d.desc,
        routeIds: rtdirs
          .map((rd) => rd.rt)
          .filter(
            (rt): rt is string => typeof rt === 'string' && rt.length > 0
          ),
        startdt: toISOString(d.startdt),
        enddt: d.enddt ? toISOString(d.enddt) : ''
      };
    });
  }
}

export default new TrueTimeService();

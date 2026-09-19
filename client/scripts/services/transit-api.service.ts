/**
 * Client-side Transit API service.
 *
 * Single source of truth for all HTTP calls to the /transit backend.
 * Extracted from filter-controller.ts, vehicle-tracker.ts, and map.ts so that
 * any API contract change (URL, field name, query param) requires editing
 * exactly this one file, rather than all three consumers.
 *
 * Design choices:
 * - Token is read from localStorage on each call (matches existing pattern).
 * - Methods return typed payloads; callers no longer need to inspect response
 *   envelopes or status codes.
 * - On failure methods return null / empty array (consistent with prior
 *   behaviour) unless the caller needs to distinguish error types.
 */

import axios from 'axios';
import type {
  IRoute,
  IStop,
  IPattern,
  IBulkTransitData,
  IDetour,
  IPrediction,
  INearbyStopsPayload,
  IRouteSchedule
} from '../../../common/transit.interface';
import type { IVehicle } from '../../../common/transit.interface';

// Shape of the /transit/health response (inline type kept here so callers
// don't need to re-declare it).
export interface IServiceHealth {
  gtfs?: { ready: boolean };
  memory: unknown;
  vehiclePositions: {
    healthy: boolean;
    consecutiveFailures: number;
    error: string | null;
  };
  tripUpdates: {
    healthy: boolean;
    consecutiveFailures: number;
    error: string | null;
  };
  trueTimeColors: { available: boolean };
  tripshotLiveStatus: {
    healthy: boolean;
    consecutiveFailures: number;
    error: string | null;
  };
  overall: boolean;
}

export interface IVehicleResult {
  vehicles: IVehicle[];
  source?: string;
}

function authHeaders(): { Authorization: string } {
  const token = localStorage.getItem('token');
  return { Authorization: `Bearer ${token}` };
}

export class TransitApiService {
  private static instance: TransitApiService;

  private constructor() {}

  static getInstance(): TransitApiService {
    if (!TransitApiService.instance) {
      TransitApiService.instance = new TransitApiService();
    }
    return TransitApiService.instance;
  }

  /** GET /transit/routes — returns all routes. */
  async getRoutes(signal?: AbortSignal): Promise<IRoute[]> {
    try {
      const res = await axios.get('/transit/routes', {
        signal,
        timeout: 15000,
        headers: authHeaders(),
        validateStatus: () => true
      });
      if (res.status === 200 && res.data.name === 'RoutesRetrieved') {
        return res.data.payload ?? [];
      }
      console.error('[TransitApiService] getRoutes failed:', res.data);
      return [];
    } catch (err) {
      console.error('[TransitApiService] getRoutes error:', err);
      return [];
    }
  }

  /** GET /transit/bulk — all routes, patterns, and stops in one request. */
  async getBulkData(signal?: AbortSignal): Promise<IBulkTransitData | null> {
    try {
      const res = await axios.get('/transit/bulk', {
        signal,
        timeout: 30000,
        headers: authHeaders(),
        validateStatus: () => true
      });
      if (res.status === 200 && res.data.name === 'BulkDataRetrieved') {
        return res.data.payload as IBulkTransitData;
      }
      console.error('[TransitApiService] getBulkData failed:', res.data);
      return null;
    } catch (err) {
      console.error('[TransitApiService] getBulkData error:', err);
      return null;
    }
  }

  /** GET /transit/routes/:routeId — route geometry (patterns). */
  async getPatterns(routeId: string): Promise<IPattern[] | null> {
    try {
      const res = await axios.get(`/transit/routes/${routeId}`, {
        headers: authHeaders(),
        validateStatus: () => true
      });
      if (res.status === 200 && res.data.name === 'PathGenerated') {
        return res.data.payload as IPattern[];
      }
      if (res.status === 404) {
        return null; // Route has no geometry — expected case
      }
      console.error('[TransitApiService] getPatterns failed:', res.data);
      return null;
    } catch (err) {
      console.error('[TransitApiService] getPatterns error:', err);
      return null;
    }
  }

  /** POST /transit/routes/available — routes running on a specific date/time. */
  async filterRoutesByDateTime(
    date: string,
    time: string
  ): Promise<IRoute[] | null> {
    try {
      const res = await axios.post(
        '/transit/routes/available',
        { date, time },
        { headers: authHeaders(), validateStatus: () => true }
      );
      if (res.status === 200 && res.data.name === 'RoutesRetrieved') {
        return res.data.payload ?? [];
      }
      console.error(
        '[TransitApiService] filterRoutesByDateTime failed:',
        res.data
      );
      return null;
    } catch (err) {
      console.error('[TransitApiService] filterRoutesByDateTime error:', err);
      return null;
    }
  }

  /** GET /transit/routes/:routeId/schedule — schedule, alerts, and detours. */
  async getRouteSchedule(routeId: string): Promise<IRouteSchedule | null> {
    try {
      const res = await axios.get(
        `/transit/routes/${encodeURIComponent(routeId)}/schedule`,
        { headers: authHeaders(), validateStatus: () => true }
      );
      if (res.status === 200 && res.data.name === 'RouteScheduleRetrieved') {
        return res.data.payload as IRouteSchedule;
      }
      console.error('[TransitApiService] getRouteSchedule failed:', res.data);
      return null;
    } catch (err) {
      console.error('[TransitApiService] getRouteSchedule error:', err);
      return null;
    }
  }

  /** GET /transit/stops/:routeId?dir=DIRECTION — stops for a route. */
  async getStops(routeId: string, direction: string): Promise<IStop[] | null> {
    try {
      const res = await axios.get(
        `/transit/stops/${routeId}?dir=${direction}`,
        {
          headers: authHeaders(),
          validateStatus: () => true
        }
      );
      if (res.status === 200 && res.data.name === 'StopsRetrieved') {
        return res.data.payload ?? [];
      }
      console.error('[TransitApiService] getStops failed:', res.data);
      return null;
    } catch (err) {
      console.error('[TransitApiService] getStops error:', err);
      return null;
    }
  }

  /** GET /transit/stops/:stopId/predictions — arrival predictions. */
  async getPredictions(
    stopId: string,
    routeId?: string
  ): Promise<IPrediction[]> {
    try {
      const res = await axios.get(`/transit/stops/${stopId}/predictions`, {
        params: routeId ? { routeId } : undefined,
        headers: authHeaders(),
        validateStatus: () => true
      });
      if (res.status === 200 && res.data.name === 'PredictionsRetrieved') {
        return res.data.payload ?? [];
      }
      return [];
    } catch (err) {
      console.error('[TransitApiService] getPredictions error:', err);
      return [];
    }
  }

  /** GET /transit/stops/nearbystops — stops near a location. */
  async getNearbyStops(
    lat: number,
    lon: number,
    system?: string
  ): Promise<INearbyStopsPayload | null> {
    try {
      const params: Record<string, string | number> = { lat, lon };
      if (system) params.system = system;
      const res = await axios.get('/transit/stops/nearbystops', {
        params,
        headers: authHeaders(),
        validateStatus: () => true
      });
      if (res.status === 200 && res.data.name === 'NearbyStopsRetrieved') {
        return res.data.payload as INearbyStopsPayload;
      }
      console.warn('[TransitApiService] getNearbyStops failed:', res.data);
      return null;
    } catch (err) {
      console.error('[TransitApiService] getNearbyStops error:', err);
      return null;
    }
  }

  /** GET /transit/detours/:routeId/geometry — detour geometry for a route. */
  async getDetourGeometry(routeId: string): Promise<IDetour[]> {
    try {
      const res = await axios.get(`/transit/detours/${routeId}/geometry`, {
        headers: authHeaders(),
        validateStatus: () => true
      });
      if (res.status === 200 && res.data.name === 'DetoursRetrieved') {
        return res.data.payload as IDetour[];
      }
      console.error('[TransitApiService] getDetourGeometry failed:', res.data);
      return [];
    } catch (err) {
      console.error('[TransitApiService] getDetourGeometry error:', err);
      return [];
    }
  }

  /** GET /transit/vehicles/:routeId — live vehicle positions. */
  async getVehicles(
    routeId: string,
    timeParam?: string
  ): Promise<IVehicleResult | null> {
    try {
      const url = timeParam
        ? `/transit/vehicles/${routeId}?tm=${encodeURIComponent(timeParam)}`
        : `/transit/vehicles/${routeId}`;
      const res = await axios.get(url, {
        headers: authHeaders(),
        validateStatus: () => true
      });
      if (res.status === 200 && res.data.name === 'VehiclesLocated') {
        return { vehicles: res.data.payload ?? [], source: res.data.source };
      }
      console.error('[TransitApiService] getVehicles failed:', res.data);
      return null;
    } catch (err) {
      console.error('[TransitApiService] getVehicles error:', err);
      return null;
    }
  }

  /** GET /transit/health — service health status. */
  async getHealth(signal?: AbortSignal): Promise<IServiceHealth | null> {
    try {
      const res = await axios.get('/transit/health', {
        signal,
        timeout: 15000,
        headers: authHeaders(),
        validateStatus: () => true
      });
      if (res.status === 200) {
        return res.data as IServiceHealth;
      }
      return null;
    } catch (err) {
      console.error('[TransitApiService] getHealth error:', err);
      return null;
    }
  }
}

export const transitApiService = TransitApiService.getInstance();

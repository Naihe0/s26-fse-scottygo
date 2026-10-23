/**
 * Typed client for the /transit API. Callers receive payloads, not response
 * envelopes. Most queries return null (or an empty list where that is
 * unambiguous) when a request fails, so callers can tell "no service" from
 * "could not load".
 */

import axios, { type AxiosRequestConfig, type AxiosResponse } from 'axios';
import type {
  IRoute,
  IStop,
  IPattern,
  IBulkTransitData,
  IDetour,
  IPrediction,
  INearbyStopsPayload,
  IRouteSchedule,
  IVehicle
} from '../../../common/transit.interface';
import { authHeaders } from './session';

/** Shape of the GET /transit/health response. */
export interface IServiceHealth {
  gtfs?: { ready: boolean };
  memory: unknown;
  vehiclePositions: IFeedHealth;
  tripUpdates: IFeedHealth;
  trueTimeColors: { available: boolean };
  tripshotLiveStatus: IFeedHealth;
  overall: boolean;
}

interface IFeedHealth {
  healthy: boolean;
  consecutiveFailures: number;
  error: string | null;
}

export interface IVehicleResult {
  vehicles: IVehicle[];
}

const REQUEST_TIMEOUT_MS = 15_000;
const BULK_TIMEOUT_MS = 30_000;

const path = (value: string) => encodeURIComponent(value);

/** Payload of a 200 response named `expectedName`, else undefined. */
function payloadOf<T>(
  res: AxiosResponse,
  expectedName: string
): T | undefined {
  return res.status === 200 && res.data?.name === expectedName
    ? (res.data.payload as T)
    : undefined;
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

  /**
   * GET `url` and return its payload when the response has `expectedName`;
   * otherwise log the failure (unless `quietStatus` matches) and return null.
   */
  private async getPayload<T>(
    url: string,
    expectedName: string,
    config: AxiosRequestConfig = {},
    quietStatus?: number
  ): Promise<T | null> {
    try {
      const res = await axios.get(url, {
        ...config,
        headers: authHeaders(),
        validateStatus: () => true
      });
      const payload = payloadOf<T>(res, expectedName);
      if (payload !== undefined) return payload;
      if (res.status !== quietStatus) {
        console.error(`[TransitApiService] GET ${url} failed:`, res.data);
      }
      return null;
    } catch (err) {
      console.error(`[TransitApiService] GET ${url} error:`, err);
      return null;
    }
  }

  async getRoutes(signal?: AbortSignal): Promise<IRoute[]> {
    return (
      (await this.getPayload<IRoute[]>('/transit/routes', 'RoutesRetrieved', {
        signal,
        timeout: REQUEST_TIMEOUT_MS
      })) ?? []
    );
  }

  /** All routes, patterns, and stops in one request. */
  async getBulkData(signal?: AbortSignal): Promise<IBulkTransitData | null> {
    return this.getPayload('/transit/bulk', 'BulkDataRetrieved', {
      signal,
      timeout: BULK_TIMEOUT_MS
    });
  }

  /** Route geometry; null when the route has none (404) or loading failed. */
  async getPatterns(routeId: string): Promise<IPattern[] | null> {
    return this.getPayload(
      `/transit/routes/${path(routeId)}`,
      'PathGenerated',
      {},
      404
    );
  }

  /** Routes with scheduled service at a date ("YYYY-MM-DD") and time ("HH:MM"). */
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
      const routes = payloadOf<IRoute[]>(res, 'RoutesRetrieved');
      if (routes !== undefined) return routes;
      console.error('[TransitApiService] filterRoutesByDateTime failed:', res.data);
      return null;
    } catch (err) {
      console.error('[TransitApiService] filterRoutesByDateTime error:', err);
      return null;
    }
  }

  /** Schedule, alerts, and detours for the Route Info popup. */
  async getRouteSchedule(routeId: string): Promise<IRouteSchedule | null> {
    return this.getPayload(
      `/transit/routes/${path(routeId)}/schedule`,
      'RouteScheduleRetrieved'
    );
  }

  async getStops(routeId: string, direction: string): Promise<IStop[] | null> {
    return this.getPayload(
      `/transit/stops/${path(routeId)}?dir=${path(direction)}`,
      'StopsRetrieved'
    );
  }

  async getPredictions(
    stopId: string,
    routeId?: string
  ): Promise<IPrediction[]> {
    return (
      (await this.getPayload<IPrediction[]>(
        `/transit/stops/${path(stopId)}/predictions`,
        'PredictionsRetrieved',
        { params: routeId ? { routeId } : undefined }
      )) ?? []
    );
  }

  async getNearbyStops(
    lat: number,
    lon: number,
    system?: string
  ): Promise<INearbyStopsPayload | null> {
    return this.getPayload(
      '/transit/stops/nearbystops',
      'NearbyStopsRetrieved',
      { params: system ? { lat, lon, system } : { lat, lon } }
    );
  }

  /** Detours that have geometry for a route; empty on failure. */
  async getDetourGeometry(routeId: string): Promise<IDetour[]> {
    return (
      (await this.getPayload<IDetour[]>(
        `/transit/detours/${path(routeId)}/geometry`,
        'DetoursRetrieved'
      )) ?? []
    );
  }

  /** Measured vehicle positions; null when the request or payload failed. */
  async getVehicles(
    routeId: string,
    signal?: AbortSignal
  ): Promise<IVehicleResult | null> {
    const vehicles = await this.getPayload<IVehicle[]>(
      `/transit/vehicles/${path(routeId)}`,
      'VehiclesLocated',
      { signal, timeout: REQUEST_TIMEOUT_MS }
    );
    return Array.isArray(vehicles) ? { vehicles } : null;
  }

  async getHealth(signal?: AbortSignal): Promise<IServiceHealth | null> {
    try {
      const res = await axios.get('/transit/health', {
        signal,
        timeout: REQUEST_TIMEOUT_MS,
        headers: authHeaders(),
        validateStatus: () => true
      });
      return res.status === 200 ? (res.data as IServiceHealth) : null;
    } catch (err) {
      console.error('[TransitApiService] getHealth error:', err);
      return null;
    }
  }
}

export const transitApiService = TransitApiService.getInstance();

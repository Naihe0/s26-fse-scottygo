// Controller for PRT bus data endpoints
// Base path: /transit

import { Request, Response } from 'express';
import Controller from './controller';
import tripshotService from '../services/tripshot.service';
import vehiclePositionsService from '../services/vehicle-positions.service';
import tripUpdatesService from '../services/trip-updates.service';
import { TransitModel } from '../models/transit.model';
import gtfsService from '../services/gtfs.service';
import alertsService from '../services/alerts.service';
import {
  parseTransitDate,
  validateTransitTime
} from '../services/transit-date';
import * as responses from '../../common/server.responses';
import {
  IRoute,
  IVehicle,
  INearbyStopsFilters,
  IRouteSchedule
} from '../../common/transit.interface';

/**
 * Parse and clamp a numeric query-string value.
 * Returns `defaultLimit` when the input is undefined or not a finite number.
 * The result is always clamped to [1, maxLimit].
 */
export function parseLimit(
  rawLimit: string | undefined,
  defaultLimit: number,
  maxLimit: number
): number {
  const parsed = rawLimit ? Number.parseInt(rawLimit, 10) : defaultLimit;
  if (!Number.isFinite(parsed)) {
    return defaultLimit;
  }
  return Math.min(Math.max(parsed, 1), maxLimit);
}

export default class BusController extends Controller {
  private static instance: BusController | null = null;

  private constructor(path: string) {
    super(path);
  }

  public static getInstance(path: string): BusController {
    if (!BusController.instance) {
      BusController.instance = new BusController(path);
    }
    return BusController.instance;
  }

  public initializeRoutes(): void {
    this.registerTransitRoutes();
    this.registerStopRoutes();
  }

  private registerTransitRoutes(): void {
    this.router.get('/bulk', this.getBulkData.bind(this));
    this.router.get('/routes', this.getRoutes.bind(this));
    this.router.post(
      '/routes/available',
      this.filterRoutesByDateTime.bind(this)
    );
    this.router.get(
      '/routes/:routeId/schedule',
      this.getRouteSchedule.bind(this)
    );
    this.router.get('/routes/:id', this.getPatterns.bind(this));
    this.router.get('/vehicles/:routeId', this.getVehicles.bind(this));
    this.router.get(
      '/detours/:routeId/geometry',
      this.getDetourGeometry.bind(this)
    );
    this.router.get('/detours/:routeId', this.getDetours.bind(this));
  }

  // GET /transit/routes/:routeId/schedule
  private async getRouteSchedule(req: Request, res: Response): Promise<void> {
    try {
      const { routeId } = req.params;

      const payload = routeId.startsWith('CMU-')
        ? await this.buildCmuRouteSchedule(routeId)
        : await this.buildPrtRouteSchedule(routeId);

      if (!payload) {
        const err: responses.IAppError = {
          type: 'ClientError',
          name: 'RouteNotFound',
          message: `Route ${routeId} not found`
        };
        res.status(404).json(err);
        return;
      }

      const success: responses.ISuccess = {
        name: 'RouteScheduleRetrieved',
        payload
      };
      res.status(200).json(success);
    } catch (error) {
      console.error('Error fetching route schedule:', error);
      const err: responses.IAppError = {
        type: 'ServerError',
        name: 'GetRequestFailure',
        message: 'Failed to retrieve route schedule'
      };
      res.status(500).json(err);
    }
  }

  /** Assemble a Route Info payload for a PRT route from GTFS static data. */
  private async buildPrtRouteSchedule(
    routeId: string
  ): Promise<IRouteSchedule | null> {
    const schedule = gtfsService.getRouteSchedule(routeId);
    if (!schedule) return null;

    const route = gtfsService.getRoutes().find((r) => r.id === routeId);
    const allAlerts = alertsService.getAlerts();
    const routeAlerts = allAlerts.filter((a) => a.routeIds.includes(routeId));
    const detours = await TransitModel.getDetours([routeId]);

    return {
      routeId,
      routeName: route?.name ?? routeId,
      system: route?.system ?? 'PRT',
      operatingDays: schedule.operatingDays,
      directions: schedule.directions,
      alerts: routeAlerts,
      detours
    };
  }

  /**
   * Assemble a Route Info payload for a CMU shuttle route using TripShot
   * liveStatus ride data.  Alerts and detours are currently unavailable for
   * CMU routes and are returned as empty arrays so the popup renders cleanly.
   */
  private async buildCmuRouteSchedule(
    routeId: string
  ): Promise<IRouteSchedule | null> {
    if (!tripshotService.isConfigured()) return null;

    const schedule = tripshotService.getRouteSchedule(routeId);
    if (!schedule) return null;

    const routes = await tripshotService.getRoutes();
    const route = routes.find((r) => r.id === routeId);

    return {
      routeId,
      routeName: route?.name ?? routeId,
      system: 'CMU',
      operatingDays: schedule.operatingDays,
      directions: schedule.directions,
      alerts: [],
      detours: []
    };
  }

  private registerStopRoutes(): void {
    this.router.get('/stops/nearbystops', this.getNearbyStops.bind(this));
    this.router.get('/stops/:routeId', this.getStops.bind(this));
    this.router.get(
      '/stops/:stopId/predictions',
      this.getPredictions.bind(this)
    );
  }

  private sendRoutesRetrieved(res: Response, routes: IRoute[]): void {
    const successRes: responses.ISuccess = {
      name: 'RoutesRetrieved',
      message: `Found ${routes.length} routes`,
      payload: routes
    };
    res.status(200).json(successRes);
  }

  private parseNearbyStopsFilters(req: Request): INearbyStopsFilters {
    for (const name of [
      'routeId',
      'system',
      'direction',
      'date',
      'time',
      'includeRoutes'
    ]) {
      if (
        req.query[name] !== undefined &&
        typeof req.query[name] !== 'string'
      ) {
        throw {
          type: 'ClientError',
          name: 'OutOfBounds',
          message: `${name} must be a single string`
        } as responses.IAppError;
      }
    }
    const includeRoutesParam = req.query.includeRoutes as string | undefined;
    const filters: INearbyStopsFilters = {
      includeRoutes:
        includeRoutesParam === undefined || includeRoutesParam !== 'false'
    };
    if (req.query.routeId) filters.routeId = req.query.routeId as string;
    if (req.query.system) filters.system = req.query.system as string;
    if (req.query.direction)
      filters.direction = (req.query.direction as string).toUpperCase();
    if (req.query.date) filters.date = req.query.date as string;
    if (req.query.time) filters.time = req.query.time as string;
    if (filters.system && !['PRT', 'CMU'].includes(filters.system)) {
      throw {
        type: 'ClientError',
        name: 'OutOfBounds',
        message: 'system must be PRT or CMU'
      } as responses.IAppError;
    }
    if (
      filters.direction &&
      !['INBOUND', 'OUTBOUND'].includes(filters.direction)
    ) {
      throw {
        type: 'ClientError',
        name: 'OutOfBounds',
        message: 'direction must be INBOUND or OUTBOUND'
      } as responses.IAppError;
    }
    if (filters.date) parseTransitDate(filters.date);
    if (filters.time) validateTransitTime(filters.time);
    return filters;
  }

  // GET /transit/bulk — all routes, patterns, and stops in one response
  private async getBulkData(_req: Request, res: Response): Promise<void> {
    try {
      const bulk = await TransitModel.getAllTransitData();
      const successRes: responses.ISuccess = {
        name: 'BulkDataRetrieved',
        message: `All transit data: ${bulk.routes.length} routes`,
        payload: bulk
      };
      res.status(200).json(successRes);
    } catch (error: unknown) {
      this.handleError(error, res);
    }
  }

  // GET /transit/routes?system=PRT|CMU
  private async getRoutes(req: Request, res: Response): Promise<void> {
    const systemParam = req.query.system as string | undefined;

    try {
      const routes: IRoute[] = [];

      // Fetch PRT routes if no system filter or PRT is requested
      if (!systemParam || systemParam === 'PRT') {
        const prtRoutes = await TransitModel.getRoutes();
        routes.push(...prtRoutes);
      }

      // Fetch CMU routes if no system filter or CMU is requested
      if (!systemParam || systemParam === 'CMU') {
        if (tripshotService.isConfigured()) {
          const cmuRoutes = await tripshotService.getRoutes();
          routes.push(...cmuRoutes);
        } else {
          console.warn(
            `[Tripshot ${new Date().toISOString()}] Service not configured, skipping CMU routes`
          );
        }
      }

      this.sendRoutesRetrieved(res, routes);
    } catch (error: unknown) {
      this.handleError(error, res);
    }
  }

  // POST /transit/routes/available
  // Body: { date: string (YYYY-MM-DD), time?: string (HH:MM) }
  private async filterRoutesByDateTime(
    req: Request,
    res: Response
  ): Promise<void> {
    const { date, time } = (req.body ?? {}) as {
      date?: unknown;
      time?: unknown;
    };

    if (!date) {
      const errorRes: responses.IAppError = {
        type: 'ClientError',
        name: 'MissingParameter',
        message: 'Request body must include "date" (YYYY-MM-DD)'
      };
      res.status(400).json(errorRes);
      return;
    }

    try {
      const calendarDate = parseTransitDate(date);
      if (time !== undefined) validateTransitTime(time);
      const routes =
        typeof time === 'string'
          ? gtfsService.filterRoutesByDateTime(calendarDate, time)
          : gtfsService.filterRoutesByDate(calendarDate);

      this.sendRoutesRetrieved(res, routes);
    } catch (error: unknown) {
      this.handleError(error, res);
    }
  }

  // GET /transit/routes/:id
  private async getPatterns(req: Request, res: Response): Promise<void> {
    const { id } = req.params;
    try {
      let patterns = null;

      // Check if this is a CMU route
      if (id.startsWith('CMU-')) {
        if (tripshotService.isConfigured()) {
          patterns = await tripshotService.getPatterns(id).catch(() => null);
        } else {
          const err: responses.IAppError = {
            type: 'ServerError',
            name: 'ServiceUnavailable',
            message: 'CMU Shuttle tracking service not configured'
          };
          res.status(451).json(err);
          return;
        }
      } else {
        // PRT route — served from GTFS cache in MongoDB
        patterns = await TransitModel.getPatterns(id);
      }

      if (!patterns || patterns.length === 0) {
        const err: responses.IAppError = {
          type: 'ClientError',
          name: 'RouteNotFound',
          message: `No geometry found for route ${id}`
        };
        res.status(404).json(err);
        return;
      }

      const successRes: responses.ISuccess = {
        name: 'PathGenerated',
        message: `Found ${patterns.length} patterns for route ${id}`,
        payload: patterns
      };
      res.status(200).json(successRes);
    } catch (error: unknown) {
      this.handleError(error, res);
    }
  }

  // GET /transit/stops/nearbystops?lat=...&lon=...&radiusMeters=...
  private async getNearbyStops(req: Request, res: Response): Promise<void> {
    const latStr = req.query.lat as string | undefined;
    const lonStr = req.query.lon as string | undefined;

    if (!latStr || !lonStr) {
      const errorRes: responses.IAppError = {
        type: 'ClientError',
        name: 'MissingParameter',
        message: 'Query parameters "lat" and "lon" are required'
      };
      res.status(400).json(errorRes);
      return;
    }

    const lat =
      typeof latStr === 'string' && latStr.trim() ? Number(latStr) : NaN;
    const lon =
      typeof lonStr === 'string' && lonStr.trim() ? Number(lonStr) : NaN;

    if (
      !Number.isFinite(lat) ||
      !Number.isFinite(lon) ||
      lat < -90 ||
      lat > 90 ||
      lon < -180 ||
      lon > 180
    ) {
      const errorRes: responses.IAppError = {
        type: 'ClientError',
        name: 'OutOfBounds',
        message:
          'Coordinates out of valid range (lat: -90 to 90, lon: -180 to 180)'
      };
      res.status(400).json(errorRes);
      return;
    }

    // Default radius: 1000 m (~15 min walk); override via query param
    const rawRadius = req.query.radiusMeters;
    const radiusMeters =
      rawRadius === undefined
        ? undefined
        : typeof rawRadius === 'string' && rawRadius.trim()
          ? Number(rawRadius)
          : NaN;
    if (
      radiusMeters !== undefined &&
      (!Number.isFinite(radiusMeters) || radiusMeters <= 0)
    ) {
      res.status(400).json({
        type: 'ClientError',
        name: 'OutOfBounds',
        message: 'radiusMeters must be a positive number'
      });
      return;
    }

    try {
      const filters = this.parseNearbyStopsFilters(req);
      const payload = await TransitModel.getNearbyStops(
        lat,
        lon,
        radiusMeters,
        filters
      );

      const successRes: responses.ISuccess = {
        name: 'NearbyStopsRetrieved',
        message: `Found ${payload.stops.length} nearby stops within ${payload.radiusMeters}m`,
        payload
      };
      res.status(200).json(successRes);
    } catch (error: unknown) {
      this.handleError(error, res);
    }
  }

  // GET /transit/stops/:routeId?dir=INBOUND|OUTBOUND
  private async getStops(req: Request, res: Response): Promise<void> {
    const { routeId } = req.params;
    const rawDirection = req.query.dir;
    const direction =
      typeof rawDirection === 'string' ? rawDirection.toUpperCase() : undefined;

    if (!direction) {
      const errorRes: responses.IAppError = {
        type: 'ClientError',
        name: 'MissingParameter',
        message: 'Query parameter "dir" is required (INBOUND or OUTBOUND)'
      };
      res.status(400).json(errorRes);
      return;
    }
    if (!['INBOUND', 'OUTBOUND'].includes(direction)) {
      res.status(400).json({
        type: 'ClientError',
        name: 'OutOfBounds',
        message: 'dir must be INBOUND or OUTBOUND'
      });
      return;
    }

    try {
      let stops = null;

      // Check if this is a CMU route
      if (routeId.startsWith('CMU-')) {
        if (tripshotService.isConfigured()) {
          stops = await tripshotService
            .getStops(routeId, direction)
            .catch(() => null);
        }
      } else {
        // PRT route — served from GTFS cache in MongoDB
        stops = await TransitModel.getStops(routeId, direction);
      }

      if (!stops || stops.length === 0) {
        const err: responses.IAppError = {
          type: 'ClientError',
          name: 'StopNotFound',
          message: `No stops found for route ${routeId}`
        };
        res.status(404).json(err);
        return;
      }

      const successRes: responses.ISuccess = {
        name: 'StopsRetrieved',
        message: `Found ${stops.length} stops for route ${routeId} ${direction}`,
        payload: stops
      };
      res.status(200).json(successRes);
    } catch (error: unknown) {
      this.handleError(error, res);
    }
  }

  // GET /transit/vehicles/:routeId
  private async getVehicles(req: Request, res: Response): Promise<void> {
    const { routeId } = req.params;
    try {
      let vehicles: IVehicle[] = [];

      // Check if this is a CMU route
      if (routeId.startsWith('CMU-')) {
        if (tripshotService.isConfigured()) {
          vehicles = await tripshotService.getVehicles(routeId);
        }
      } else {
        // PRT route — read from the in-memory GTFS-RT store (updated every 30s)
        // Annotate each vehicle with its GTFS trip direction so the client can
        // filter by the inbound/outbound toggle without an extra round-trip.
        vehicles = vehiclePositionsService.getVehicles(routeId).map((v) => ({
          ...v,
          direction: v.tripId
            ? gtfsService.getTripDirection(v.tripId)
            : undefined
        }));
      }

      const successRes: responses.ISuccess = {
        name: 'VehiclesLocated',
        message: `Found ${vehicles.length} vehicles on route ${routeId}`,
        payload: vehicles
      };
      res.status(200).json(successRes);
    } catch (error: unknown) {
      this.handleError(error, res);
    }
  }

  // GET /transit/stops/:stopId/predictions
  private getPredictions(req: Request, res: Response): void {
    const { stopId } = req.params;
    const routeIdFilter = req.query.routeId as string | undefined;
    try {
      // TripShot stop IDs are UUIDs; PRT/GTFS stop IDs are numeric strings.
      // Route UUID-shaped stop IDs to the TripShot liveStatus predictions cache.
      const UUID_REGEX =
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      let predictions = UUID_REGEX.test(stopId)
        ? tripshotService.getPredictions(stopId, routeIdFilter)
        : tripUpdatesService.getPredictions(stopId);

      // Optional route filter for GTFS-RT stop predictions.
      if (routeIdFilter && !UUID_REGEX.test(stopId)) {
        predictions = predictions.filter((p) => p.routeId === routeIdFilter);
      }

      const successRes: responses.ISuccess = {
        name: 'PredictionsRetrieved',
        message: `Found ${predictions.length} predictions for stop ${stopId}`,
        payload: predictions
      };
      res.status(200).json(successRes);
    } catch (error: unknown) {
      this.handleError(error, res);
    }
  }

  // GET /transit/detours/:routeId
  private async getDetours(req: Request, res: Response): Promise<void> {
    const { routeId } = req.params;
    try {
      const detours = await TransitModel.getDetours([routeId]);
      const successRes: responses.ISuccess = {
        name: 'DetoursRetrieved',
        message: `Found ${detours.length} detours for route ${routeId}`,
        payload: detours
      };
      res.status(200).json(successRes);
    } catch (error: unknown) {
      this.handleError(error, res);
    }
  }

  // GET /transit/detours/:routeId/geometry
  private async getDetourGeometry(req: Request, res: Response): Promise<void> {
    const { routeId } = req.params;
    try {
      const detours = await TransitModel.getDetoursWithGeometry(routeId);
      const withGeometry = detours.filter((d) => (d.geometry?.length ?? 0) > 0);

      const successRes: responses.ISuccess = {
        name: 'DetoursRetrieved',
        message: `Found geometry for ${withGeometry.length} detours on route ${routeId}`,
        payload: withGeometry
      };
      res.status(200).json(successRes);
    } catch (error: unknown) {
      this.handleError(error, res);
    }
  }

  // -------------------------------------------------------------------------

  private handleError(error: unknown, res: Response): void {
    console.error(
      `[Transit Controller ${new Date().toISOString()}] Error:`,
      error
    );
    if (error instanceof Error) {
      console.error(
        `[Transit Controller ${new Date().toISOString()}] Unexpected Error:`,
        error.message,
        error.stack
      );
    }
    // 404 override for transit-specific not-found errors
    const appError = this.asAppError(error);
    if (appError) {
      const status =
        appError.name === 'RouteNotFound' || appError.name === 'StopNotFound'
          ? 404
          : appError.type === 'ClientError'
            ? 400
            : 500;
      res.status(status).json(appError);
      return;
    }
    const serverError: responses.IAppError = {
      type: 'ServerError',
      name: 'GetRequestFailure',
      message:
        error instanceof Error ? error.message : 'An unexpected error occurred'
    };
    res.status(500).json(serverError);
  }
}

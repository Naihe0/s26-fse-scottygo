// Transit data endpoints. Base path: /transit

import { Request, Response } from 'express';
import Controller from './controller';
import tripshotService from '../services/tripshot.service';
import vehiclePositionsService from '../services/vehicle-positions.service';
import tripshotLiveStatusService from '../services/tripshot-livestatus.service';
import tripUpdatesService from '../services/trip-updates.service';
import { TransitModel } from '../models/transit.model';
import gtfsService from '../services/gtfs.service';
import alertsService from '../services/alerts.service';
import {
  isValidCoordinate,
  parseTransitDate,
  validateNearbyRadius,
  validateTransitTime
} from '../services/transit-validation';
import { clientError } from '../errors';
import {
  IRoute,
  IVehicle,
  IPattern,
  IStop,
  INearbyStopsFilters,
  IRouteSchedule
} from '../../common/transit.interface';

const DIRECTIONS = ['INBOUND', 'OUTBOUND'];
const SYSTEMS = ['PRT', 'CMU'];
const NEARBY_FILTER_PARAMS = [
  'routeId',
  'system',
  'direction',
  'date',
  'time',
  'includeRoutes'
] as const;

/** TripShot stop IDs are UUIDs; PRT/GTFS stop IDs are numeric strings. */
const TRIPSHOT_STOP_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const isCmuRoute = (routeId: string) => routeId.startsWith('CMU-');

/** Numeric query value; blank or non-string input becomes NaN. */
function queryNumber(value: unknown): number {
  return typeof value === 'string' && value.trim() ? Number(value) : NaN;
}

function parseNearbyStopsFilters(req: Request): INearbyStopsFilters {
  for (const name of NEARBY_FILTER_PARAMS) {
    const value = req.query[name];
    if (value !== undefined && typeof value !== 'string') {
      throw clientError('OutOfBounds', `${name} must be a single string`);
    }
  }
  const query = req.query as Partial<
    Record<(typeof NEARBY_FILTER_PARAMS)[number], string>
  >;
  const filters: INearbyStopsFilters = {
    includeRoutes: query.includeRoutes !== 'false'
  };
  if (query.routeId) filters.routeId = query.routeId;
  if (query.system) {
    if (!SYSTEMS.includes(query.system)) {
      throw clientError('OutOfBounds', 'system must be PRT or CMU');
    }
    filters.system = query.system;
  }
  if (query.direction) {
    filters.direction = query.direction.toUpperCase();
    if (!DIRECTIONS.includes(filters.direction)) {
      throw clientError('OutOfBounds', 'direction must be INBOUND or OUTBOUND');
    }
  }
  if (query.date) {
    parseTransitDate(query.date);
    filters.date = query.date;
  }
  if (query.time) {
    validateTransitTime(query.time);
    filters.time = query.time;
  }
  return filters;
}

export default class TransitController extends Controller {
  private static instance: TransitController | null = null;

  private constructor(path: string) {
    super(path);
  }

  public static getInstance(path: string): TransitController {
    if (!TransitController.instance) {
      TransitController.instance = new TransitController(path);
    }
    return TransitController.instance;
  }

  public initializeRoutes(): void {
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
    this.router.get('/stops/nearbystops', this.getNearbyStops.bind(this));
    this.router.get('/stops/:routeId', this.getStops.bind(this));
    this.router.get(
      '/stops/:stopId/predictions',
      this.getPredictions.bind(this)
    );
  }

  /** Send a caught error; unexpected failures report as GetRequestFailure. */
  private handleError(res: Response, error: unknown): void {
    this.handleAppError(
      res,
      error,
      'Failed to retrieve transit data',
      'GetRequestFailure'
    );
  }

  // GET /transit/bulk — all routes, patterns, and stops in one response
  private async getBulkData(_req: Request, res: Response): Promise<void> {
    try {
      const bulk = await TransitModel.getAllTransitData();
      res
        .status(200)
        .json(
          this.success(
            'BulkDataRetrieved',
            bulk,
            `All transit data: ${bulk.routes.length} routes`
          )
        );
    } catch (error) {
      this.handleError(res, error);
    }
  }

  // GET /transit/routes?system=PRT|CMU
  private async getRoutes(req: Request, res: Response): Promise<void> {
    const system = req.query.system;
    try {
      const routes: IRoute[] = [];
      if (!system || system === 'PRT') {
        routes.push(...(await TransitModel.getRoutes()));
      }
      if (!system || system === 'CMU') {
        routes.push(...(await tripshotService.getRoutes()));
      }
      this.sendRoutes(res, routes);
    } catch (error) {
      this.handleError(res, error);
    }
  }

  // POST /transit/routes/available  { date: "YYYY-MM-DD", time?: "HH:MM" }
  private async filterRoutesByDateTime(
    req: Request,
    res: Response
  ): Promise<void> {
    const { date, time } = (req.body ?? {}) as {
      date?: unknown;
      time?: unknown;
    };
    if (!date) {
      this.sendClientError(
        res,
        400,
        'MissingParameter',
        'Request body must include "date" (YYYY-MM-DD)'
      );
      return;
    }

    try {
      const calendarDate = parseTransitDate(date);
      if (time !== undefined) validateTransitTime(time);
      const routes =
        typeof time === 'string'
          ? gtfsService.filterRoutesByDateTime(calendarDate, time)
          : gtfsService.filterRoutesByDate(calendarDate);
      this.sendRoutes(res, routes);
    } catch (error) {
      this.handleError(res, error);
    }
  }

  private sendRoutes(res: Response, routes: IRoute[]): void {
    res
      .status(200)
      .json(
        this.success('RoutesRetrieved', routes, `Found ${routes.length} routes`)
      );
  }

  // GET /transit/routes/:routeId/schedule
  private async getRouteSchedule(req: Request, res: Response): Promise<void> {
    const { routeId } = req.params;
    try {
      const payload = isCmuRoute(routeId)
        ? await this.buildCmuRouteSchedule(routeId)
        : await this.buildPrtRouteSchedule(routeId);
      if (!payload) {
        this.sendClientError(
          res,
          404,
          'RouteNotFound',
          `Route ${routeId} not found`
        );
        return;
      }
      res.status(200).json(this.success('RouteScheduleRetrieved', payload));
    } catch (error) {
      this.handleAppError(
        res,
        error,
        'Failed to retrieve route schedule',
        'GetRequestFailure'
      );
    }
  }

  /** Route Info payload for a PRT route from GTFS, alerts, and detours. */
  private async buildPrtRouteSchedule(
    routeId: string
  ): Promise<IRouteSchedule | null> {
    const schedule = gtfsService.getRouteSchedule(routeId);
    if (!schedule) return null;

    const route = gtfsService.getRoutes().find((r) => r.id === routeId);
    return {
      routeId,
      routeName: route?.name ?? routeId,
      system: route?.system ?? 'PRT',
      operatingDays: schedule.operatingDays,
      directions: schedule.directions,
      alerts: alertsService
        .getAlerts()
        .filter((alert) => alert.routeIds.includes(routeId)),
      detours: await TransitModel.getDetours([routeId])
    };
  }

  /** Route Info payload for a CMU route; CMU has no alert or detour feed. */
  private async buildCmuRouteSchedule(
    routeId: string
  ): Promise<IRouteSchedule | null> {
    const schedule = tripshotService.getRouteSchedule(routeId);
    if (!schedule) return null;

    const route = (await tripshotService.getRoutes()).find(
      (r) => r.id === routeId
    );
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

  // GET /transit/routes/:id
  private async getPatterns(req: Request, res: Response): Promise<void> {
    const { id } = req.params;
    try {
      const patterns: IPattern[] = isCmuRoute(id)
        ? await tripshotService.getPatterns(id).catch(() => [])
        : await TransitModel.getPatterns(id);
      if (patterns.length === 0) {
        this.sendClientError(
          res,
          404,
          'RouteNotFound',
          `No geometry found for route ${id}`
        );
        return;
      }
      res
        .status(200)
        .json(
          this.success(
            'PathGenerated',
            patterns,
            `Found ${patterns.length} patterns for route ${id}`
          )
        );
    } catch (error) {
      this.handleError(res, error);
    }
  }

  // GET /transit/stops/nearbystops?lat=...&lon=...&radiusMeters=...
  private async getNearbyStops(req: Request, res: Response): Promise<void> {
    if (!req.query.lat || !req.query.lon) {
      this.sendClientError(
        res,
        400,
        'MissingParameter',
        'Query parameters "lat" and "lon" are required'
      );
      return;
    }
    const lat = queryNumber(req.query.lat);
    const lon = queryNumber(req.query.lon);
    if (!isValidCoordinate(lat, lon)) {
      this.sendClientError(
        res,
        400,
        'OutOfBounds',
        'Coordinates out of valid range (lat: -90 to 90, lon: -180 to 180)'
      );
      return;
    }

    try {
      const radiusMeters =
        req.query.radiusMeters === undefined
          ? undefined
          : queryNumber(req.query.radiusMeters);
      if (radiusMeters !== undefined) validateNearbyRadius(radiusMeters);
      const payload = await TransitModel.getNearbyStops(
        lat,
        lon,
        radiusMeters,
        parseNearbyStopsFilters(req)
      );
      res
        .status(200)
        .json(
          this.success(
            'NearbyStopsRetrieved',
            payload,
            `Found ${payload.stops.length} nearby stops within ${payload.radiusMeters}m`
          )
        );
    } catch (error) {
      this.handleError(res, error);
    }
  }

  // GET /transit/stops/:routeId?dir=INBOUND|OUTBOUND
  private async getStops(req: Request, res: Response): Promise<void> {
    const { routeId } = req.params;
    const direction =
      typeof req.query.dir === 'string' ? req.query.dir.toUpperCase() : '';
    if (!direction) {
      this.sendClientError(
        res,
        400,
        'MissingParameter',
        'Query parameter "dir" is required (INBOUND or OUTBOUND)'
      );
      return;
    }
    if (!DIRECTIONS.includes(direction)) {
      this.sendClientError(
        res,
        400,
        'OutOfBounds',
        'dir must be INBOUND or OUTBOUND'
      );
      return;
    }

    try {
      const stops: IStop[] = isCmuRoute(routeId)
        ? await tripshotService.getStops(routeId, direction).catch(() => [])
        : await TransitModel.getStops(routeId, direction);
      if (stops.length === 0) {
        this.sendClientError(
          res,
          404,
          'StopNotFound',
          `No stops found for route ${routeId}`
        );
        return;
      }
      res
        .status(200)
        .json(
          this.success(
            'StopsRetrieved',
            stops,
            `Found ${stops.length} stops for route ${routeId} ${direction}`
          )
        );
    } catch (error) {
      this.handleError(res, error);
    }
  }

  // GET /transit/vehicles/:routeId
  private async getVehicles(req: Request, res: Response): Promise<void> {
    const { routeId } = req.params;
    try {
      // PRT vehicles carry their GTFS trip direction and shape so the client
      // can filter by direction and match motion without another request.
      const vehicles: IVehicle[] = isCmuRoute(routeId)
        ? await tripshotService.getVehicles(routeId)
        : vehiclePositionsService.getVehicles(routeId).map((vehicle) => ({
            ...vehicle,
            direction: vehicle.tripId
              ? gtfsService.getTripDirection(vehicle.tripId, vehicle.routeId)
              : undefined,
            shapeId: vehicle.tripId
              ? gtfsService.getTripShapeId(vehicle.tripId, vehicle.routeId)
              : undefined
          }));
      const feed = isCmuRoute(routeId)
        ? tripshotLiveStatusService
        : vehiclePositionsService;
      // This status describes the same in-memory source as the vehicles. The
      // browser can render immediately without waiting for a second health call.
      res.setHeader('Cache-Control', 'no-store');
      res.status(200).json({
        ...this.success(
          'VehiclesLocated',
          vehicles,
          `Found ${vehicles.length} vehicles on route ${routeId}`
        ),
        feed: {
          healthy: feed.isHealthy(),
          lastFetched: feed.getLastFetched()?.toISOString() ?? null,
          consecutiveFailures: feed.getConsecutiveFailures()
        }
      });
    } catch (error) {
      this.handleError(res, error);
    }
  }

  // GET /transit/stops/:stopId/predictions?routeId=...
  private getPredictions(req: Request, res: Response): void {
    const { stopId } = req.params;
    const routeIdFilter =
      typeof req.query.routeId === 'string' ? req.query.routeId : undefined;
    try {
      const predictions = TRIPSHOT_STOP_ID.test(stopId)
        ? tripshotService.getPredictions(stopId, routeIdFilter)
        : tripUpdatesService
            .getPredictions(stopId)
            .filter((p) => !routeIdFilter || p.routeId === routeIdFilter);
      res
        .status(200)
        .json(
          this.success(
            'PredictionsRetrieved',
            predictions,
            `Found ${predictions.length} predictions for stop ${stopId}`
          )
        );
    } catch (error) {
      this.handleError(res, error);
    }
  }

  // GET /transit/detours/:routeId
  private async getDetours(req: Request, res: Response): Promise<void> {
    const { routeId } = req.params;
    try {
      const detours = await TransitModel.getDetours([routeId]);
      res
        .status(200)
        .json(
          this.success(
            'DetoursRetrieved',
            detours,
            `Found ${detours.length} detours for route ${routeId}`
          )
        );
    } catch (error) {
      this.handleError(res, error);
    }
  }

  // GET /transit/detours/:routeId/geometry
  private async getDetourGeometry(req: Request, res: Response): Promise<void> {
    const { routeId } = req.params;
    try {
      const withGeometry = (
        await TransitModel.getDetoursWithGeometry(routeId)
      ).filter((detour) => (detour.geometry?.length ?? 0) > 0);
      res
        .status(200)
        .json(
          this.success(
            'DetoursRetrieved',
            withGeometry,
            `Found geometry for ${withGeometry.length} detours on route ${routeId}`
          )
        );
    } catch (error) {
      this.handleError(res, error);
    }
  }
}

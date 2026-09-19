// Interfaces for PRT transit data (routes, vehicles, stops, predictions, detours)

export interface IRoute {
  id: string; // e.g., "P1", "61C"
  name: string; // Short description
  system: 'PRT' | 'CMU';
  color: string; // Hex code for map rendering
  directions: string[]; // e.g., ["INBOUND", "OUTBOUND"]
  activeStatus: boolean; // Currently operational?
  operatingDays: number[]; // 0-6 (Sunday-Saturday)
}

export interface IVehicle {
  vid: string; // Vehicle ID
  lat: number; // Latitude
  lon: number; // Longitude
  routeId: string;
  heading?: number; // Compass degrees; absent when the live feed has no valid bearing.
  speed?: number; // Speed in m/s from GTFS-RT (may be absent)
  source: 'live' | 'static'; // "live" from PRT API, "static" from local cache
  lastUpdate: string; // ISO Timestamp
  isDetoured: boolean;
  delay?: number;
  tripId?: string; // GTFS trip_id (from GTFS-RT)
  direction?: string; // 'INBOUND' | 'OUTBOUND' — populated for PRT, absent for CMU loops
  currentStatus?: 'INCOMING_AT' | 'STOPPED_AT' | 'IN_TRANSIT_TO'; // Vehicle stop status
  currentStopSequence?: number; // Stop sequence number
  currentStopId?: string; // Stop ID the status refers to
}

export interface IStop {
  stopId: string;
  stopName: string; // Stop Name
  lat: number;
  lon: number;
  routes?: string[];
  dtradd: string[];
  dtrrem: string[];
}

export interface IPrediction {
  stopId: string;
  routeId: string;
  vid?: string;
  predictedArrivalTime: number;
  isDelayed: boolean;
  minutes: number;
}

export interface IDetour {
  id: string;
  description: string;
  startdt: string; // Start date and time (ISO string)
  enddt: string; // End date and time (ISO string)
  /** Route IDs impacted by this detour, e.g. ["61C", "71A"] */
  routeIds?: string[];
  /** Optional geometry details for rendering detour overlays on the map */
  geometry?: IDetourGeometry[];
}

export interface IDetourGeometry {
  detourId: string;
  direction: string;
  /** Active detour path currently in effect */
  detourPath: { lat: number; lng: number }[];
  /** Original path replaced by this detour (when provided by upstream) */
  originalPath?: { lat: number; lng: number }[];
}

export interface IPattern {
  direction: string; // e.g. "INBOUND" or "OUTBOUND"
  path: { lat: number; lng: number }[]; // Ordered sequence of points forming the route geometry
}

// ── Search Result Types ────────────────────────────────────────────────

/** Combined result for the Stop and Route Search context (GET /map/search). */
export interface ITransitSearchResult {
  routes: IRoute[];
  stops: IStop[];
}

// ── Bulk Transit Data ──────────────────────────────────────────────────
// Single-payload response containing all static transit data so the client
// can do every bit of filtering on the frontend without extra API calls.

export interface IBulkTransitData {
  routes: IRoute[];
  /** Patterns keyed by routeId, e.g. { "61C": [{ direction, path }] } */
  patterns: Record<string, IPattern[]>;
  /** Stops keyed by "routeId:DIRECTION", e.g. { "61C:INBOUND": [stop, …] } */
  stops: Record<string, IStop[]>;
}

// ── Discover Stops & Schedules (TUC4) ──────────────────────────────────

export interface INearbyStopsFilters {
  routeId?: string;
  system?: string;
  direction?: string;
  date?: string;
  time?: string;
  includeRoutes?: boolean;
}

export interface INearbyStop {
  stop: IStop;
  distanceMeters: number;
  walkMinutesEstimate: number;
  routesServingStop: string[];
}

export interface INearbyStopsPayload {
  center: { lat: number; lon: number };
  radiusMeters: number;
  expandedRadiusApplied: boolean;
  stops: INearbyStop[];
}

// ── Live Notification (TUC3) ───────────────────────────────────────────

export type ICrowdedness =
  | 'Empty'
  | 'Few Seats Taken'
  | 'Standing Room'
  | 'Packed';
export type IPrioritySeating = 'Available' | 'Occupied';
export type IBusCondition = 'Clean' | 'Dirty' | 'Average';

export interface ISubscription {
  _id?: string;
  userId: string;
  routeId: string;
  createdAt: string;
}

export interface IBusReport {
  _id?: string;
  userId: string;
  vid: string;
  routeId: string;
  crowdedness?: ICrowdedness;
  prioritySeating?: IPrioritySeating;
  condition?: IBusCondition;
  comment?: string;
  lat: number;
  lon: number;
  createdAt: string;
}

export interface INotification {
  _id?: string;
  routeId: string;
  vid: string;
  message: string;
  changedFields: string[];
  reportId: string;
  createdAt: string;
}

export interface IServiceAlert {
  id: string;
  headerText: string;
  descriptionText: string;
  routeIds: string[];
  activePeriods: { start: string; end: string }[];
  /** Agency-supplied metadata; absent/unknown values are not inferred. */
  url?: string;
  effect?: string;
  cause?: string;
  severityLevel?: 'INFO' | 'WARNING' | 'SEVERE';
}

export interface ILastKnownBusStatus {
  crowdedness?: ICrowdedness;
  prioritySeating?: IPrioritySeating;
  condition?: IBusCondition;
}

// ── Route Schedule (for Route Info popup) ──────────────────────────────

export interface IDirectionSchedule {
  direction: string; // "INBOUND" | "OUTBOUND"
  firstTrip: string; // "HH:MM" format
  lastTrip: string; // "HH:MM" format
  headsign?: string; // representative trip headsign (destination text)
}

export interface IRouteSchedule {
  routeId: string;
  routeName: string;
  system: 'PRT' | 'CMU';
  operatingDays: number[]; // 0-6 (Sunday-Saturday)
  directions: IDirectionSchedule[];
  alerts: IServiceAlert[];
  detours: IDetour[];
}

// ── Transit Cache ──────────────────────────────────────────────────────
// Cached TrueTime data stored in MongoDB to respect the daily API limit.

export type ITransitCacheType = 'routes' | 'stops' | 'patterns' | 'detours';

export interface ITransitCache {
  cacheKey: string; // e.g. "routes", "stops:61C:INBOUND", "patterns:61C", "detours:61C"
  dataType: ITransitCacheType;
  data: IRoute[] | IStop[] | IPattern[] | IDetour[];
  lastUpdated: Date;
  expiresAt: Date;
}

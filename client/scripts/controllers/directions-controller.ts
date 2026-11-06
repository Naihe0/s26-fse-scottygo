/**
 * Directions Controller (TUC4)
 *
 * Manages walking directions from the user's current location to a selected stop.
 * Handles Google Directions API calls, walking path rendering, rerouting logic,
 * arrival detection, and directions-mode state (R1–R5).
 */

import type {
  IMapProvider,
  IMapPolyline,
  ILatLng
} from '../../../common/map.interface';
import type { IStop, IPrediction } from '../../../common/transit.interface';
import { RouteRenderer } from '../renderers/route-renderer';
import { VehicleTracker } from '../trackers/vehicle-tracker';
import { closeMapPopup } from '../utils/map-popup';
import {
  requestWalkingDirections,
  type IWalkStep
} from '../services/walking-directions.service';
import { haversineMeters } from '../../../common/geo';
import { transitApiService } from '../services/transit-api.service';
import { getToken, isSameSession } from '../services/session';
import { keyArrivalRows } from '../utils/arrival-identity';
import { reconcileWalkingDepartures } from '../utils/walking-departures';
export type { IDirectionsResult } from '../services/walking-directions.service';

/** Minimum interval between automatic reroute requests (R3) */
const AUTO_REROUTE_THROTTLE_MS = 45_000;
/** Periodic reroute interval (TUC4 Step 9) */
const PERIODIC_REROUTE_MS = 120_000;
/** Path deviation threshold in meters (A5) */
const DEVIATION_THRESHOLD_M = 50;
/** Arrival threshold in meters (Step 10) */
const ARRIVAL_THRESHOLD_M = 20;
/** Tap debounce for Directions button (R1) */
const TAP_DEBOUNCE_MS = 500;

export interface IWalkingSummary {
  durationMin: number;
  eta: string;
  arrivalTime: number;
  distanceMeters: number;
  steps: IWalkStep[];
  predictions: IPrediction[];
  predictionsAvailable: boolean;
  warnings: string[];
  predictionKeys?: string[];
  missingPredictionKeys?: string[];
  checkedAt?: number | null;
  updatingPredictions?: boolean;
  boardingBufferMin?: 0 | 2 | 5;
  plannedOrigin?: boolean;
  origin?: ILatLng;
  destination?: ILatLng;
  walkCurrent?: boolean;
}

export interface IWalkingSelection {
  keys: string[];
  checkedAt: number | null;
  routeId?: string;
}

const pittsburghClock = new Intl.DateTimeFormat(undefined, {
  hour: 'numeric',
  minute: '2-digit',
  timeZone: 'America/New_York'
});

export class DirectionsController {
  private static instance: DirectionsController;
  private mapProvider: IMapProvider | null = null;
  private routeRenderer: RouteRenderer;
  private vehicleTracker: VehicleTracker;

  // Directions mode state
  private _isActive = false;
  private selectedStop: IStop | null = null;
  private _selectedPredictions: IPrediction[] = [];
  private predictionsAvailable = true;
  private predictionKeys: string[] = [];
  private missingPredictionKeys: string[] = [];
  private checkedAt: number | null = null;
  private predictionRouteId: string | undefined;
  private predictionRequest: AbortController | null = null;
  private walkingEvents: AbortController | null = null;
  private arrivalInterval: number | null = null;
  private walkToken: string | null = null;
  private lastSummary: IWalkingSummary | null = null;
  private boardingBufferMin: 0 | 2 | 5 = 0;
  private sessionOrigin: ILatLng | null = null;
  private usesPlannedOrigin = false;
  private walkingSuspended = false;
  private walkCheckedAt: number | null = null;
  private walkCurrent = false;
  private walkingPolyline: IMapPolyline | null = null;
  private walkingPath: ILatLng[] = [];
  private userLocation: ILatLng | null = null;
  private plannedLocation: ILatLng | null = null;

  // Timing / throttle state
  private lastRerouteTime = 0;
  private periodicRerouteInterval: number | null = null;
  private deferredRerouteTimeout: number | null = null;
  private lastDirectionsTap = 0;
  private sessionId = 0;

  // In-flight request abort controller (R2)
  private inflightAbort: AbortController | null = null;

  // Callback to show toast
  private toastCallback: ((message: string) => void) | null = null;
  private loadingCallback: ((loading: boolean) => void) | null = null;
  // Callback to update the directions info panel
  private infoPanelCallback: ((info: IWalkingSummary | null) => void) | null =
    null;
  // Callback executed when exiting directions mode
  private exitCallback: ((viewArrivals?: IStop) => void) | null = null;

  private constructor() {
    this.routeRenderer = RouteRenderer.getInstance();
    this.vehicleTracker = VehicleTracker.getInstance();
  }

  static getInstance(): DirectionsController {
    if (!DirectionsController.instance) {
      DirectionsController.instance = new DirectionsController();
    }
    return DirectionsController.instance;
  }

  initialize(mapProvider: IMapProvider): void {
    this.mapProvider = mapProvider;
  }

  /** Register a callback for toast notifications */
  setToastCallback(cb: (message: string) => void): void {
    this.toastCallback = cb;
  }

  /** Show a cancellable panel while the initial walking route is loading. */
  setLoadingCallback(cb: (loading: boolean) => void): void {
    this.loadingCallback = cb;
  }

  /** Register a callback for directions info updates (duration + ETA + selected bus predictions) */
  setInfoPanelCallback(cb: (info: IWalkingSummary | null) => void): void {
    this.infoPanelCallback = cb;
  }

  /** Register a callback for when directions mode exits */
  setExitCallback(cb: (viewArrivals?: IStop) => void): void {
    this.exitCallback = cb;
  }

  /** Whether directions mode is currently active */
  get isActive(): boolean {
    return this._isActive;
  }

  /** Invalidates asynchronous map restoration across every start/exit cycle. */
  get sessionVersion(): number {
    return this.sessionId;
  }

  /** The stop currently being navigated to, if any */
  get targetStop(): IStop | null {
    return this.selectedStop;
  }

  /** The bus predictions the user selected before starting directions */
  get selectedPredictions(): IPrediction[] {
    return this._selectedPredictions;
  }

  /**
   * Update the user's current position (called from map.ts watchPosition).
   * While in directions mode this triggers deviation & arrival checks.
   */
  updateUserLocation(position: ILatLng | null): void {
    this.userLocation = position;

    if (!position || !this._isActive || !this.selectedStop || this.usesPlannedOrigin ||
        document.hidden || this.walkingSuspended) return;

    // Deviation/arrival checks use real GPS, not planned location
    const distToStop = haversineMeters(position, {
      lat: this.selectedStop.lat,
      lng: this.selectedStop.lon
    });

    if (distToStop <= ARRIVAL_THRESHOLD_M) {
      this.handleArrival();
      return;
    }

    if (this.walkingPath.length > 0) {
      const distToPath = this.distanceToPolyline(position, this.walkingPath);
      if (distToPath > DEVIATION_THRESHOLD_M) {
        this.handleDeviation();
      }
    }
  }

  /**
   * Set the planned location to use as the origin for directions.
   * When set, directions originate from this location instead of GPS.
   */
  updatePlannedLocation(position: ILatLng | null): void {
    this.plannedLocation = position;
  }

  /**
   * Get the effective origin for directions: planned location if set, else GPS.
   */
  private getDirectionsOrigin(): ILatLng | null {
    return this.plannedLocation ?? this.userLocation;
  }

  /**
   * Start directions mode to a selected stop (TUC4 Step 5).
   * Enforces tap debounce (R1).
   */
  async startDirections(
    stop: IStop,
    selectedPredictions: IPrediction[] = [],
    predictionsAvailable = true,
    selection?: IWalkingSelection
  ): Promise<boolean> {
    // R1: Tap debounce
    const now = Date.now();
    if (now - this.lastDirectionsTap < TAP_DEBOUNCE_MS) return false;
    this.lastDirectionsTap = now;

    if (!this.mapProvider || !this.getDirectionsOrigin()) {
      console.warn(
        '[DirectionsController] No map provider or location for directions'
      );
      this.toastCallback?.(
        'Choose a starting location before requesting directions.'
      );
      return false;
    }

    // Enter directions mode
    const session = ++this.sessionId;
    this.stopWalkingUpdates();
    this.stopPeriodicReroute();
    this.cancelInflightRequest();
    this.removeWalkingPolyline();
    this._isActive = true;
    this.selectedStop = stop;
    this._selectedPredictions = selectedPredictions;
    this.predictionsAvailable = predictionsAvailable;
    this.predictionKeys = selection?.keys ?? [...keyArrivalRows(selectedPredictions).values()];
    this.missingPredictionKeys = [];
    this.checkedAt = selection ? selection.checkedAt : predictionsAvailable ? Date.now() : null;
    this.predictionRouteId = selection?.routeId;
    this.walkToken = getToken();
    this.lastSummary = null;
    this.boardingBufferMin = 0;
    this.sessionOrigin = this.getDirectionsOrigin();
    this.usesPlannedOrigin = this.plannedLocation !== null;
    this.walkingSuspended = false;
    this.walkCheckedAt = null;
    this.walkCurrent = false;

    // R5: Hide non-selected stops and route overlays
    this.routeRenderer.clearAllRoutes();
    this.vehicleTracker.stopPolling();
    closeMapPopup();
    this.loadingCallback?.(true);

    // Fetch and render initial route
    const rendered = await this.fetchAndRenderRoute();
    if (session !== this.sessionId || !this._isActive) return false;
    if (!rendered) {
      this.exitDirections();
      return false;
    }

    // Start periodic reroute (Step 9: every 120s)
    this.startPeriodicReroute();
    this.startWalkingUpdates();
    return true;
  }

  /**
   * Exit directions mode (A4).
   * Clears walking path, restores stops/routes.
   */
  exitDirections(viewArrivals?: IStop): void {
    const wasActive = this._isActive;
    this.sessionId++;
    this._isActive = false;
    this.selectedStop = null;
    this._selectedPredictions = [];
    this.stopWalkingUpdates();
    this.lastSummary = null;

    // Cancel in-flight request (R2)
    this.cancelInflightRequest();

    // Stop periodic reroute
    this.stopPeriodicReroute();

    // Remove walking path polyline
    this.removeWalkingPolyline();
    if (wasActive) {
      this.vehicleTracker.stopPolling();
      this.routeRenderer.clearAllRoutes();
    }

    // Clear info panel
    this.loadingCallback?.(false);
    this.infoPanelCallback?.(null);

    // Notify map.ts to restore routes/stops
    if (wasActive) this.exitCallback?.(viewArrivals);
  }

  /** Explicit handoff; it never claims GPS confirmed arrival. */
  viewArrivals(): void {
    if (this._isActive && this.selectedStop) this.exitDirections(this.selectedStop);
  }

  setBoardingBuffer(value: 0 | 2 | 5): void {
    if (![0, 2, 5].includes(value) || !this._isActive) return;
    this.boardingBufferMin = value;
    this.publishSummary();
  }

  checkArrivalFreshness(): void {
    if (this.walkCurrent && this.walkCheckedAt !== null && Date.now() - this.walkCheckedAt > 180_000) {
      this.walkCurrent = false;
      this.publishSummary();
    }
    if (this.predictionsAvailable && this.checkedAt !== null && Date.now() - this.checkedAt > 90_000) {
      this.predictionsAvailable = false;
      this.publishSummary();
    }
  }

  /** Keep the chosen visits; a disappeared visit is never replaced silently. */
  async refreshArrivals(): Promise<void> {
    if (!this._isActive || !this.selectedStop || !this._selectedPredictions.length ||
        this.predictionRequest || document.hidden || this.walkingSuspended) return;
    if (!isSameSession(this.walkToken)) { this.exitDirections(); return; }
    if (navigator.onLine === false) { this.pauseArrivals(); return; }
    const request = new AbortController();
    this.predictionRequest = request;
    const session = this.sessionId;
    this.publishSummary();
    try {
      const fresh = await transitApiService.getArrivalSnapshot(this.selectedStop.stopId, this.predictionRouteId, request.signal);
      if (!isSameSession(this.walkToken)) { this.exitDirections(); return; }
      if (request.signal.aborted || this.predictionRequest !== request || session !== this.sessionId ||
          !this._isActive || document.hidden || !isSameSession(this.walkToken)) return;
      this.predictionsAvailable = fresh?.state === 'ready' && Boolean(navigator.onLine);
      if (this.predictionsAvailable && fresh) {
        const matched = reconcileWalkingDepartures(this._selectedPredictions, this.predictionKeys, fresh.rows);
        this._selectedPredictions = matched.rows;
        this.missingPredictionKeys = matched.missingKeys;
        this.checkedAt = Date.now();
      }
    } catch {
      if (this.predictionRequest === request && session === this.sessionId) this.predictionsAvailable = false;
    } finally {
      if (this.predictionRequest === request) {
        this.predictionRequest = null;
        this.publishSummary();
      }
    }
  }

  private publishSummary(): void {
    if (!this._isActive || !this.lastSummary) return;
    this.infoPanelCallback?.({ ...this.lastSummary,
      predictions: this._selectedPredictions, predictionKeys: this.predictionKeys,
      predictionsAvailable: this.predictionsAvailable && this.checkedAt !== null && Date.now() - this.checkedAt <= 90_000,
      missingPredictionKeys: this.missingPredictionKeys, checkedAt: this.checkedAt,
      updatingPredictions: this.predictionRequest !== null, boardingBufferMin: this.boardingBufferMin,
      plannedOrigin: this.usesPlannedOrigin,
      walkCurrent:this.walkCurrent && this.walkCheckedAt !== null && Date.now() - this.walkCheckedAt <= 180_000 &&
        !document.hidden && !this.walkingSuspended,
      origin: this.sessionOrigin ?? undefined,
      destination: this.selectedStop ? {lat:this.selectedStop.lat, lng:this.selectedStop.lon} : undefined
    });
  }

  private pauseArrivals(): void {
    this.predictionRequest?.abort();
    this.predictionRequest = null;
    this.predictionsAvailable = false;
    this.publishSummary();
  }

  private startWalkingUpdates(): void {
    const events = new AbortController();
    this.walkingEvents = events;
    const options = {signal:events.signal};
    const resume = () => {
      if (!this._isActive || document.hidden) return;
      this.walkingSuspended = false;
      this.pauseArrivals();
      this.startPeriodicReroute();
      void this.refreshArrivals();
      this.handleDeviation();
    };
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) { this.walkingSuspended = true; this.pauseArrivals(); this.stopPeriodicReroute(); this.cancelInflightRequest(); }
      else resume();
    }, options);
    window.addEventListener('offline', () => this.pauseArrivals(), options);
    window.addEventListener('online', resume, options);
    window.addEventListener('pagehide', () => { this.walkingSuspended = true; this.pauseArrivals(); this.stopPeriodicReroute(); this.cancelInflightRequest(); }, options);
    window.addEventListener('pageshow', event => { if (event.persisted) resume(); }, options);
    window.addEventListener('storage', () => { if (!isSameSession(this.walkToken)) this.exitDirections(); }, options);
    if (this._selectedPredictions.length) {
      this.arrivalInterval = window.setInterval(() => { void this.refreshArrivals(); }, 30_000);
      void this.refreshArrivals();
    }
  }

  private stopWalkingUpdates(): void {
    this.walkingEvents?.abort();
    this.walkingEvents = null;
    this.predictionRequest?.abort();
    this.predictionRequest = null;
    if (this.arrivalInterval !== null) window.clearInterval(this.arrivalInterval);
    this.arrivalInterval = null;
  }

  // ── Private helpers ──────────────────────────────────────────────────

  /**
   * Fetch directions from Google Directions API and render on map.
   */
  private async fetchAndRenderRoute(): Promise<boolean> {
    const origin = this.usesPlannedOrigin ? this.sessionOrigin : this.userLocation;
    if (!this.mapProvider || !origin || !this.selectedStop || !this._isActive)
      return false;

    // R2: Cancel any in-flight request
    this.cancelInflightRequest();
    this.clearDeferredReroute();
    const request = new AbortController();
    this.inflightAbort = request;
    const session = this.sessionId;
    // Throttle failed attempts too, so GPS updates cannot flood the provider.
    this.lastRerouteTime = Date.now();
    const isCurrent = () =>
      this._isActive &&
      this.sessionId === session &&
      this.inflightAbort === request &&
      !request.signal.aborted && !document.hidden && !this.walkingSuspended && isSameSession(this.walkToken);

    const destination: ILatLng = {
      lat: this.selectedStop.lat,
      lng: this.selectedStop.lon
    };

    try {
      const result = await requestWalkingDirections(
        origin,
        destination,
        request.signal
      );

      if (!isCurrent()) return false;

      // Keep the previous route if rendering the replacement fails.
      const polyline = this.mapProvider.addPolyline({
        path: result.polyline,
        color: '#4285F4',
        weight: 7,
        opacity: 0.9,
        zIndex: 10
      });
      this.removeWalkingPolyline();
      this.walkingPolyline = polyline;
      this.walkingPath = result.polyline;

      // Update info panel with duration + ETA
      const durationMin = Math.ceil(result.durationSeconds / 60);
      const arrivalTime = Date.now() + result.durationSeconds * 1000;
      this.walkCheckedAt = Date.now();
      this.walkCurrent = true;
      this.loadingCallback?.(false);
      if (!isCurrent()) return false;
      this.lastSummary = {
        durationMin,
        eta: pittsburghClock.format(arrivalTime),
        arrivalTime,
        distanceMeters: result.distanceMeters,
        steps: result.steps ?? [],
        predictions: this._selectedPredictions,
        predictionsAvailable: this.predictionsAvailable,
        warnings: result.warnings ?? []
      };
      this.publishSummary();
      return true;
    } catch (err) {
      if (!isCurrent()) return false;
      console.error('[DirectionsController] Failed to fetch directions:', err);
      this.walkCurrent = false;
      this.publishSummary();
      this.toastCallback?.(
        this.walkingPolyline
          ? 'Could not update walking directions. Keeping your current route.'
          : err instanceof Error && err.name === 'TimeoutError'
            ? 'Walking directions took too long. Please try again.'
            : 'Walking directions are unavailable. Please try again.'
      );
      return false;
    } finally {
      if (this.inflightAbort === request) this.inflightAbort = null;
    }
  }

  /** Handle path deviation (A5) with throttle (R3) */
  private handleDeviation(): void {
    if (!this._isActive || this.inflightAbort || document.hidden || this.walkingSuspended || navigator.onLine === false) return;
    const elapsed = Date.now() - this.lastRerouteTime;

    if (elapsed >= AUTO_REROUTE_THROTTLE_MS) {
      void this.fetchAndRenderRoute();
    } else if (this.deferredRerouteTimeout === null) {
      // Coalesce repeated GPS updates into one delayed reroute.
      this.deferredRerouteTimeout = window.setTimeout(() => {
        this.deferredRerouteTimeout = null;
        this.handleDeviation();
      }, AUTO_REROUTE_THROTTLE_MS - elapsed);
    }
  }

  /** Handle arrival at stop (Step 10) */
  private handleArrival(): void {
    this.toastCallback?.('Arrived!');
    this.exitDirections();
  }

  /** Start periodic reroute interval (Step 9) */
  private startPeriodicReroute(): void {
    this.stopPeriodicReroute();
    this.periodicRerouteInterval = window.setInterval(() => {
      this.handleDeviation();
    }, PERIODIC_REROUTE_MS);
  }

  /** Stop periodic reroute interval */
  private stopPeriodicReroute(): void {
    if (this.periodicRerouteInterval !== null) {
      clearInterval(this.periodicRerouteInterval);
      this.periodicRerouteInterval = null;
    }
    this.clearDeferredReroute();
  }

  private clearDeferredReroute(): void {
    if (this.deferredRerouteTimeout !== null) {
      window.clearTimeout(this.deferredRerouteTimeout);
      this.deferredRerouteTimeout = null;
    }
  }

  /** Cancel any in-flight directions request (R2) */
  private cancelInflightRequest(): void {
    if (this.inflightAbort) {
      this.inflightAbort.abort();
      this.inflightAbort = null;
    }
  }

  /** Remove walking polyline from map */
  private removeWalkingPolyline(): void {
    if (this.walkingPolyline) {
      this.walkingPolyline.remove();
      this.walkingPolyline = null;
    }
    this.walkingPath = [];
  }

  // ── Geo utilities ────────────────────────────────────────────────────

  /** Minimum distance from a point to a polyline (in meters) */
  private distanceToPolyline(point: ILatLng, path: ILatLng[]): number {
    let minDist = Infinity;
    for (let i = 0; i < path.length - 1; i++) {
      const dist = this.distanceToSegment(point, path[i], path[i + 1]);
      if (dist < minDist) minDist = dist;
    }
    return minDist;
  }

  /** Distance from a point to a line segment (in meters, approximate) */
  private distanceToSegment(p: ILatLng, a: ILatLng, b: ILatLng): number {
    const dx = b.lng - a.lng;
    const dy = b.lat - a.lat;
    if (dx === 0 && dy === 0) return haversineMeters(p, a);

    let t = ((p.lng - a.lng) * dx + (p.lat - a.lat) * dy) / (dx * dx + dy * dy);
    t = Math.max(0, Math.min(1, t));

    const closest: ILatLng = {
      lat: a.lat + t * dy,
      lng: a.lng + t * dx
    };
    return haversineMeters(p, closest);
  }
}

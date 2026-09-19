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
import { requestWalkingDirections } from '../services/walking-directions.service';
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
/** Earth radius in meters for haversine */
const EARTH_RADIUS_M = 6_371_000;

export class DirectionsController {
  private static instance: DirectionsController;
  private mapProvider: IMapProvider | null = null;
  private routeRenderer: RouteRenderer;
  private vehicleTracker: VehicleTracker;

  // Directions mode state
  private _isActive = false;
  private selectedStop: IStop | null = null;
  private _selectedPredictions: IPrediction[] = [];
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
  private infoPanelCallback:
    | ((
        info: {
          durationMin: number;
          eta: string;
          predictions: IPrediction[];
          warnings?: string[];
        } | null
      ) => void)
    | null = null;
  // Callback executed when exiting directions mode
  private exitCallback: (() => void) | null = null;

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
  setInfoPanelCallback(
    cb: (
      info: {
        durationMin: number;
        eta: string;
        predictions: IPrediction[];
        warnings?: string[];
      } | null
    ) => void
  ): void {
    this.infoPanelCallback = cb;
  }

  /** Register a callback for when directions mode exits */
  setExitCallback(cb: () => void): void {
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

    if (!position || !this._isActive || !this.selectedStop) return;

    // Deviation/arrival checks use real GPS, not planned location
    const distToStop = this.haversine(position, {
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
    selectedPredictions: IPrediction[] = []
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
    this.stopPeriodicReroute();
    this.cancelInflightRequest();
    this.removeWalkingPolyline();
    this._isActive = true;
    this.selectedStop = stop;
    this._selectedPredictions = selectedPredictions;

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
    return true;
  }

  /**
   * Exit directions mode (A4).
   * Clears walking path, restores stops/routes.
   */
  exitDirections(): void {
    const wasActive = this._isActive;
    this.sessionId++;
    this._isActive = false;
    this.selectedStop = null;
    this._selectedPredictions = [];

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
    if (wasActive) this.exitCallback?.();
  }

  // ── Private helpers ──────────────────────────────────────────────────

  /**
   * Fetch directions from Google Directions API and render on map.
   */
  private async fetchAndRenderRoute(): Promise<boolean> {
    const origin = this.getDirectionsOrigin();
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
      !request.signal.aborted;

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
      const eta = new Date(Date.now() + result.durationSeconds * 1000);
      const etaStr = eta.toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit'
      });
      this.loadingCallback?.(false);
      if (!isCurrent()) return false;
      this.infoPanelCallback?.({
        durationMin,
        eta: etaStr,
        predictions: this._selectedPredictions,
        warnings: result.warnings ?? []
      });
      return true;
    } catch (err) {
      if (!isCurrent()) return false;
      console.error('[DirectionsController] Failed to fetch directions:', err);
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
    if (!this._isActive || this.inflightAbort) return;
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
    console.log('[DirectionsController] Arrived at stop!');
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

  /** Haversine distance between two points in meters */
  private haversine(a: ILatLng, b: ILatLng): number {
    const toRad = (deg: number) => (deg * Math.PI) / 180;
    const dLat = toRad(b.lat - a.lat);
    const dLng = toRad(b.lng - a.lng);
    const sinDLat = Math.sin(dLat / 2);
    const sinDLng = Math.sin(dLng / 2);
    const h =
      sinDLat * sinDLat +
      Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * sinDLng * sinDLng;
    return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(h));
  }

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
    if (dx === 0 && dy === 0) return this.haversine(p, a);

    let t = ((p.lng - a.lng) * dx + (p.lat - a.lat) * dy) / (dx * dx + dy * dy);
    t = Math.max(0, Math.min(1, t));

    const closest: ILatLng = {
      lat: a.lat + t * dy,
      lng: a.lng + t * dx
    };
    return this.haversine(p, closest);
  }
}

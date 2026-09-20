/**
 * Vehicle Tracker
 * Manages real-time vehicle position updates and rendering
 * Polls cached backend feeds and owns one shared display-animation loop.
 */

/** Haversine distance in miles between two lat/lon points (R9). */
function haversineDistanceMiles(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number
): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const R = 3958.8;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

import type {
  IMapProvider,
  IMapMarker,
  ILatLng
} from '../../../common/map.interface';
import type {
  IVehicle,
  IPattern,
  IStop
} from '../../../common/transit.interface';
import { MapStateManager } from '../state/map-state';
import { createBusIcon, type BusPositionStatus } from '../utils/bus-icon';
import { focusNearby } from '../utils/map-focus';
import { VehicleMotionEstimator } from '../services/vehicle-motion';
import {
  transitApiService,
  type IServiceHealth,
  type IVehicleResult
} from '../services/transit-api.service';
import { LiveTrackingStatus } from '../components/live-tracking-status';
import {
  MAP_POPUP_ID,
  createMapPopup,
  dismissPopup,
  minimizePopup,
  prepareForNewPopup,
  registerActivePopup
} from '../utils/map-popup';
import { getRouteTitle } from '../utils/route-display';
import { showToast } from '../utils/toast';

const POLL_MS = 10_000;
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_POSITION_AGE_MS = 90_000;
const MAX_RETAINED_AGE_MS = 15 * 60_000;
const MAX_CLOCK_SKEW_MS = 30_000;

export class VehicleTracker {
  private static instance: VehicleTracker;
  private mapProvider: IMapProvider | null = null;
  private stateManager: MapStateManager;
  private isAdminProximityBypass = false;
  private userLocation: { lat: number; lng: number } | null = null;

  private pollingInterval: number | null = null;
  private pollingGeneration = 0;
  private request: AbortController | null = null;
  private requestDeadline: number | null = null;
  private expiryTimer: number | null = null;
  private pageSuspended = false;
  private sessionToken: string | null = null;
  private readonly trackingStatus = new LiveTrackingStatus();
  private partialTracking = false;
  private delayedTracking = false;
  private readonly unavailableRoutes = new Set<string>();
  private readonly firstObserved = new Map<string, number>();
  private readonly sourceTimes = new Map<
    string,
    { value: string; time: number | null }
  >();
  private readonly vehicleOwners = new Map<string, string>();
  private readonly motion = new VehicleMotionEstimator();
  private readonly displayedPositions = new Map<string, ILatLng>();
  private readonly displayedHeadings = new Map<string, number | undefined>();
  private readonly displayedStatuses = new Map<string, BusPositionStatus>();
  private readonly iconKeys = new Map<string, string>();
  private animationFrame: number | null = null;
  private animationGeneration = 0;
  private displayMotionActive = false;
  private lastFrameTime = 0;
  private motionPreference: MediaQueryList | null = null;
  private currentRouteId: string | null = null;
  private currentRouteColor = '#4285F4';
  private routeColorMap = new Map<string, string>();
  private multiRouteIds: string[] = [];
  private vehicleMarkers = new Map<string, IMapMarker>(); // vehicleId → marker
  private vehicleData = new Map<string, IVehicle>(); // vehicleId → vehicle data for icon rebuilds
  private currentZoom = 14;
  private openPopupVehicleId: string | null = null;
  private popupUpdatedInterval: number | null = null;

  private constructor() {
    this.stateManager = MapStateManager.getInstance();
    document.addEventListener('visibilitychange', () => this.resumeOrPause());
    window.addEventListener('pagehide', () => {
      this.pageSuspended = true;
      this.resumeOrPause();
    });
    window.addEventListener('pageshow', () => {
      this.pageSuspended = false;
      this.resumeOrPause();
    });
    if (typeof window.matchMedia === 'function') {
      this.motionPreference = window.matchMedia(
        '(prefers-reduced-motion: reduce)'
      );
      this.motionPreference.addEventListener?.('change', () => {
        this.stopAnimation();
        this.updateDisplayedVehicles();
        this.startAnimation();
      });
    }
  }

  static getInstance(): VehicleTracker {
    if (!VehicleTracker.instance) {
      VehicleTracker.instance = new VehicleTracker();
    }
    return VehicleTracker.instance;
  }

  /**
   * Initialize with map provider
   */
  initialize(mapProvider: IMapProvider): void {
    this.stopAnimation();
    this.mapProvider = mapProvider;
    this.currentZoom = mapProvider.getZoom();

    // Listen for zoom changes and resize bus icons accordingly
    mapProvider.onZoomChanged((zoom: number) => {
      if (this.mapProvider !== mapProvider) return;
      this.currentZoom = zoom;
      this.updateAllIcons();
    });
  }

  /** Shared cached geometry constrains estimates to the selected transit route. */
  setRouteGeometry(
    routeId: string,
    patterns: IPattern[],
    stops: IStop[]
  ): void {
    this.motion.setRouteGeometry(routeId, patterns, stops);
  }

  /**
   * Enable proximity-check bypass for administrators.
   */
  setAdminProximityBypass(enabled: boolean): void {
    this.isAdminProximityBypass = enabled;
  }

  /**
   * Update the cached user location (called from map.ts watchPosition).
   */
  updateUserLocation(position: { lat: number; lng: number } | null): void {
    this.userLocation = position;
  }

  /**
   * Start polling for vehicle positions on a specific route.
   * @param routeColor Hex color of the route used to tint the bus icon.
   */
  startPolling(routeId: string, routeColor = '#4285F4'): void {
    if (!this.mapProvider) return;
    this.stopPolling();
    this.currentRouteId = routeId;
    this.currentRouteColor = routeColor;
    this.routeColorMap.set(routeId, routeColor);
    this.sessionToken = localStorage.getItem('token');
    this.resumeOrPause();
  }

  /** Stop the session, including requests, expiry checks and hidden-page resume. */
  stopPolling(): void {
    this.cancelPendingWork();
    this.currentRouteId = null;
    this.multiRouteIds = [];
    this.clearVehicles();
    this.trackingStatus.hide();
  }

  /** Track selected buses during directions using one shared polling cycle. */
  startMultiRoutePolling(
    routeIds: string[],
    routeColors?: Map<string, string>
  ): void {
    if (!this.mapProvider) return;
    this.stopPolling();
    this.multiRouteIds = [...new Set(routeIds)];
    routeColors?.forEach((color, id) => this.routeColorMap.set(id, color));
    this.sessionToken = localStorage.getItem('token');
    this.resumeOrPause();
  }

  private trackedRoutes(): string[] {
    return this.currentRouteId ? [this.currentRouteId] : this.multiRouteIds;
  }

  private cancelPendingWork(): void {
    this.stopAnimation();
    this.stopPopupUpdatedTicker();
    this.pollingGeneration++;
    this.request?.abort();
    this.request = null;
    if (this.pollingInterval !== null)
      window.clearTimeout(this.pollingInterval);
    if (this.requestDeadline !== null)
      window.clearTimeout(this.requestDeadline);
    if (this.expiryTimer !== null) window.clearTimeout(this.expiryTimer);
    this.pollingInterval = this.requestDeadline = this.expiryTimer = null;
  }

  private resumeOrPause(): void {
    if (!this.trackedRoutes().length) return;
    this.cancelPendingWork();
    if (this.sessionToken !== localStorage.getItem('token')) {
      this.stopPolling();
      return;
    }
    if (document.hidden || this.pageSuspended) {
      this.updateDisplayedVehicles(true);
      this.trackingStatus.show(
        'paused',
        'Live tracking paused while this tab is hidden.'
      );
      return;
    }
    this.pruneExpiredVehicles();
    this.trackingStatus.show('loading', 'Checking live bus locations...');
    void this.pollVehicles();
  }

  private isCurrent(generation: number): boolean {
    return (
      generation === this.pollingGeneration &&
      this.sessionToken === localStorage.getItem('token') &&
      !document.hidden &&
      !this.pageSuspended &&
      !!this.trackedRoutes().length
    );
  }

  /** One bounded cycle; a new one is scheduled only after this one finishes. */
  private async pollVehicles(): Promise<void> {
    const generation = this.pollingGeneration;
    if (!this.isCurrent(generation)) {
      if (generation === this.pollingGeneration) this.stopPolling();
      return;
    }
    const routeIds = [...this.trackedRoutes()];
    const request = new AbortController();
    this.request = request;
    const aborted = new Promise<null>((resolve) => {
      request.signal.addEventListener('abort', () => resolve(null), {
        once: true
      });
    });
    this.requestDeadline = window.setTimeout(
      () => request.abort(),
      REQUEST_TIMEOUT_MS
    );
    try {
      const state = this.stateManager.getState();
      const timeParam =
        this.currentRouteId && state.selectedTime && state.selectedDate
          ? this.formatTimeForAPI(state.selectedDate, state.selectedTime)
          : undefined;
      const results = await Promise.race([
        Promise.all([
          transitApiService.getHealth(request.signal),
          Promise.all(
            routeIds.map((routeId) =>
              transitApiService.getVehicles(routeId, timeParam, request.signal)
            )
          )
        ]),
        aborted
      ]);
      if (!this.isCurrent(generation)) return;
      if (!results) {
        this.showUnavailable();
      } else {
        this.applyResults(routeIds, results[0], results[1]);
      }
    } catch {
      if (this.isCurrent(generation)) this.showUnavailable();
    } finally {
      // An old cycle must never clear a newer session's timers or request.
      if (this.request === request) {
        if (this.requestDeadline !== null)
          window.clearTimeout(this.requestDeadline);
        this.requestDeadline = null;
        this.request = null;
      }
      request.abort();
      if (this.isCurrent(generation)) {
        this.pollingInterval = window.setTimeout(() => {
          this.pollingInterval = null;
          void this.pollVehicles();
        }, POLL_MS);
      } else if (
        generation === this.pollingGeneration &&
        this.sessionToken !== localStorage.getItem('token')
      ) {
        this.stopPolling();
      }
    }
  }

  private showUnavailable(): void {
    this.stopAnimation();
    this.trackedRoutes().forEach((id) => this.unavailableRoutes.add(id));
    this.vehicleData.forEach((vehicle, vid) => {
      this.motion.pause(
        vid,
        this.displayedPositions.get(vid) ?? {
          lat: vehicle.lat,
          lng: vehicle.lon
        }
      );
    });
    this.partialTracking = true;
    this.pruneExpiredVehicles();
    this.updateDisplayedVehicles();
    this.updateTrackingStatus(this.vehicleData.size);
    this.scheduleExpiry();
  }

  private sourceTime(vehicle: IVehicle): number | null {
    const accepted = this.sourceTimes.get(vehicle.vid);
    if (accepted?.value === vehicle.lastUpdate) return accepted.time;
    const time = Date.parse(vehicle.lastUpdate);
    return Number.isFinite(time) && time <= Date.now() + MAX_CLOCK_SKEW_MS
      ? time
      : null;
  }

  private hasValidCoordinates(vehicle: IVehicle): boolean {
    return (
      vehicle.source === 'live' &&
      Number.isFinite(vehicle.lat) &&
      Math.abs(vehicle.lat) <= 90 &&
      Number.isFinite(vehicle.lon) &&
      Math.abs(vehicle.lon) <= 180
    );
  }

  private canRetain(vehicle: IVehicle): boolean {
    if (!this.hasValidCoordinates(vehicle)) return false;
    const since =
      this.sourceTime(vehicle) ?? this.firstObserved.get(vehicle.vid);
    return since !== undefined && Date.now() - since < MAX_RETAINED_AGE_MS;
  }

  private isFresh(vehicle: IVehicle): boolean {
    const time = this.sourceTime(vehicle);
    return (
      this.hasValidCoordinates(vehicle) &&
      time !== null &&
      Date.now() - time < MAX_POSITION_AGE_MS &&
      !this.unavailableRoutes.has(
        this.vehicleOwners.get(vehicle.vid) ?? vehicle.routeId
      )
    );
  }

  private applyResults(
    routeIds: string[],
    health: IServiceHealth | null,
    results: (IVehicleResult | null)[]
  ): void {
    const vehicles = new Map<string, IVehicle>();
    let unavailable = 0;
    this.unavailableRoutes.clear();
    routeIds.forEach((routeId, index) => {
      const provider = routeId.startsWith('CMU-')
        ? health?.tripshotLiveStatus
        : health?.vehiclePositions;
      const result = results[index];
      const authoritative =
        !!provider?.healthy && !!result && result.source !== 'static';
      if (!authoritative) {
        unavailable++;
        this.unavailableRoutes.add(routeId);
        this.vehicleData.forEach((vehicle, vid) => {
          if (
            this.vehicleOwners.get(vid) === routeId &&
            this.canRetain(vehicle)
          )
            vehicles.set(vid, vehicle);
        });
      }
      const returnedIds = new Set<string>();
      if (result && result.source !== 'static') {
        result.vehicles.forEach((incoming) => {
          returnedIds.add(incoming.vid);
          if (!this.firstObserved.has(incoming.vid))
            this.firstObserved.set(incoming.vid, Date.now());
          this.vehicleOwners.set(incoming.vid, routeId);
          const previous = this.vehicleData.get(incoming.vid);
          const previousTime = previous ? this.sourceTime(previous) : null;
          const incomingTime = this.sourceTime(incoming);
          const sameJourney =
            previous?.routeId === incoming.routeId &&
            previous.tripId === incoming.tripId &&
            previous.shapeId === incoming.shapeId &&
            previous.direction === incoming.direction;
          // Cached or out-of-order payloads cannot move a known bus backward.
          let vehicle = incoming;
          if (
            previous &&
            previousTime !== null &&
            this.canRetain(previous) &&
            (incomingTime === null || incomingTime < previousTime)
          )
            vehicle = previous;
          else if (
            previous &&
            previousTime !== null &&
            incomingTime === previousTime &&
            sameJourney
          ) {
            // Safety metadata can change without a newer measurement; its coordinates cannot.
            vehicle = {
              ...incoming,
              lat: previous.lat,
              lon: previous.lon,
              heading: previous.heading
            };
          }
          this.sourceTimes.set(vehicle.vid, {
            value: vehicle.lastUpdate,
            time: this.sourceTime(vehicle)
          });
          if (!this.canRetain(vehicle)) return;
          vehicles.set(vehicle.vid, vehicle);
          this.motion.ingest(vehicle);
        });
      }
      if (authoritative) {
        this.vehicleOwners.forEach((owner, vid) => {
          if (owner === routeId && !returnedIds.has(vid)) {
            this.vehicleOwners.delete(vid);
            this.firstObserved.delete(vid);
            this.sourceTimes.delete(vid);
          }
        });
      }
    });
    this.partialTracking = unavailable > 0;
    const retained = [...vehicles.values()];
    retained.forEach((vehicle) => {
      if (
        this.unavailableRoutes.has(
          this.vehicleOwners.get(vehicle.vid) ?? vehicle.routeId
        )
      ) {
        this.motion.pause(
          vehicle.vid,
          this.displayedPositions.get(vehicle.vid) ?? {
            lat: vehicle.lat,
            lng: vehicle.lon
          }
        );
      }
    });
    this.delayedTracking =
      retained.some((vehicle) => !this.isFresh(vehicle)) ||
      results.some((result) => !!result?.vehicles.length && !retained.length);
    this.stateManager.setActiveVehicles(retained);
    this.renderVehicles(retained);
    this.updateTrackingStatus(retained.length);
    this.scheduleExpiry();
  }

  private updateTrackingStatus(count: number): void {
    if (this.partialTracking) {
      this.trackingStatus.show(
        this.unavailableRoutes.size === this.trackedRoutes().length
          ? 'unavailable'
          : 'partial',
        count
          ? 'Updates interrupted. Clock-marked buses show their last reported positions.'
          : 'Live tracking unavailable. Retrying automatically.'
      );
    } else if (this.delayedTracking) {
      this.trackingStatus.show(
        'delayed',
        count
          ? 'GPS updates are delayed. Route estimates may still move; tap a bus for its GPS age.'
          : 'Bus locations are delayed. Waiting for fresh updates.'
      );
    } else if (count === 0) {
      this.trackingStatus.show(
        'empty',
        'No active buses reported for this selection.'
      );
    } else {
      this.trackingStatus.show(
        'live',
        `${count} ${count === 1 ? 'bus' : 'buses'} tracked · movement between reports may be estimated`
      );
    }
  }

  /** One shared freshness/retention timer; never a timer per vehicle. */
  private scheduleExpiry(): void {
    if (this.expiryTimer !== null) window.clearTimeout(this.expiryTimer);
    this.expiryTimer = null;
    if (!this.vehicleData.size) return;
    const generation = this.pollingGeneration;
    this.expiryTimer = window.setTimeout(() => {
      this.expiryTimer = null;
      if (!this.isCurrent(generation)) return;
      this.pruneExpiredVehicles();
      this.updateDisplayedVehicles();
      this.startAnimation();
      if (this.vehicleData.size)
        this.delayedTracking = [...this.vehicleData.values()].some(
          (v) => !this.isFresh(v)
        );
      this.updateTrackingStatus(this.vehicleData.size);
      this.refreshOpenPopupUpdatedTime();
      this.vehicleData.forEach((_vehicle, vid) => this.refreshMarkerTitle(vid));
      this.scheduleExpiry();
    }, 1000);
  }

  private pruneExpiredVehicles(): void {
    const vehicles = [...this.vehicleData.values()].filter((vehicle) =>
      this.canRetain(vehicle)
    );
    if (vehicles.length === this.vehicleData.size) return;
    this.delayedTracking = true;
    this.stateManager.setActiveVehicles(vehicles);
    this.removeStaleVehicles(new Set(vehicles.map((vehicle) => vehicle.vid)));
  }

  /**
   * Return true when a vehicle should be visible given the current direction
   * toggle state.  Vehicles without a direction (CMU loops, or unknown) are
   * always shown.
   */
  private isVehicleVisible(
    vehicle: IVehicle,
    selectedDirections: { inbound: boolean; outbound: boolean }
  ): boolean {
    if (!vehicle.direction) return true;
    if (vehicle.direction === 'INBOUND') return selectedDirections.inbound;
    if (vehicle.direction === 'OUTBOUND') return selectedDirections.outbound;
    return true;
  }

  /**
   * Re-apply direction visibility to all currently-tracked vehicle markers.
   * Called when the inbound/outbound toggle changes so buses show/hide
   * immediately without waiting for the next polling tick.
   */
  refreshDirectionVisibility(): void {
    const { selectedDirections } = this.stateManager.getState();
    this.vehicleMarkers.forEach((marker, vid) => {
      const vehicle = this.vehicleData.get(vid);
      if (!vehicle) return;
      marker.setVisible(this.isVehicleVisible(vehicle, selectedDirections));
    });
    this.updateDisplayedVehicles();
    this.startAnimation();
  }

  /**
   * Render vehicle markers on map
   */
  private renderVehicles(vehicles: IVehicle[]): void {
    if (!this.mapProvider) return;

    const { selectedDirections } = this.stateManager.getState();
    const currentVehicleIds = new Set<string>();

    vehicles.forEach((vehicle) => {
      currentVehicleIds.add(vehicle.vid);

      // Always update the stored data so popup shows fresh info
      this.vehicleData.set(vehicle.vid, vehicle);

      const visible = this.isVehicleVisible(vehicle, selectedDirections);

      if (!this.vehicleMarkers.has(vehicle.vid)) {
        // Create new marker
        const busIcon = createBusIcon(
          vehicle,
          this.currentZoom,
          this.routeColorMap.get(vehicle.routeId) || this.currentRouteColor,
          this.isFresh(vehicle) ? 'reported' : 'delayed'
        );
        const marker = this.mapProvider!.addMarker({
          position: { lat: vehicle.lat, lng: vehicle.lon },
          title: `Bus ${vehicle.vid}${vehicle.isDetoured ? ' (Detoured)' : ''}`,
          icon: busIcon.url,
          iconAnchor: busIcon.anchor,
          iconSize: busIcon.size
        });

        marker.setVisible(visible);

        // Attach click handler for info popup
        marker.onClick(() => {
          this.showVehiclePopup(vehicle.vid);
          const position = this.displayedPositions.get(vehicle.vid);
          if (position && this.mapProvider)
            focusNearby(this.mapProvider, position);
        });

        this.vehicleMarkers.set(vehicle.vid, marker);
      }
      this.vehicleMarkers.get(vehicle.vid)!.setVisible(visible);
    });

    // Remove markers for vehicles no longer in response
    this.removeStaleVehicles(currentVehicleIds);
    this.updateDisplayedVehicles();
    this.startAnimation();
  }

  private updateDisplayedVehicles(forceRaw = false): void {
    const now = Date.now();
    const { selectedDirections } = this.stateManager.getState();
    this.displayMotionActive = false;
    this.vehicleData.forEach((vehicle, vid) => {
      const marker = this.vehicleMarkers.get(vid);
      if (!marker) return;
      const fresh = this.isFresh(vehicle);
      const allowEstimate =
        this.sourceTime(vehicle) !== null &&
        !forceRaw &&
        !this.motionPreference?.matches &&
        !document.hidden &&
        !this.pageSuspended;
      const estimate = allowEstimate ? this.motion.estimate(vid, now) : null;
      if (
        estimate?.moving &&
        this.isVehicleVisible(vehicle, selectedDirections)
      )
        this.displayMotionActive = true;
      const estimated = !!estimate?.estimated;
      const position = estimate?.position ?? {
        lat: vehicle.lat,
        lng: vehicle.lon
      };
      const heading = estimate ? estimate.heading : vehicle.heading;
      // Feed age governs reporting permissions; the motion model separately
      // decides whether a delayed but recently received fix supports motion.
      const status: BusPositionStatus =
        estimated && (estimate?.moving || fresh)
          ? 'estimated'
          : fresh
            ? 'reported'
            : 'delayed';
      const previous = this.displayedPositions.get(vid);
      if (
        !previous ||
        previous.lat !== position.lat ||
        previous.lng !== position.lng
      ) {
        marker.setPosition(position);
        this.displayedPositions.set(vid, position);
      }
      const statusChanged = this.displayedStatuses.get(vid) !== status;
      this.displayedHeadings.set(vid, heading);
      this.displayedStatuses.set(vid, status);
      if (statusChanged) this.refreshMarkerTitle(vid);
      this.updateMarkerIcon(vid);
    });
  }

  private startAnimation(): void {
    if (!this.displayMotionActive || !this.motion.hasActiveMotion()) {
      this.stopAnimation();
      return;
    }
    if (
      this.animationFrame !== null ||
      !this.vehicleData.size ||
      document.hidden ||
      this.pageSuspended ||
      this.motionPreference?.matches ||
      this.unavailableRoutes.size === this.trackedRoutes().length ||
      typeof window.requestAnimationFrame !== 'function'
    )
      return;
    const generation = this.animationGeneration;
    const frame = (timestamp: number) => {
      if (generation !== this.animationGeneration) return;
      this.animationFrame = null;
      if (this.sessionToken !== localStorage.getItem('token')) {
        this.stopPolling();
        return;
      }
      if (
        document.hidden ||
        this.pageSuspended ||
        this.motionPreference?.matches ||
        !this.vehicleData.size ||
        this.unavailableRoutes.size === this.trackedRoutes().length
      )
        return;
      if (timestamp - this.lastFrameTime >= 1000 / 30) {
        this.lastFrameTime = timestamp;
        this.updateDisplayedVehicles();
      }
      if (!this.displayMotionActive || !this.motion.hasActiveMotion()) return;
      this.animationFrame = window.requestAnimationFrame(frame);
    };
    this.animationFrame = window.requestAnimationFrame(frame);
  }

  private stopAnimation(): void {
    this.animationGeneration++;
    if (this.animationFrame !== null)
      window.cancelAnimationFrame(this.animationFrame);
    this.animationFrame = null;
    this.lastFrameTime = 0;
  }

  private updateMarkerIcon(vid: string): void {
    const vehicle = this.vehicleData.get(vid);
    const marker = this.vehicleMarkers.get(vid);
    if (!vehicle || !marker) return;
    const heading = this.displayedHeadings.get(vid) ?? vehicle.heading;
    // Quantize sub-degree changes; SVG allocation must not run for every frame.
    const roundedHeading =
      typeof heading === 'number' && Number.isFinite(heading)
        ? Math.round(heading / 3) * 3
        : undefined;
    const color =
      this.routeColorMap.get(vehicle.routeId) || this.currentRouteColor;
    const status = this.displayedStatuses.get(vid) ?? 'reported';
    const key = `${this.currentZoom}:${color}:${roundedHeading}:${vehicle.isDetoured}:${status}`;
    if (this.iconKeys.get(vid) === key) return;
    this.iconKeys.set(vid, key);
    marker.setIcon(
      createBusIcon(
        { ...vehicle, heading: roundedHeading },
        this.currentZoom,
        color,
        status
      )
    );
  }

  private refreshMarkerTitle(vid: string): void {
    const vehicle = this.vehicleData.get(vid);
    if (!vehicle) return;
    const status = this.displayedStatuses.get(vid);
    const description =
      status === 'delayed'
        ? 'Delayed position'
        : status === 'estimated'
          ? 'Estimated position'
          : 'Reported position';
    this.vehicleMarkers
      .get(vid)
      ?.setTitle?.(
        `Bus ${vid} — ${description}; ${this.formatElapsedTime(vehicle)}${vehicle.isDetoured ? '; detoured' : ''}`
      );
  }

  /**
   * Remove vehicle markers that are no longer active
   */
  private removeStaleVehicles(currentVehicleIds: Set<string>): void {
    const markersToRemove: string[] = [];

    this.vehicleMarkers.forEach((marker, vid) => {
      if (!currentVehicleIds.has(vid)) {
        if (this.openPopupVehicleId === vid) {
          this.closeVehiclePopup();
        }
        marker.remove();
        markersToRemove.push(vid);
      }
    });

    markersToRemove.forEach((vid) => {
      this.vehicleMarkers.delete(vid);
      this.vehicleData.delete(vid);
      this.motion.remove(vid);
      this.displayedPositions.delete(vid);
      this.displayedHeadings.delete(vid);
      this.displayedStatuses.delete(vid);
      this.iconKeys.delete(vid);
    });
    if (!this.vehicleData.size) this.stopAnimation();
  }

  /**
   * Clear all vehicle markers from map
   */
  clearVehicles(): void {
    this.stopAnimation();
    if (this.expiryTimer !== null) window.clearTimeout(this.expiryTimer);
    this.expiryTimer = null;
    this.stateManager.setActiveVehicles([]);
    this.vehicleMarkers.forEach((marker) => marker.remove());
    this.vehicleMarkers.clear();
    this.vehicleData.clear();
    this.motion.clear();
    this.firstObserved.clear();
    this.sourceTimes.clear();
    this.vehicleOwners.clear();
    this.unavailableRoutes.clear();
    this.displayedPositions.clear();
    this.displayedHeadings.clear();
    this.displayedStatuses.clear();
    this.iconKeys.clear();
    this.closeVehiclePopup();
    console.log('Cleared all vehicle markers');
  }

  /**
   * Get current vehicle positions (for zoom-to-bus)
   */
  getVehiclePositions(): Array<{ lat: number; lng: number }> {
    const positions: Array<{ lat: number; lng: number }> = [];
    this.displayedPositions.forEach((position) =>
      positions.push({ ...position })
    );
    return positions;
  }

  /**
   * Update all existing bus marker icons (called on zoom change)
   */
  private updateAllIcons(): void {
    this.vehicleMarkers.forEach((_marker, vid) => this.updateMarkerIcon(vid));
  }

  /**
   * Format date and time for API (YYYYMMDD HH:MM)
   */
  private formatTimeForAPI(
    date: Date,
    time: { hour: number; minute: number; period: 'AM' | 'PM' }
  ): string {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');

    // Convert to 24-hour format
    let hour24 = time.hour;
    if (time.period === 'PM' && time.hour !== 12) {
      hour24 += 12;
    } else if (time.period === 'AM' && time.hour === 12) {
      hour24 = 0;
    }

    const hourStr = String(hour24).padStart(2, '0');
    const minuteStr = String(time.minute).padStart(2, '0');

    return `${year}${month}${day} ${hourStr}:${minuteStr}`;
  }

  /**
   * Show toast notification
   */
  private showToast(message: string): void {
    showToast(message);
  }

  /** Build user-facing route text for popup subheader. */
  private getRouteSubheaderText(routeId: string): string {
    return getRouteTitle(routeId, this.stateManager.getState().availableRoutes);
  }

  /**
   * Show info popup for a clicked bus marker.
   * Reads the latest stored data for the vehicle.
   */
  private showVehiclePopup(vid: string): void {
    const vehicle = this.vehicleData.get(vid);
    if (!vehicle) return;

    prepareForNewPopup('bus');
    this.openPopupVehicleId = vid;

    const { popup, subheader } = createMapPopup(
      'bus',
      'directions_bus',
      `Bus ${vehicle.vid}`
    );
    subheader.textContent = this.getRouteSubheaderText(vehicle.routeId);

    // Keep the default card short; native disclosure retains keyboard access.
    const content = document.createElement('div');
    content.className = 'bus-popup__content';
    const positionState = document.createElement('p');
    positionState.className = 'bus-position-state';
    const nextStop = document.createElement('p');
    nextStop.className = 'bus-popup__next-stop';
    nextStop.hidden = true;
    content.append(positionState, nextStop);

    const more = document.createElement('details');
    more.className = 'bus-popup__more';
    const summary = document.createElement('summary');
    summary.textContent = 'Details';
    const explanation = document.createElement('p');
    explanation.className = 'bus-position-explanation';
    const details = document.createElement('div');
    details.className = 'map-popup__details';

    this.addDetailRow(details, 'Status', '', 'bus-reported-status');
    this.addDetailRow(details, 'Speed', '', 'bus-reported-speed');
    this.addDetailRow(details, 'Stop', '', 'bus-reported-stop');
    this.addDetailRow(
      details,
      'Source',
      vehicle.source === 'live'
        ? `${vehicle.routeId.startsWith('CMU-') ? 'CMU' : 'PRT'} live GPS`
        : 'Schedule'
    );

    // Last update
    const timeText = this.formatElapsedTime(vehicle);

    if (vehicle.source === 'live') {
      this.addUpdatedRowWithDot(details, timeText);
    } else {
      this.addDetailRow(
        details,
        'Updated',
        timeText,
        'map-popup__updated-time'
      );
    }

    more.append(summary, explanation, details);
    content.append(more);
    popup.append(content);

    // Action buttons — Report only available for live buses (server validates against GTFS-RT)
    const actions = document.createElement('div');
    actions.className = 'map-popup__actions';
    const reportBtnHtml = this.isFresh(vehicle)
      ? `<button class="map-popup__action-btn map-popup__action-btn--report">
           <span class="material-icons-outlined">warning_amber</span>
           <strong>Report</strong>
         </button>`
      : `<button class="map-popup__action-btn map-popup__action-btn--report" disabled title="Wait for a fresh vehicle report before submitting a report">
           <span class="material-icons-outlined">warning_amber</span>
           <strong>Report</strong>
         </button>`;
    actions.innerHTML = `
      ${reportBtnHtml}
      <button class="map-popup__action-btn map-popup__action-btn--check">
        <span class="material-icons-outlined">task_alt</span>
        <strong>Alerts</strong>
      </button>
    `;
    popup.appendChild(actions);

    // Append to map container
    const container = document.querySelector('.map-container');
    if (container) {
      container.appendChild(popup);
    }

    this.bindVehiclePopupActionButtons(popup, vid, vehicle);
    registerActivePopup(
      'bus',
      `Bus ${vehicle.vid}`,
      () => this.rebindVehiclePopupEvents(vid),
      undefined,
      this.getSelectedRouteColor()
    );

    this.startPopupUpdatedTicker();
    this.refreshOpenPopupUpdatedTime();
  }

  /**
   * Add the "Updated" row with a green live dot before the time text.
   */
  private addUpdatedRowWithDot(container: HTMLElement, timeText: string): void {
    const row = document.createElement('div');
    row.className = 'map-popup__row';

    const lbl = document.createElement('span');
    lbl.className = 'map-popup__label';
    lbl.textContent = 'Updated';

    const val = document.createElement('span');
    val.className = 'map-popup__value map-popup__value--live';
    val.innerHTML = `<span class="map-popup__live-dot"></span><span class="map-popup__updated-time">${timeText}</span>`;

    row.appendChild(lbl);
    row.appendChild(val);
    container.appendChild(row);
  }

  /**
   * Add a key-value detail row to the popup.
   */
  private addDetailRow(
    container: HTMLElement,
    label: string,
    value: string,
    valueClass?: string
  ): void {
    const row = document.createElement('div');
    row.className = 'map-popup__row';

    const lbl = document.createElement('span');
    lbl.className = 'map-popup__label';
    lbl.textContent = label;

    const val = document.createElement('span');
    val.className = 'map-popup__value';
    if (valueClass) {
      val.classList.add(valueClass);
    }
    val.textContent = value;

    row.appendChild(lbl);
    row.appendChild(val);
    container.appendChild(row);
  }

  /**
   * Format GTFS-RT VehicleStopStatus to human-readable text.
   */
  private formatStatus(status: string): string {
    switch (status) {
      case 'INCOMING_AT':
        return 'Arriving at stop';
      case 'STOPPED_AT':
        return 'Stopped at stop';
      case 'IN_TRANSIT_TO':
        return 'In transit to next stop';
      default:
        return status;
    }
  }

  /**
   * Convert heading degrees to compass direction + degrees.
   */
  private formatHeading(degrees: number): string {
    const dirs = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
    const idx = Math.round(degrees / 45) % 8;
    return `${dirs[idx]} (${Math.round(degrees)}°)`;
  }

  private formatElapsedTime(vehicle: IVehicle): string {
    const updatedAt = this.sourceTime(vehicle);
    if (updatedAt === null) return 'Update time unavailable';
    const secsAgo = Math.max(0, Math.floor((Date.now() - updatedAt) / 1000));
    return secsAgo < 60
      ? `${secsAgo}s ago`
      : `${Math.floor(secsAgo / 60)}m ago`;
  }

  private getSelectedRouteColor(): string | undefined {
    const selectedId = this.stateManager.getState().selectedRouteId;
    return selectedId ? this.routeColorMap.get(selectedId) : undefined;
  }

  private handlePopupMinimize(vid: string, vehicle: IVehicle): void {
    this.stopPopupUpdatedTicker();
    const label = `Bus ${vehicle.vid}`;
    const routeColor = this.getSelectedRouteColor();
    minimizePopup(
      'bus',
      label,
      () => this.rebindVehiclePopupEvents(vid),
      undefined,
      routeColor
    );
  }

  private handlePopupReport(vid: string): void {
    const latestVehicle = this.vehicleData.get(vid);
    if (!latestVehicle || !this.isFresh(latestVehicle)) {
      this.showToast(
        'Wait for a fresh bus location before submitting a report.'
      );
      return;
    }
    if (!this.userLocation) {
      this.showToast(
        'Location access is required to submit a bus report. Please enable location services.'
      );
      return;
    }

    const userLat = this.userLocation.lat;
    const userLon = this.userLocation.lng;

    if (!this.isAdminProximityBypass) {
      const dist = haversineDistanceMiles(
        userLat,
        userLon,
        latestVehicle.lat,
        latestVehicle.lon
      );
      if (dist > 0.5) {
        this.showToast('You need to be near this bus to submit a report.');
        return;
      }
    }

    document.dispatchEvent(
      new CustomEvent('busReport', {
        detail: {
          vid: latestVehicle.vid,
          routeId: latestVehicle.routeId,
          routeLabel: this.getRouteSubheaderText(latestVehicle.routeId),
          lat: userLat,
          lon: userLon
        }
      })
    );
  }

  private handlePopupCheck(vehicle: IVehicle): void {
    window.location.href = `/notifications?bus=${encodeURIComponent(vehicle.vid)}`;
  }

  private bindVehiclePopupActionButtons(
    popup: HTMLElement,
    vid: string,
    vehicle: IVehicle
  ): void {
    const more = popup.querySelector<HTMLDetailsElement>('.bus-popup__more');
    more?.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape' || !more.open) return;
      event.preventDefault();
      more.open = false;
      more.querySelector('summary')?.focus();
    });
    const minimizeBtn = popup.querySelector('.map-popup__minimize');
    if (minimizeBtn) {
      minimizeBtn.addEventListener('click', () => {
        this.handlePopupMinimize(vid, vehicle);
      });
    }

    const closeBtn = popup.querySelector('.map-popup__close');
    if (closeBtn) {
      closeBtn.addEventListener('click', () => {
        this.stopPopupUpdatedTicker();
        dismissPopup('bus');
      });
    }

    const reportBtn = popup.querySelector(
      '.map-popup__action-btn--report'
    ) as HTMLButtonElement | null;
    if (reportBtn) {
      reportBtn.addEventListener('click', () => {
        this.handlePopupReport(vid);
      });
    }

    const checkBtn = popup.querySelector('.map-popup__action-btn--check');
    if (checkBtn) {
      checkBtn.addEventListener('click', () => {
        this.handlePopupCheck(vehicle);
      });
    }
  }

  private startPopupUpdatedTicker(): void {
    this.stopPopupUpdatedTicker();
    this.popupUpdatedInterval = window.setInterval(() => {
      this.refreshOpenPopupUpdatedTime();
    }, 1000);
  }

  private stopPopupUpdatedTicker(): void {
    if (this.popupUpdatedInterval !== null) {
      clearInterval(this.popupUpdatedInterval);
      this.popupUpdatedInterval = null;
    }
  }

  private refreshOpenPopupUpdatedTime(): void {
    if (!this.openPopupVehicleId) return;

    const popup = document.getElementById(MAP_POPUP_ID);
    if (!popup) {
      this.openPopupVehicleId = null;
      this.stopPopupUpdatedTicker();
      return;
    }

    const vehicle = this.vehicleData.get(this.openPopupVehicleId);
    if (!vehicle) return;

    const fresh = this.isFresh(vehicle);
    const estimated = this.displayedStatuses.get(vehicle.vid) === 'estimated';
    const positionKind = estimated
      ? 'estimated'
      : fresh
        ? 'reported'
        : 'delayed';
    const status = popup.querySelector<HTMLElement>('.bus-position-state');
    if (status) {
      status.dataset.state = positionKind;
      const label = {
        estimated: 'Estimated',
        reported: 'Reported',
        delayed: 'Delayed'
      }[positionKind];
      const age =
        this.sourceTime(vehicle) === null
          ? 'GPS age unknown'
          : `GPS ${this.formatElapsedTime(vehicle)}`;
      status.textContent = `${label} · ${age}`;
    }
    const explanation = popup.querySelector('.bus-position-explanation');
    if (explanation) {
      explanation.textContent = estimated
        ? 'Movement is estimated along the route between GPS reports. Older reports mean less certainty. Details below come from the last report.'
        : !fresh
          ? 'Position updates are paused; this bus may have moved. Reporting becomes available when fresh GPS returns.'
          : 'Showing the latest GPS report. Speed and stop details are from that report.';
      if (estimated && !fresh)
        explanation.textContent += ' Reporting needs a fresher GPS update.';
    }
    const nextStop = popup.querySelector<HTMLElement>('.bus-popup__next-stop');
    if (nextStop) {
      nextStop.hidden = !vehicle.currentStopId;
      const prefix =
        vehicle.currentStatus === 'STOPPED_AT'
          ? 'At stop'
          : vehicle.currentStatus === 'INCOMING_AT'
            ? 'Approaching stop'
            : vehicle.currentStatus === 'IN_TRANSIT_TO'
              ? 'Next stop'
              : 'Reported stop';
      nextStop.textContent = vehicle.currentStopId
        ? `${prefix} #${vehicle.currentStopId}`
        : '';
    }
    const report = popup.querySelector<HTMLButtonElement>(
      '.map-popup__action-btn--report'
    );
    if (report) {
      report.disabled = !fresh;
      report.title = fresh
        ? ''
        : 'Wait for a fresh vehicle report before submitting a report';
    }
    const dot = popup.querySelector<HTMLElement>('.map-popup__live-dot');
    if (dot) dot.hidden = !fresh;
    const statusRow = popup.querySelector('.map-popup__value--live');
    statusRow?.classList.toggle('bus-position-delayed', !fresh);
    const reportedValues: Record<string, string> = {
      '.bus-reported-status': vehicle.currentStatus
        ? this.formatStatus(vehicle.currentStatus)
        : 'Not reported',
      '.bus-reported-speed':
        typeof vehicle.speed === 'number' && Number.isFinite(vehicle.speed)
          ? `${(vehicle.speed * 2.23694).toFixed(1)} mph`
          : 'Not reported',
      '.bus-reported-stop': vehicle.currentStopId
        ? `#${vehicle.currentStopId}`
        : 'Not reported'
    };
    for (const [selector, value] of Object.entries(reportedValues)) {
      const node = popup.querySelector(selector);
      if (node) node.textContent = value;
    }

    const updatedNode = popup.querySelector<HTMLElement>(
      '.map-popup__updated-time'
    );
    if (updatedNode) {
      updatedNode.textContent = this.formatElapsedTime(vehicle);
    }
  }

  /**
   * Re-bind event listeners on the bus popup after restoring from a docked tab.
   */
  private rebindVehiclePopupEvents(vid: string): void {
    const popup = document.getElementById(MAP_POPUP_ID);
    if (!popup) return;

    const vehicle = this.vehicleData.get(vid);
    if (!vehicle) return;

    this.openPopupVehicleId = vid;

    this.bindVehiclePopupActionButtons(popup, vid, vehicle);

    // Restart updated ticker
    this.startPopupUpdatedTicker();
    this.refreshOpenPopupUpdatedTime();
  }

  private closeVehiclePopup(): void {
    this.openPopupVehicleId = null;
    this.stopPopupUpdatedTicker();
    dismissPopup('bus');
  }

  /**
   * Check if currently polling
   */
  isPolling(): boolean {
    return (
      this.trackedRoutes().length > 0 && !document.hidden && !this.pageSuspended
    );
  }

  /**
   * Get current route being tracked
   */
  getCurrentRouteId(): string | null {
    return this.currentRouteId;
  }
}

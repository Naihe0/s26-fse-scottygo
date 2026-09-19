/**
 * Vehicle Tracker
 * Manages real-time vehicle position updates and rendering
 * Polls backend every 30 seconds to match the GTFS-RT feed refresh rate
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

import type { IMapProvider, IMapMarker } from '../../../common/map.interface';
import type { IVehicle } from '../../../common/transit.interface';
import { MapStateManager } from '../state/map-state';
import { createBusIcon } from '../utils/bus-icon';
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

const POLL_MS = 30_000;
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_POSITION_AGE_MS = 90_000;
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
    this.mapProvider = mapProvider;
    this.currentZoom = mapProvider.getZoom();

    // Listen for zoom changes and resize bus icons accordingly
    mapProvider.onZoomChanged((zoom: number) => {
      this.currentZoom = zoom;
      this.updateAllIcons();
    });
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
  updateUserLocation(position: { lat: number; lng: number }): void {
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
    this.clearVehicles();
    if (this.sessionToken !== localStorage.getItem('token')) {
      this.stopPolling();
      return;
    }
    if (document.hidden || this.pageSuspended) {
      this.trackingStatus.show(
        'paused',
        'Live tracking paused while this tab is hidden.'
      );
      return;
    }
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
    this.clearVehicles();
    this.trackingStatus.show(
      'unavailable',
      'Live tracking unavailable. Retrying automatically.'
    );
  }

  private isFresh(vehicle: IVehicle): boolean {
    const age = Date.now() - Date.parse(vehicle.lastUpdate);
    return (
      vehicle.source === 'live' &&
      Number.isFinite(age) &&
      age >= -MAX_CLOCK_SKEW_MS &&
      age < MAX_POSITION_AGE_MS &&
      Number.isFinite(vehicle.lat) &&
      Math.abs(vehicle.lat) <= 90 &&
      Number.isFinite(vehicle.lon) &&
      Math.abs(vehicle.lon) <= 180
    );
  }

  private applyResults(
    routeIds: string[],
    health: IServiceHealth | null,
    results: (IVehicleResult | null)[]
  ): void {
    const vehicles: IVehicle[] = [];
    let unavailable = 0;
    let delayed = false;
    routeIds.forEach((routeId, index) => {
      const provider = routeId.startsWith('CMU-')
        ? health?.tripshotLiveStatus
        : health?.vehiclePositions;
      const result = results[index];
      if (!provider?.healthy || !result || result.source === 'static') {
        unavailable++;
        return;
      }
      result.vehicles.forEach((vehicle) => {
        if (this.isFresh(vehicle)) vehicles.push(vehicle);
        else delayed = true;
      });
    });
    this.partialTracking = unavailable > 0;
    this.delayedTracking = delayed;
    this.stateManager.setActiveVehicles(vehicles);
    this.renderVehicles(vehicles);
    if (unavailable === routeIds.length) {
      this.trackingStatus.show(
        'unavailable',
        'Live tracking unavailable. Retrying automatically.'
      );
    } else {
      this.updateTrackingStatus(vehicles.length);
    }
    this.scheduleExpiry();
  }

  private updateTrackingStatus(count: number): void {
    if (this.partialTracking) {
      this.trackingStatus.show(
        'partial',
        'Some live bus locations are unavailable. Retrying automatically.'
      );
    } else if (this.delayedTracking) {
      this.trackingStatus.show(
        'delayed',
        count
          ? 'Some bus locations are delayed. Only fresh locations are shown.'
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
        `${count} live ${count === 1 ? 'bus' : 'buses'} on selected ${this.trackedRoutes().length === 1 ? 'route' : 'routes'}`
      );
    }
  }

  /** Never leave a green live marker behind while a network request stalls. */
  private scheduleExpiry(): void {
    if (this.expiryTimer !== null) window.clearTimeout(this.expiryTimer);
    this.expiryTimer = null;
    if (!this.vehicleData.size) return;
    const generation = this.pollingGeneration;
    const expiresAt = Math.min(
      ...[...this.vehicleData.values()].map(
        (vehicle) => Date.parse(vehicle.lastUpdate) + MAX_POSITION_AGE_MS
      )
    );
    this.expiryTimer = window.setTimeout(
      () => {
        this.expiryTimer = null;
        if (!this.isCurrent(generation)) return;
        const vehicles = [...this.vehicleData.values()].filter((vehicle) =>
          this.isFresh(vehicle)
        );
        if (vehicles.length !== this.vehicleData.size)
          this.delayedTracking = true;
        this.stateManager.setActiveVehicles(vehicles);
        this.renderVehicles(vehicles);
        this.updateTrackingStatus(vehicles.length);
        this.scheduleExpiry();
      },
      Math.max(1, expiresAt - Date.now())
    );
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

      if (this.vehicleMarkers.has(vehicle.vid)) {
        // Smoothly animate existing marker to new position
        const marker = this.vehicleMarkers.get(vehicle.vid)!;
        marker.animatePosition({ lat: vehicle.lat, lng: vehicle.lon }, 5000);
        // Update icon in case heading changed
        marker.setIcon(
          createBusIcon(
            vehicle,
            this.currentZoom,
            this.routeColorMap.get(vehicle.routeId) || this.currentRouteColor
          )
        );
        marker.setVisible(visible);
      } else {
        // Create new marker
        const busIcon = createBusIcon(
          vehicle,
          this.currentZoom,
          this.routeColorMap.get(vehicle.routeId) || this.currentRouteColor
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
        marker.onClick(() => this.showVehiclePopup(vehicle.vid));

        this.vehicleMarkers.set(vehicle.vid, marker);
      }
    });

    // Remove markers for vehicles no longer in response
    this.removeStaleVehicles(currentVehicleIds);
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
    });
  }

  /**
   * Clear all vehicle markers from map
   */
  clearVehicles(): void {
    if (this.expiryTimer !== null) window.clearTimeout(this.expiryTimer);
    this.expiryTimer = null;
    this.stateManager.setActiveVehicles([]);
    this.vehicleMarkers.forEach((marker) => marker.remove());
    this.vehicleMarkers.clear();
    this.vehicleData.clear();
    this.closeVehiclePopup();
    console.log('Cleared all vehicle markers');
  }

  /**
   * Get current vehicle positions (for zoom-to-bus)
   */
  getVehiclePositions(): Array<{ lat: number; lng: number }> {
    const positions: Array<{ lat: number; lng: number }> = [];
    this.vehicleData.forEach((vehicle) => {
      positions.push({ lat: vehicle.lat, lng: vehicle.lon });
    });
    return positions;
  }

  /**
   * Update all existing bus marker icons (called on zoom change)
   */
  private updateAllIcons(): void {
    this.vehicleMarkers.forEach((marker, vid) => {
      const vehicle = this.vehicleData.get(vid);
      if (vehicle) {
        marker.setIcon(
          createBusIcon(
            vehicle,
            this.currentZoom,
            this.routeColorMap.get(vehicle.routeId) || this.currentRouteColor
          )
        );
      }
    });
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

    // Detail rows
    const details = document.createElement('div');
    details.className = 'map-popup__details';

    // Status
    if (vehicle.currentStatus) {
      const statusLabel = this.formatStatus(vehicle.currentStatus);
      this.addDetailRow(details, 'Status', statusLabel);
    }

    // Speed
    if (vehicle.speed != null) {
      // GTFS-RT speed is m/s → convert to mph
      const mph = (vehicle.speed * 2.23694).toFixed(1);
      this.addDetailRow(details, 'Speed', `${mph} mph`);
    }

    // Next stop
    if (vehicle.currentStopId) {
      this.addDetailRow(details, 'Next Stop', `#${vehicle.currentStopId}`);
    }

    // Last update
    const timeText = this.formatElapsedTime(vehicle.lastUpdate);

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

    popup.appendChild(details);

    // Source badge — only for scheduled (live uses the green dot instead)
    if (vehicle.source !== 'live') {
      const badge = document.createElement('div');
      badge.className = `map-popup__source map-popup__source--${vehicle.source}`;
      badge.textContent = 'SCHEDULED';
      popup.appendChild(badge);
    }

    // Action buttons — Report only available for live buses (server validates against GTFS-RT)
    const actions = document.createElement('div');
    actions.className = 'map-popup__actions';
    const reportBtnHtml =
      vehicle.source === 'live'
        ? `<button class="map-popup__action-btn map-popup__action-btn--report">
           <span class="material-icons-outlined">warning_amber</span>
           <strong>Report</strong>
         </button>`
        : `<button class="map-popup__action-btn map-popup__action-btn--report" disabled title="Reporting only available for live buses">
           <span class="material-icons-outlined">warning_amber</span>
           <strong>Report</strong>
         </button>`;
    actions.innerHTML = `
      ${reportBtnHtml}
      <button class="map-popup__action-btn map-popup__action-btn--check">
        <span class="material-icons-outlined">task_alt</span>
        <strong>Check</strong>
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

  private formatElapsedTime(lastUpdate: string): string {
    const updatedAt = new Date(lastUpdate);
    const secsAgo = Math.max(
      0,
      Math.round((Date.now() - updatedAt.getTime()) / 1000)
    );
    return secsAgo < 60
      ? `${secsAgo}s ago`
      : `${Math.round(secsAgo / 60)}m ago`;
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

  private handlePopupReport(vid: string, fallbackVehicle: IVehicle): void {
    if (!this.userLocation) {
      this.showToast(
        'Location access is required to submit a bus report. Please enable location services.'
      );
      return;
    }

    const userLat = this.userLocation.lat;
    const userLon = this.userLocation.lng;
    const latestVehicle = this.vehicleData.get(vid) ?? fallbackVehicle;

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
        this.handlePopupReport(vid, vehicle);
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

    const updatedNode = popup.querySelector<HTMLElement>(
      '.map-popup__updated-time'
    );
    if (updatedNode) {
      updatedNode.textContent = this.formatElapsedTime(vehicle.lastUpdate);
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

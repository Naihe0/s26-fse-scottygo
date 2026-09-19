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
import { transitApiService } from '../services/transit-api.service';
import {
  MAP_POPUP_ID,
  createMapPopup,
  closeMapPopup,
  dismissPopup,
  minimizePopup,
  prepareForNewPopup,
  registerActivePopup
} from '../utils/map-popup';
import { getRouteTitle } from '../utils/route-display';
import { showToast } from '../utils/toast';

export class VehicleTracker {
  private static instance: VehicleTracker;
  private mapProvider: IMapProvider | null = null;
  private stateManager: MapStateManager;
  private isAdminProximityBypass = false;
  private userLocation: { lat: number; lng: number } | null = null;

  private pollingInterval: number | null = null;
  private pollingGeneration = 0;
  private currentRouteId: string | null = null;
  private currentRouteColor = '#4285F4';
  private routeColorMap = new Map<string, string>();
  private multiRouteIds: string[] = [];
  private multiRoutePollingInterval: number | null = null;
  private vehicleMarkers = new Map<string, IMapMarker>(); // vehicleId → marker
  private vehicleData = new Map<string, IVehicle>(); // vehicleId → vehicle data for icon rebuilds
  private hasShownStaticToast = false;
  private hasShownNoVehiclesToast = false;
  private currentZoom = 14;
  private openPopupVehicleId: string | null = null;
  private popupUpdatedInterval: number | null = null;

  private constructor() {
    this.stateManager = MapStateManager.getInstance();
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
    this.currentRouteColor = routeColor;
    this.routeColorMap.set(routeId, routeColor);
    if (!this.mapProvider) {
      console.error('Map provider not initialized');
      return;
    }

    // Stop previous polling
    this.stopPolling();

    this.currentRouteId = routeId;
    this.hasShownStaticToast = false;
    this.hasShownNoVehiclesToast = false;

    // Initial fetch
    this.updateVehiclePositions();

    // Poll every 30 seconds (matches GTFS-RT feed refresh rate)
    this.pollingInterval = window.setInterval(() => {
      this.updateVehiclePositions();
    }, 30000);

    console.log(`Started vehicle polling for route ${routeId}`);
  }

  /**
   * Stop polling vehicle positions
   */
  stopPolling(): void {
    // SDK/network requests may finish after timers and markers are cleared.
    this.pollingGeneration++;
    if (this.pollingInterval !== null) {
      clearInterval(this.pollingInterval);
      this.pollingInterval = null;
      console.log('Stopped vehicle polling');
    }

    this.stopMultiRoutePolling();

    // Clear all vehicle markers
    this.clearVehicles();
    this.currentRouteId = null;
    this.hasShownStaticToast = false;
    this.hasShownNoVehiclesToast = false;
  }

  /**
   * Start polling vehicle positions for multiple routes simultaneously.
   * Used during directions mode to show selected bus locations.
   */
  startMultiRoutePolling(
    routeIds: string[],
    routeColors?: Map<string, string>
  ): void {
    if (!this.mapProvider || routeIds.length === 0) return;

    this.stopPolling();
    this.multiRouteIds = [...routeIds];
    if (routeColors) {
      routeColors.forEach((color, id) => this.routeColorMap.set(id, color));
    }

    // Initial fetch
    this.updateMultiRoutePositions();

    // Poll every 30 seconds
    this.multiRoutePollingInterval = window.setInterval(() => {
      this.updateMultiRoutePositions();
    }, 30000);

    console.log(
      `Started multi-route vehicle polling for routes: ${routeIds.join(', ')}`
    );
  }

  /**
   * Stop multi-route polling as part of stopping the current polling session.
   */
  private stopMultiRoutePolling(): void {
    if (this.multiRoutePollingInterval !== null) {
      clearInterval(this.multiRoutePollingInterval);
      this.multiRoutePollingInterval = null;
    }
    this.multiRouteIds = [];
  }

  /**
   * Fetch and render vehicle positions for all multi-route IDs.
   * Collects vehicles from every route first, then renders in a single
   * pass so that `removeStaleVehicles` doesn't discard one route's
   * markers while processing the next.
   */
  private async updateMultiRoutePositions(): Promise<void> {
    if (!this.mapProvider || this.multiRouteIds.length === 0) return;

    const generation = this.pollingGeneration;
    const allVehicles: IVehicle[] = [];
    for (const routeId of this.multiRouteIds) {
      const result = await transitApiService.getVehicles(routeId);
      if (generation !== this.pollingGeneration) return;
      if (result !== null) {
        allVehicles.push(...result.vehicles);
      }
    }
    this.renderVehicles(allVehicles);
  }

  /**
   * Fetch and update vehicle positions from backend
   */
  private async updateVehiclePositions(): Promise<void> {
    if (!this.currentRouteId || !this.mapProvider) return;

    const generation = this.pollingGeneration;
    const state = this.stateManager.getState();
    let timeParam: string | undefined;

    // Add time parameter if time filter is applied (Rule R3)
    if (state.selectedTime && state.selectedDate) {
      timeParam = this.formatTimeForAPI(state.selectedDate, state.selectedTime);
    }

    const result = await transitApiService.getVehicles(
      this.currentRouteId,
      timeParam
    );
    if (generation !== this.pollingGeneration || result === null) return;

    // Check if data is from static cache (A2: PRT API Down)
    if (result.source === 'static' && !this.hasShownStaticToast) {
      this.showToast(
        'Real-time tracking unavailable. Showing scheduled times only.'
      );
      this.hasShownStaticToast = true;
    }

    const { vehicles } = result;
    if (vehicles.length === 0) {
      if (!this.hasShownNoVehiclesToast) {
        this.showToast('No active buses found for this route');
        this.hasShownNoVehiclesToast = true;
      }
    } else {
      this.hasShownNoVehiclesToast = false;
    }

    this.stateManager.setActiveVehicles(vehicles);
    this.renderVehicles(vehicles);
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
    closeMapPopup();
  }

  /**
   * Check if currently polling
   */
  isPolling(): boolean {
    return this.pollingInterval !== null;
  }

  /**
   * Get current route being tracked
   */
  getCurrentRouteId(): string | null {
    return this.currentRouteId;
  }
}

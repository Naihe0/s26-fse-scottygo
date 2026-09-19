/**
 * Filter Controller
 * Coordinates filter application and manages API calls
 * Implements the progressive filtering strategy
 */

import { transitApiService } from '../services/transit-api.service';
import type {
  IRoute,
  IStop,
  IPattern,
  IBulkTransitData,
  IDetour,
  INearbyStop,
  INearbyStopsPayload,
  IRouteSchedule
} from '../../../common/transit.interface';
import type { IServiceHealth } from '../services/transit-api.service';
import type { ILatLng } from '../../../common/map.interface';
import {
  MapStateManager,
  type IMapState,
  type ISelectedTime
} from '../state/map-state';
import { RouteRenderer, type RouteData } from '../renderers/route-renderer';
import {
  MAP_POPUP_ID,
  dismissPopup,
  minimizePopup,
  prepareForNewPopup,
  registerActivePopup
} from '../utils/map-popup';
import { VehicleTracker } from '../trackers/vehicle-tracker';
import { DirectionsController } from './directions-controller';
import { PredictionController } from './prediction-controller';
import { URLSyncManager } from '../state/url-sync';
import type { IRouteOption } from '../components/route-selector';
import {
  buildRouteOptions,
  buildServiceBannerMarkup,
  estimateWalkMinutes
} from './filter-controller.helpers';
import { AuthService } from '../services/auth.service';

// Augment the global Window interface with the showModal utility
declare global {
  interface Window {
    showModal?: (title: string, message: string) => void;
  }
}

export class FilterController {
  private static instance: FilterController;
  private stateManager: MapStateManager;
  private routeRenderer: RouteRenderer;
  private vehicleTracker: VehicleTracker;
  private urlSync: URLSyncManager;
  private routeSelectorUpdateCallback:
    | ((routes: IRouteOption[]) => void)
    | null = null;
  private routeColorCache = new Map<string, string>(); // Persists TrueTime colors across filter changes
  /** Client-side pattern store populated from /transit/bulk */
  private patternCache = new Map<string, IPattern[]>();
  /** Client-side stop store populated from /transit/bulk, keyed "routeId:DIRECTION" */
  private stopCache = new Map<string, IStop[]>();
  /** Whether bulk data has been loaded */
  private bulkLoaded = false;
  private allRoutesCache = new Map<string, IRoute>();
  private viewRevision = 0;
  private viewRendering = false;
  private pendingRouteBody: HTMLElement | null = null;

  /** Return the stop cache (routeId:DIRECTION → stops) for the search component. */
  getStopsData(): Record<string, IStop[]> {
    const result: Record<string, IStop[]> = {};
    for (const [key, stops] of this.stopCache.entries()) {
      result[key] = stops;
    }
    return result;
  }
  /** Interval handle for health polling */
  private healthPollInterval: number | null = null;
  private healthPollEnabled = false;
  private healthPollVersion = 0;
  private healthRequest: AbortController | null = null;
  private transitRecoveryPending = false;
  private recoveryChecks = 0;
  /** Tracks whether colors were available on the last health check (for detecting recovery). */
  private colorsWereAvailable = false;
  /** Directions controller reference */
  private directionsController: DirectionsController;
  /** Member's current location for TUC4 walk-time estimates */
  private userLocation: ILatLng | null = null;
  /** Whether nearby stops are currently rendered on the map */
  private nearbyStopsActive = false;
  /** Route IDs that have nearby stops (used to restore hidden routes) */
  private nearbyRouteIds = new Set<string>();

  /** Walk-time heuristic: 1 km ≈ 15 min (TUC4 R4) */
  private static readonly WALK_MINUTES_PER_KM = 15;
  private static readonly DAY_NAMES = [
    'Sun',
    'Mon',
    'Tue',
    'Wed',
    'Thu',
    'Fri',
    'Sat'
  ];
  private constructor() {
    this.stateManager = MapStateManager.getInstance();
    this.routeRenderer = RouteRenderer.getInstance();
    this.vehicleTracker = VehicleTracker.getInstance();
    this.directionsController = DirectionsController.getInstance();
    this.urlSync = URLSyncManager.getInstance();

    const predCtrl = PredictionController.getInstance();
    predCtrl.setRouteColorProvider(
      (routeId) =>
        this.routeColorCache.get(routeId) || this.getFallbackRouteColor(routeId)
    );
    predCtrl.setWalkTimeProvider((lat, lon) =>
      this.estimateWalkMinutes(lat, lon)
    );
    window.addEventListener('pagehide', () => this.stopHealthPolling());
    window.addEventListener('pageshow', (event) => {
      if (event.persisted) this.startHealthPolling();
    });
  }

  static getInstance(): FilterController {
    if (!FilterController.instance) {
      FilterController.instance = new FilterController();
    }
    return FilterController.instance;
  }

  /**
   * Register callback to update route selector when available routes change
   */
  setRouteSelectorCallback(callback: (routes: IRouteOption[]) => void): void {
    this.routeSelectorUpdateCallback = callback;
  }

  /**
   * Update the Member's current location (called from map.ts watchPosition).
   * Used for walk-time heuristic in stop popups (TUC4 R4).
   */
  setUserLocation(position: ILatLng): void {
    this.userLocation = position;
  }

  /** Fallback route color when metadata is temporarily unavailable. */
  private getFallbackRouteColor(routeId: string): string {
    return routeId.startsWith('CMU-') ? '#C41230' : '#4285F4';
  }

  /** Return the current immutable map-state snapshot. */
  private getCurrentState(): Readonly<IMapState> {
    return this.stateManager.getState();
  }

  /** Find one available route by id from a state snapshot. */
  private findAvailableRoute(
    routeId: string,
    state: Readonly<IMapState> = this.getCurrentState()
  ): IRoute | undefined {
    return state.availableRoutes.find((route) => route.id === routeId);
  }

  /** Keep URL query params synchronized to the latest state snapshot. */
  private syncURLWithCurrentState(): void {
    this.urlSync.updateURL(this.getCurrentState());
  }

  /**
   * Publish available routes to state and refresh route-selector options.
   * When `useSystemFilter` is false, selector options are built directly from
   * `selectorRoutes` (used by date-time filtering).
   */
  private publishAvailableRoutes(
    availableRoutes: IRoute[],
    selectorRoutes: IRoute[] = availableRoutes,
    useSystemFilter = true
  ): void {
    if (useSystemFilter)
      availableRoutes.forEach((route) =>
        this.allRoutesCache.set(route.id, route)
      );
    this.stateManager.setAvailableRoutes(availableRoutes);

    if (useSystemFilter) {
      this.updateRouteSelectorFromState(availableRoutes);
      return;
    }

    if (this.routeSelectorUpdateCallback) {
      this.routeSelectorUpdateCallback(buildRouteOptions(selectorRoutes));
    }
  }

  /** Update route selector options from current system-filtered state. */
  private updateRouteSelectorFromState(routes: IRoute[]): void {
    if (!this.routeSelectorUpdateCallback) return;

    const state = this.getCurrentState();
    const filteredRoutes = routes.filter((r) => {
      if (r.system === 'PRT') return state.selectedSystems.prt;
      if (r.system === 'CMU') return state.selectedSystems.cmu;
      return false;
    });

    const routeOptions = buildRouteOptions(filteredRoutes);
    this.routeSelectorUpdateCallback(routeOptions);
  }

  /**
   * Initialize - load all transit data from the bulk endpoint in one call
   */
  async initialize(renderInitial = true): Promise<void> {
    try {
      console.log('Fetching bulk transit data from backend...');
      const routes = await this.resolveInitialRoutes();
      this.publishInitializedRoutes(routes);
      this.transitRecoveryPending = !this.bulkLoaded;
      if (this.transitRecoveryPending) this.showTransitLoadingBanner();

      // Render initial routes based on default filters (Rule R2: PRT ON, CMU OFF)
      if (renderInitial) await this.renderFilteredRoutes();

      // Start polling service health status every 60 seconds
      this.startHealthPolling();

      this.logInitializeSummary(routes.length);
    } catch (error) {
      console.error('Failed to initialize filter controller:', error);
      throw error;
    }
  }

  /**
   * Resolve initial route list from bulk data, hydrating CMU routes when required.
   */
  private async resolveInitialRoutes(): Promise<IRoute[]> {
    const routesFromBulk = await this.fetchBulkData();
    return this.hydrateRoutesForRestoredContext(routesFromBulk);
  }

  /**
   * Return true when restored UI state requires full CMU route metadata.
   */
  private shouldHydrateCMURoutes(routes: IRoute[]): boolean {
    if (routes.some((route) => route.system === 'CMU')) {
      return false;
    }

    const restoredState = this.getCurrentState();
    return (
      restoredState.selectedSystems.cmu ||
      (!!restoredState.selectedRouteId &&
        restoredState.selectedRouteId.startsWith('CMU-'))
    );
  }

  /**
   * Hydrate full routes when restored state references CMU before prefetch occurs.
   */
  private async hydrateRoutesForRestoredContext(
    routes: IRoute[]
  ): Promise<IRoute[]> {
    if (!this.shouldHydrateCMURoutes(routes)) {
      return routes;
    }

    const allRoutes = await this.fetchAllRoutes();
    if (allRoutes.length === 0) {
      return routes;
    }

    console.log(
      'Restored CMU route context detected - initialized with full route list'
    );
    return allRoutes;
  }

  /**
   * Persist route cache/state and refresh selector options for initialization.
   */
  private publishInitializedRoutes(routes: IRoute[]): void {
    routes.forEach((route) => this.routeColorCache.set(route.id, route.color));
    this.publishAvailableRoutes(routes);
  }

  /**
   * Log standardized initialization summary.
   */
  private logInitializeSummary(routeCount: number): void {
    console.log(
      'Filter controller initialized with',
      routeCount,
      'routes (bulk)'
    );
  }

  /**
   * Fetch all available routes from backend
   */
  private async fetchAllRoutes(signal?: AbortSignal): Promise<IRoute[]> {
    return signal
      ? transitApiService.getRoutes(signal)
      : transitApiService.getRoutes();
  }

  /**
   * Fetch all transit data (routes, patterns, stops) in a single call.
   * Populates local patternCache and stopCache so subsequent render
   * operations never need additional network requests for static data.
   */
  private async fetchBulkData(
    isCurrent: () => boolean = () => true,
    signal?: AbortSignal
  ): Promise<IRoute[]> {
    const bulk = await transitApiService.getBulkData(signal);
    if (!isCurrent()) return [];
    if (!bulk) {
      console.warn('Bulk endpoint failed, falling back to /transit/routes');
      return this.fetchAllRoutes(signal);
    }

    // Populate local caches
    this.patternCache.clear();
    this.stopCache.clear();
    for (const [routeId, patterns] of Object.entries(bulk.patterns)) {
      this.patternCache.set(routeId, patterns);
    }
    for (const [key, stops] of Object.entries(bulk.stops)) {
      this.stopCache.set(key, stops);
    }
    this.bulkLoaded = bulk.routes.some((route) => route.system === 'PRT');
    console.log(
      `Bulk data loaded: ${bulk.routes.length} routes, ` +
        `${this.patternCache.size} pattern sets, ` +
        `${this.stopCache.size} stop sets`
    );
    return bulk.routes;
  }

  /**
   * Apply system filter (PRT/CMU toggle)
   */
  async applySystemFilter(): Promise<void> {
    const state = this.getCurrentState();

    if (this.handleAllSystemsDisabled(state.selectedSystems)) {
      this.stateManager.reapplyFilters();
      this.updateRouteSelectorFromState(state.availableRoutes);
      this.syncURLWithCurrentState();
      return;
    }

    this.clearSelectedRouteIfSystemDisabled(state);
    await this.prefetchRoutesForEnabledSystems(
      state.availableRoutes,
      state.selectedSystems
    );

    // Re-apply all filters
    this.stateManager.reapplyFilters();

    const updatedState = this.getCurrentState();
    this.updateRouteSelectorFromState(updatedState.availableRoutes);

    await this.renderFilteredRoutes();
    await this.restoreMapContentAfterSystemFilter();

    this.syncURLWithCurrentState();
  }

  /**
   * A8: both systems disabled means we show only the base map.
   */
  private handleAllSystemsDisabled(selectedSystems: {
    prt: boolean;
    cmu: boolean;
  }): boolean {
    if (selectedSystems.prt || selectedSystems.cmu) {
      return false;
    }

    this.routeRenderer.clearAllRoutes();
    this.vehicleTracker.stopPolling();
    console.log('All systems disabled - showing base map only');
    return true;
  }

  /**
   * Return true when the selected route belongs to a disabled system.
   */
  private isRouteSystemDisabled(
    route: IRoute,
    selectedSystems: { prt: boolean; cmu: boolean }
  ): boolean {
    return (
      (route.system === 'PRT' && !selectedSystems.prt) ||
      (route.system === 'CMU' && !selectedSystems.cmu)
    );
  }

  /**
   * Clear an invalid route selection if a system toggle disables its route.
   */
  private clearSelectedRouteIfSystemDisabled(state: {
    selectedRouteId: string | null;
    selectedSystems: { prt: boolean; cmu: boolean };
    availableRoutes: IRoute[];
  }): void {
    if (!state.selectedRouteId) return;

    const selectedRoute = state.availableRoutes.find(
      (route) => route.id === state.selectedRouteId
    );
    if (!selectedRoute) return;
    if (!this.isRouteSystemDisabled(selectedRoute, state.selectedSystems)) {
      return;
    }

    console.log(
      `Clearing route ${state.selectedRouteId} - system ${selectedRoute.system} is disabled`
    );
    this.routeRenderer.clearRoutePolylines(state.selectedRouteId);
    this.routeRenderer.clearStopMarkers(`${state.selectedRouteId}_INBOUND`);
    this.routeRenderer.clearStopMarkers(`${state.selectedRouteId}_OUTBOUND`);
    this.vehicleTracker.stopPolling();
    this.stateManager.updateFilter('selectedRouteId', null);
  }

  /**
   * Prefetch routes when newly-enabled systems need metadata not in memory.
   */
  private async prefetchRoutesForEnabledSystems(
    availableRoutes: IRoute[],
    selectedSystems: { prt: boolean; cmu: boolean }
  ): Promise<void> {
    const hasCMURoutes = availableRoutes.some(
      (route) => route.system === 'CMU'
    );

    if (selectedSystems.cmu && !hasCMURoutes) {
      console.log('CMU system enabled - prefetching CMU routes...');
      await this.prefetchRoutes();
    }
  }

  /**
   * Restore the correct post-filter map content (selected route or nearby stops).
   */
  private async restoreMapContentAfterSystemFilter(): Promise<void> {
    const postRenderState = this.getCurrentState();

    // If a route is still selected after system filter, re-render it fully (geometry + stops)
    if (postRenderState.selectedRouteId) {
      await this.applyRouteFilter(postRenderState.selectedRouteId);
      return;
    }

    // Re-render nearby stops filtered to the newly enabled systems (TUC4).
    // Use userLocation (not nearbyStopsActive) because showNearbyStops sets the flag
    // to false when it returns empty (e.g. CMU-only mode before CMU stops load),
    // which would prevent subsequent toggles from re-fetching.
    if (this.userLocation) {
      await this.showNearbyStops(this.userLocation);
    }
  }

  /**
   * Prefetch routes for newly enabled systems.
   * Always uses the /transit/routes endpoint so that CMU routes (which are
   * absent from the bulk/GTFS payload) are included alongside PRT routes.
   */
  private async prefetchRoutes(): Promise<void> {
    try {
      const routes = await this.fetchAllRoutes();
      routes.forEach((r) => this.routeColorCache.set(r.id, r.color));
      this.publishAvailableRoutes(routes);

      console.log(
        'Routes prefetched successfully:',
        routes.length,
        'total routes'
      );
    } catch (error) {
      console.error('Failed to prefetch routes:', error);
    }
  }

  /**
   * Ensure route metadata exists in state (useful after back-navigation when
   * URL state restores a CMU route before CMU routes have been prefetched).
   */
  private async ensureRouteAvailable(
    routeId: string,
    isCurrent: () => boolean
  ): Promise<IRoute | null> {
    let state = this.getCurrentState();
    let route = this.findAvailableRoute(routeId, state);
    if (route) return route;

    const routes = await this.fetchAllRoutes();
    if (!isCurrent() || routes.length === 0) {
      return null;
    }

    routes.forEach((r) => this.routeColorCache.set(r.id, r.color));
    this.publishAvailableRoutes(routes);

    state = this.getCurrentState();
    route = this.findAvailableRoute(routeId, state);
    return route ?? null;
  }

  /**
   * Apply route filter (single route selection - Rule R1)
   */
  async applyRouteFilter(
    routeId: string,
    isCurrent: () => boolean = () => true
  ): Promise<boolean> {
    if (!isCurrent()) return false;
    try {
      console.log('Applying route filter:', routeId);

      const selectedRoute = await this.ensureRouteAvailable(routeId, isCurrent);
      if (!isCurrent()) return false;
      this.prepareMapForRouteSelection();

      await this.renderRouteGeometryForSelection(
        routeId,
        selectedRoute,
        isCurrent
      );
      if (!isCurrent()) return false;
      const stopsLoaded = await this.renderRouteStopsForSelection(
        routeId,
        selectedRoute,
        isCurrent
      );
      if (!isCurrent() || !stopsLoaded) return false;

      await this.fetchAndShowDetours(routeId, isCurrent);
      if (!isCurrent()) return false;
      this.startVehiclePollingForSelectedRoute(routeId);

      this.syncURLWithCurrentState();
      return true;
    } catch (error) {
      console.error('Error applying route filter:', error);
      return false;
    }
  }

  /**
   * Reset map artifacts before rendering a selected route.
   */
  private prepareMapForRouteSelection(): void {
    // TUC4: Clear nearby stop markers when a specific route is selected
    this.clearNearbyStops();

    // Clear all existing routes before drawing the selected route
    this.routeRenderer.clearAllRoutes();
    this.vehicleTracker.stopPolling();
  }

  /**
   * Resolve route color from selected metadata, cache, or fallback.
   */
  private resolveRouteColor(routeId: string, route: IRoute | null): string {
    return (
      route?.color ||
      this.routeColorCache.get(routeId) ||
      this.getFallbackRouteColor(routeId)
    );
  }

  /**
   * Fetch and render selected-route geometry, fitting map bounds when available.
   */
  private async renderRouteGeometryForSelection(
    routeId: string,
    selectedRoute: IRoute | null,
    isCurrent: () => boolean
  ): Promise<void> {
    const geometry = await this.fetchRouteGeometry(routeId);
    if (!isCurrent()) return;
    if (!geometry) {
      console.error('Failed to fetch geometry for route', routeId);
      // Continue anyway to show stops and vehicles
      return;
    }

    const color = this.resolveRouteColor(routeId, selectedRoute);
    this.routeRenderer.renderRouteGeometry(routeId, geometry, color);
    this.routeRenderer.fitToRouteData(geometry);
  }

  /**
   * Return default direction availability when route metadata is missing.
   */
  private getFallbackDirectionsForRoute(routeId: string): string[] {
    return routeId.startsWith('CMU-') ? ['OUTBOUND'] : ['INBOUND', 'OUTBOUND'];
  }

  /**
   * Render stop markers for the selected route (or fallback direction set).
   */
  private async renderRouteStopsForSelection(
    routeId: string,
    selectedRoute: IRoute | null,
    isCurrent: () => boolean
  ): Promise<boolean> {
    if (selectedRoute) {
      return this.applyDirectionFilter(isCurrent);
    }

    const state = this.getCurrentState();
    const enabledDirections = this.getEnabledDirections(
      state.selectedDirections,
      this.getFallbackDirectionsForRoute(routeId)
    );
    await this.refreshStopMarkers(routeId, enabledDirections, isCurrent);
    return isCurrent();
  }

  /**
   * Start selected-route vehicle polling using cache-aware color resolution.
   */
  private startVehiclePollingForSelectedRoute(routeId: string): void {
    // Keep vehicle tint consistent with selected route polyline.
    const state = this.getCurrentState();
    const route = this.findAvailableRoute(routeId, state);
    const color = this.resolveRouteColor(routeId, route ?? null);
    this.vehicleTracker.startPolling(routeId, color);
  }

  /**
   * Fetch detours for the given route and display a banner if any are active.
   */
  private async fetchAndShowDetours(
    routeId: string,
    isCurrent: () => boolean
  ): Promise<void> {
    try {
      const geometryDetours =
        await transitApiService.getDetourGeometry(routeId);
      if (!isCurrent()) return;
      this.routeRenderer.clearDetourPolylines(routeId);
      if (geometryDetours.some((d) => (d.geometry?.length ?? 0) > 0)) {
        this.routeRenderer.renderDetourGeometry(routeId, geometryDetours);
      }
    } catch (error) {
      console.error('Error fetching detours:', error);
      if (isCurrent()) this.routeRenderer.clearDetourPolylines(routeId);
    }
  }

  /**
   * Clear the active route filter and re-render all filtered routes
   */
  async clearRouteFilter(): Promise<void> {
    this.stateManager.updateFilter('selectedRouteId', null);
    this.vehicleTracker.stopPolling();
    this.routeRenderer.clearAllRoutes();
    await this.renderFilteredRoutes();
    this.syncURLWithCurrentState();
  }

  /**
   * Apply date/time filter
   */
  async applyDateTimeFilter(
    isCurrent: () => boolean = () => true
  ): Promise<boolean> {
    if (!isCurrent()) return false;
    const state = this.getCurrentState();
    const selection = this.resolveDateTimeSelection(state);
    if (!selection) return false;

    try {
      console.log('Applying date/time filter', {
        date: selection.dateToUse,
        time: selection.selectedTime
      });

      // Call backend to get available routes for this date/time
      const availableRoutes = await this.fetchAvailableRoutes(
        selection.dateToUse,
        selection.selectedTime
      );
      if (!isCurrent() || !availableRoutes) return false;

      // A7: No Service Available
      if (availableRoutes.length === 0) {
        this.handleNoServiceAvailableForDateTimeFilter();
        return true;
      }

      this.applyDateTimeFilteredRoutes(availableRoutes);
      const rendered = await this.rerenderAfterDateTimeFilter(
        state.selectedRouteId,
        isCurrent
      );
      if (!isCurrent() || !rendered) return false;

      // Update URL with latest state
      this.syncURLWithCurrentState();
      return true;
    } catch (error) {
      console.error('Error applying date/time filter:', error);
      return false;
    }
  }

  /**
   * Resolve selected date/time context for date-time filtering.
   */
  private resolveDateTimeSelection(state: {
    selectedDate: Date | null;
    selectedTime: ISelectedTime | null;
  }): {
    dateToUse: Date;
    selectedTime: ISelectedTime;
  } | null {
    // If neither date nor time is selected, nothing to do
    if (!state.selectedDate && !state.selectedTime) {
      console.log('Date and time not selected');
      return null;
    }

    // If only date is selected without time, we can't filter properly
    if (!state.selectedTime) {
      console.log('Time not selected, cannot apply time-based filter');
      return null;
    }

    return {
      dateToUse: state.selectedDate || new Date(),
      selectedTime: state.selectedTime
    };
  }

  /**
   * Show A7 no-service state and modal fallback messaging.
   */
  private handleNoServiceAvailableForDateTimeFilter(): void {
    this.routeRenderer.clearAllRoutes();
    this.vehicleTracker.stopPolling();
    console.log('A7: No service available for this selection');

    // Use modal instead of alert
    const showModal = window.showModal;
    if (showModal && typeof showModal === 'function') {
      showModal(
        'No Service Available',
        'No service available for this selection.'
      );
    } else {
      console.error('showModal function not available');
      alert('No service available for this selection.');
    }
  }

  /**
   * Apply route-state updates from date-time filtered route results.
   */
  private applyDateTimeFilteredRoutes(availableRoutes: IRoute[]): void {
    // Preserve route colors from TrueTime (GTFS routes.txt uses FFFFFF for most PRT routes)
    const routesWithColors = availableRoutes.map((route) => ({
      ...route,
      color: this.routeColorCache.get(route.id) ?? route.color
    }));

    this.publishAvailableRoutes(routesWithColors, availableRoutes, false);
  }

  /**
   * Re-render either selected-route view or current filtered-route set.
   */
  private async rerenderAfterDateTimeFilter(
    selectedRouteId: string | null,
    isCurrent: () => boolean = () => true
  ): Promise<boolean> {
    if (selectedRouteId) {
      return this.applyRouteFilter(selectedRouteId, isCurrent);
    }

    return this.renderFilteredRoutes(isCurrent);
  }

  /**
   * Return directions that are both available for the route and enabled in the toggle.
   * Routes that only expose one direction (e.g. CMU loop shuttles with OUTBOUND only)
   * are exempt from the toggle — their sole direction is always included so the
   * inbound/outbound filter never hides a route that has no concept of direction.
   */
  private getEnabledDirections(
    selectedDirections: { inbound: boolean; outbound: boolean },
    routeDirections: string[]
  ): string[] {
    const hasInbound = routeDirections.includes('INBOUND');
    const hasOutbound = routeDirections.includes('OUTBOUND');
    const isBidirectional = hasInbound && hasOutbound;

    const directions: string[] = [];
    if (hasInbound && (isBidirectional ? selectedDirections.inbound : true)) {
      directions.push('INBOUND');
    }
    if (hasOutbound && (isBidirectional ? selectedDirections.outbound : true)) {
      directions.push('OUTBOUND');
    }
    return directions;
  }

  /**
   * Show or hide polylines for each direction based on toggle state.
   * Single-direction routes (e.g. CMU loop shuttles) are always shown —
   * the inbound/outbound toggle only applies to bidirectional routes.
   */
  private updateDirectionVisibility(
    routeId: string,
    routeDirections: string[],
    selectedDirections: { inbound: boolean; outbound: boolean }
  ): void {
    const isBidirectional =
      routeDirections.includes('INBOUND') &&
      routeDirections.includes('OUTBOUND');

    for (const dir of ['INBOUND', 'OUTBOUND'] as const) {
      if (!routeDirections.includes(dir)) continue;
      const enabled =
        !isBidirectional ||
        (dir === 'INBOUND'
          ? selectedDirections.inbound
          : selectedDirections.outbound);
      if (enabled) {
        this.routeRenderer.showDirectionPolylines(routeId, dir);
      } else {
        this.routeRenderer.hideDirectionPolylines(routeId, dir);
      }
    }
  }

  /**
   * Clear stop markers for both directions then re-render markers for enabled directions.
   */
  private async refreshStopMarkers(
    routeId: string,
    directions: string[],
    isCurrent: () => boolean
  ): Promise<void> {
    if (!isCurrent()) return;
    this.clearDirectionalStopMarkers(routeId);

    for (const direction of directions) {
      const shouldContinue = await this.renderDirectionStopMarkers(
        routeId,
        direction,
        isCurrent
      );
      if (!isCurrent() || !shouldContinue) {
        return;
      }
    }
  }

  /**
   * Clear direction-specific stop markers before re-rendering.
   */
  private clearDirectionalStopMarkers(routeId: string): void {
    this.routeRenderer.clearStopMarkers(`${routeId}_INBOUND`);
    this.routeRenderer.clearStopMarkers(`${routeId}_OUTBOUND`);
  }

  /**
   * Render stop markers for one direction, aborting if selection changed mid-fetch.
   */
  private async renderDirectionStopMarkers(
    routeId: string,
    direction: string,
    isCurrent: () => boolean
  ): Promise<boolean> {
    const stops = await this.fetchStops(routeId, direction);

    // Guard against deselection that may have occurred during the async fetch
    if (!isCurrent() || this.getCurrentState().selectedRouteId !== routeId) {
      return false;
    }

    if (stops.length > 0) {
      this.routeRenderer.renderStopMarkers(routeId, stops, direction, (stop) =>
        PredictionController.getInstance().handleStopClick(stop)
      );
    }

    return true;
  }

  /**
   * Apply direction filter
   */
  async applyDirectionFilter(
    isCurrent: () => boolean = () => true
  ): Promise<boolean> {
    if (!isCurrent()) return false;
    const state = this.getCurrentState();

    if (!state.selectedRouteId) {
      console.log('No route selected for direction filter');
      return false;
    }

    try {
      const selectedRoute = this.findAvailableRoute(
        state.selectedRouteId,
        state
      );
      if (!selectedRoute) {
        console.error('Selected route not found in available routes');
        return false;
      }

      const routeId = state.selectedRouteId;

      const directions = this.getEnabledDirections(
        state.selectedDirections,
        selectedRoute.directions
      );

      await this.applyDirectionStateToRoute(
        routeId,
        selectedRoute.directions,
        state.selectedDirections,
        directions,
        isCurrent
      );

      if (!isCurrent()) return false;
      this.vehicleTracker.refreshDirectionVisibility();

      this.syncURLWithCurrentState();
      return true;
    } catch (error) {
      console.error('Error applying direction filter:', error);
      return false;
    }
  }

  /**
   * Apply direction-visibility + stop-marker updates for one route.
   */
  private async applyDirectionStateToRoute(
    routeId: string,
    routeDirections: string[],
    selectedDirections: { inbound: boolean; outbound: boolean },
    directionsToRender: string[],
    isCurrent: () => boolean
  ): Promise<void> {
    this.updateDirectionVisibility(
      routeId,
      routeDirections,
      selectedDirections
    );
    await this.refreshStopMarkers(routeId, directionsToRender, isCurrent);
  }

  /**
   * Render routes based on current filter state
   */
  private async renderFilteredRoutes(
    isCurrent: () => boolean = () => true
  ): Promise<boolean> {
    if (!isCurrent()) return false;
    const state = this.getCurrentState();
    const routesToRender = state.filteredRoutes;

    console.log(`Rendering ${routesToRender.length} filtered routes`);

    const visibleRouteIds = new Set(routesToRender.map((r) => r.id));
    this.clearRoutesOutsideFilteredSet(state.availableRoutes, visibleRouteIds);

    let rendered = true;
    for (const route of routesToRender) {
      if (!isCurrent()) return false;
      if (!(await this.renderFilteredRoute(route, isCurrent))) rendered = false;
    }
    return rendered && isCurrent();
  }

  /**
   * Clear polylines/stops for routes outside the currently-visible set.
   */
  private clearRoutesOutsideFilteredSet(
    allKnownRoutes: IRoute[],
    visibleRouteIds: Set<string>
  ): void {
    for (const route of allKnownRoutes) {
      if (!visibleRouteIds.has(route.id)) {
        this.routeRenderer.clearRoutePolylines(route.id);
        this.routeRenderer.clearStopMarkers(`${route.id}_INBOUND`);
        this.routeRenderer.clearStopMarkers(`${route.id}_OUTBOUND`);
      }
    }
  }

  /**
   * Fetch and render route geometry for one filtered route.
   */
  private async renderFilteredRoute(
    route: IRoute,
    isCurrent: () => boolean = () => true
  ): Promise<boolean> {
    try {
      if (this.routeRenderer.hasRouteGeometry(route.id)) {
        console.log(
          `Route ${route.id} already has geometry, showing existing polylines`
        );
        return true;
      }

      const geometry = await this.fetchRouteGeometry(route.id);
      if (!isCurrent()) return false;
      if (geometry) {
        this.routeRenderer.renderRouteGeometry(route.id, geometry, route.color);
      } else {
        console.warn(`No geometry data available for route ${route.id}`);
      }
      return true;
    } catch (error: unknown) {
      if (this.isMissingRouteGeometryError(error)) {
        console.debug(
          `Route ${route.id} geometry not available - skipping render`
        );
      } else {
        console.error(`Failed to render route ${route.id}:`, error);
      }
      return false;
    }
  }

  /**
   * Return true for expected missing-geometry errors (404 / client error).
   */
  private isMissingRouteGeometryError(error: unknown): boolean {
    const err = error as Record<string, unknown>;
    const response = err?.response as Record<string, unknown> | undefined;
    return response?.status === 404 || err?.type === 'ClientError';
  }

  /**
   * Fetch route geometry — uses local cache from bulk data when available,
   * otherwise falls back to the per-route API call.
   */
  private async fetchRouteGeometry(routeId: string): Promise<RouteData | null> {
    // Try local pattern cache first (populated by fetchBulkData)
    if (this.bulkLoaded && this.patternCache.has(routeId)) {
      console.log(`Route ${routeId} geometry served from local cache`);
      return this.patternCache.get(routeId) as unknown as RouteData;
    }

    // PRT routes not found in the bulk payload genuinely have no geometry.
    // CMU routes are never in the bulk payload (lazy-loaded), so always fall
    // through to the per-route API call for them.
    if (this.bulkLoaded && !routeId.startsWith('CMU-')) {
      console.debug(`Route ${routeId} has no geometry in bulk data — skipping`);
      return null;
    }

    const patterns = await transitApiService.getPatterns(routeId);
    if (patterns === null) {
      // Route has no geometry data - throw so caller can handle gracefully
      throw { type: 'ClientError', name: 'RouteNotFound' };
    }
    return patterns as unknown as RouteData;
  }

  /**
   * Fetch available routes for a specific date/time
   */
  private async fetchAvailableRoutes(
    date: Date,
    time: ISelectedTime
  ): Promise<IRoute[] | null> {
    try {
      // Convert date to YYYY-MM-DD format
      const dateStr = date.toISOString().split('T')[0];

      // Convert time object to HH:MM 24-hour format
      let hour24 = time.hour;
      if (time.period === 'PM' && time.hour !== 12) {
        hour24 = time.hour + 12;
      } else if (time.period === 'AM' && time.hour === 12) {
        hour24 = 0;
      }
      const timeStr = `${hour24.toString().padStart(2, '0')}:${time.minute.toString().padStart(2, '0')}`;

      console.log('Fetching routes for:', { date: dateStr, time: timeStr });
      return transitApiService.filterRoutesByDateTime(dateStr, timeStr);
    } catch (error) {
      console.error('Error fetching available routes:', error);
      return null;
    }
  }

  /**
   * Fetch stops for a specific route and direction — uses local cache from
   * bulk data when available, otherwise falls back to the per-route API call.
   */
  private async fetchStops(
    routeId: string,
    direction: string
  ): Promise<IStop[]> {
    // Try local stop cache first (populated by fetchBulkData)
    const cacheKey = `${routeId}:${direction}`;
    if (this.bulkLoaded && this.stopCache.has(cacheKey)) {
      console.log(`Stops for ${cacheKey} served from local cache`);
      return this.stopCache.get(cacheKey) || [];
    }

    const stops = await transitApiService.getStops(routeId, direction);
    if (!stops) throw new Error('Unable to load route stops');
    return stops;
  }

  /**
   * Public helper for map search stop selections.
   * Delegates to PredictionController which owns the popup lifecycle.
   */
  async showStopDetailsFromSearch(stop: IStop): Promise<void> {
    await PredictionController.getInstance().handleStopClick(stop);
  }

  // -------------------------------------------------------------------
  // Route Info Popup
  // -------------------------------------------------------------------

  /**
   * Show the Route Info popup for the selected route.
   * Fetches schedule, alerts, and detours from the backend.
   */
  async showRouteInfoPopup(
    routeId: string,
    isCurrent: () => boolean = () => true
  ): Promise<void> {
    if (!isCurrent()) return;
    prepareForNewPopup('route');

    const { routeName, routeColor } = this.getRouteInfoContext(routeId);
    const { popup, body } = this.createRouteInfoPopupShell(
      routeName,
      routeColor,
      routeId
    );

    this.attachRouteInfoPopup(popup);
    this.bindRouteInfoMinimize(popup, routeId, routeName, routeColor);
    this.pendingRouteBody = body;

    try {
      await this.loadRouteInfoBody(
        body,
        popup,
        routeId,
        routeName,
        routeColor,
        isCurrent
      );
    } finally {
      if (this.pendingRouteBody === body) this.pendingRouteBody = null;
    }
  }

  /**
   * Resolve route name and color for route-info popup rendering.
   */
  private getRouteInfoContext(routeId: string): {
    routeName: string;
    routeColor: string;
  } {
    const state = this.getCurrentState();
    const route = this.findAvailableRoute(routeId, state);
    const routeName = route?.name || routeId;
    const routeColor = this.resolveRouteColor(routeId, route ?? null);

    return { routeName, routeColor };
  }

  /**
   * Build route-info popup shell with header + loading body.
   */
  private createRouteInfoPopupShell(
    routeName: string,
    routeColor: string,
    routeId: string
  ): {
    popup: HTMLElement;
    body: HTMLElement;
  } {
    const popup = document.createElement('div');
    popup.id = MAP_POPUP_ID;
    popup.className = 'map-popup';

    popup.appendChild(
      this.createRouteInfoHeader(routeName, routeColor, routeId)
    );

    const body = this.createRouteInfoBody();
    popup.appendChild(body);

    return { popup, body };
  }

  /**
   * Build popup header section (icon, title, minimize control).
   */
  private createRouteInfoHeader(
    routeName: string,
    routeColor: string,
    routeId: string
  ): HTMLElement {
    const header = document.createElement('div');
    header.className = 'map-popup__header';

    const icon = document.createElement('span');
    icon.className =
      'material-icons-outlined map-popup__icon map-popup__icon--route';
    icon.style.color = routeColor;
    icon.textContent = 'route';

    const title = document.createElement('strong');
    title.className = 'map-popup__title';
    title.textContent = routeName;

    const subscribeBtn = this.createRouteSubscribeButton(routeId);

    const minimizeButton = document.createElement('button');
    minimizeButton.className = 'map-popup__minimize';
    minimizeButton.setAttribute('aria-label', 'Minimize');
    minimizeButton.innerHTML = '&minus;';

    const closeButton = document.createElement('button');
    closeButton.className = 'map-popup__close';
    closeButton.setAttribute('aria-label', 'Close');
    closeButton.innerHTML = '&times;';

    header.appendChild(icon);
    header.appendChild(title);
    header.appendChild(subscribeBtn);
    const headerSpacer = document.createElement('span');
    headerSpacer.className = 'map-popup__header-spacer';
    header.appendChild(headerSpacer);
    header.appendChild(minimizeButton);
    header.appendChild(closeButton);

    return header;
  }

  /**
   * Create a subscribe bell button for the route info popup header.
   */
  private createRouteSubscribeButton(routeId: string): HTMLButtonElement {
    const authService = AuthService.getInstance();
    const isSubscribed = authService.isRouteSubscribed(routeId);

    const btn = document.createElement('button');
    btn.className = 'map-popup__subscribe';
    if (isSubscribed) btn.classList.add('map-popup__subscribe--active');
    btn.setAttribute(
      'aria-label',
      isSubscribed ? 'Unsubscribe from route' : 'Subscribe to route'
    );
    btn.title = isSubscribed ? 'Unsubscribe from route' : 'Subscribe to route';

    const bellIcon = document.createElement('span');
    bellIcon.className = 'material-icons-outlined map-popup__subscribe-icon';
    bellIcon.textContent = isSubscribed
      ? 'notifications'
      : 'notifications_none';
    btn.appendChild(bellIcon);

    const label = document.createElement('span');
    label.className = 'map-popup__subscribe-label';
    label.textContent = isSubscribed ? 'Subscribed' : 'Subscribe';
    btn.appendChild(label);

    btn.addEventListener('click', () => {
      const currentlySubscribed = btn.classList.contains(
        'map-popup__subscribe--active'
      );
      const eventName = currentlySubscribed
        ? 'bellUnsubscribe'
        : 'bellSubscribe';

      btn.classList.toggle('map-popup__subscribe--active');
      const icon = btn.querySelector('.map-popup__subscribe-icon');
      const lbl = btn.querySelector('.map-popup__subscribe-label');
      const nowSubscribed = btn.classList.contains(
        'map-popup__subscribe--active'
      );
      if (icon)
        icon.textContent = nowSubscribed
          ? 'notifications'
          : 'notifications_none';
      if (lbl) lbl.textContent = nowSubscribed ? 'Subscribed' : 'Subscribe';
      btn.title = nowSubscribed
        ? 'Unsubscribe from route'
        : 'Subscribe to route';
      btn.setAttribute('aria-label', btn.title);

      document.dispatchEvent(
        new CustomEvent(eventName, {
          detail: { routeId },
          bubbles: true
        })
      );
    });

    return btn;
  }

  /**
   * Build popup body section in loading state.
   */
  private createRouteInfoBody(): HTMLElement {
    const body = document.createElement('div');
    body.className = 'map-popup__body';
    this.renderRouteInfoLoadingState(body);
    return body;
  }

  /**
   * Attach route-info popup to map container.
   */
  private attachRouteInfoPopup(popup: HTMLElement): void {
    const container = document.querySelector('.map-container');
    if (container) {
      container.appendChild(popup);
    }
  }

  /**
   * Render loading text while schedule data is being fetched.
   */
  private renderRouteInfoLoadingState(body: HTMLElement): void {
    body.innerHTML = '';
    const loading = document.createElement('div');
    loading.className = 'map-popup__loading';
    loading.textContent = 'Loading schedule...';
    body.appendChild(loading);
  }

  /**
   * Render empty/error state text for route-info body.
   */
  private renderRouteInfoMessage(body: HTMLElement, message: string): void {
    body.innerHTML = '';
    const messageNode = document.createElement('div');
    messageNode.className = 'map-popup__empty';
    messageNode.textContent = message;
    body.appendChild(messageNode);
  }

  /**
   * Fetch route schedule and render the route-info body.
   */
  private async loadRouteInfoBody(
    body: HTMLElement,
    popup: HTMLElement,
    routeId: string,
    routeName: string,
    routeColor: string,
    isCurrent: () => boolean
  ): Promise<void> {
    try {
      const schedule = await transitApiService.getRouteSchedule(routeId);
      if (!isCurrent() || !popup.isConnected) return;
      if (!schedule) {
        this.renderRouteInfoMessage(body, 'Schedule not available');
        return;
      }

      this.renderRouteInfoBody(body, schedule, routeColor);

      // Re-bind minimize after body replaced
      this.bindRouteInfoMinimize(popup, routeId, routeName, routeColor);
    } catch (err) {
      if (!isCurrent() || !popup.isConnected) return;
      console.error('Error fetching route schedule:', err);
      this.renderRouteInfoMessage(body, 'Failed to load schedule');
    }
  }

  /**
   * Render the route info popup body content.
   */
  private renderRouteInfoBody(
    body: HTMLElement,
    schedule: IRouteSchedule,
    routeColor: string
  ): void {
    const sections = [
      this.buildRouteInfoOperatingDaysSection(
        schedule.operatingDays,
        routeColor
      )
    ];

    if (schedule.directions.length > 0) {
      sections.push(this.buildRouteInfoHoursSection(schedule));
    }
    if (schedule.alerts.length > 0) {
      sections.push(this.buildRouteInfoAlertsSection(schedule));
    }
    if (schedule.detours.length > 0) {
      sections.push(this.buildRouteInfoDetoursSection(schedule));
    }

    body.innerHTML = sections.join('');
  }

  /**
   * Build operating-day pills for the route-info popup.
   */
  private buildRouteInfoOperatingDaysSection(
    operatingDays: number[],
    routeColor: string
  ): string {
    const dayMarkup = FilterController.DAY_NAMES.map((dayName, dayIndex) => {
      const isActive = operatingDays.includes(dayIndex);
      const activeClass = isActive ? ' route-info__day--active' : '';
      const activeStyle = isActive
        ? ` style="background:${routeColor};color:#fff"`
        : '';
      return `<span class="route-info__day${activeClass}"${activeStyle}>${dayName}</span>`;
    }).join('');

    return [
      '<div class="route-info__section">',
      `<div class="route-info__days">${dayMarkup}</div>`,
      '</div>'
    ].join('');
  }

  /**
   * Build service-hour section for each route direction.
   */
  private buildRouteInfoHoursSection(schedule: IRouteSchedule): string {
    const hoursMarkup = schedule.directions
      .map((directionSchedule) => {
        const direction = this.escapeHtml(directionSchedule.direction);
        const firstTrip = this.escapeHtml(directionSchedule.firstTrip);
        const lastTrip = this.escapeHtml(directionSchedule.lastTrip);
        const rawHeadsign = directionSchedule.headsign ?? '';
        const destination = rawHeadsign
          .replace(new RegExp(`^${directionSchedule.direction}-`, 'i'), '')
          .trim();
        const headsign = destination
          ? `<span class="route-info__headsign">${this.escapeHtml(destination)}</span>`
          : '';
        return [
          '<div class="route-info__hours">',
          `<div class="route-info__dir-row"><span class="route-info__dir">${direction}</span>${headsign}</div>`,
          `<span class="route-info__times">${firstTrip} &ndash; ${lastTrip}</span>`,
          '</div>'
        ].join('');
      })
      .join('');

    return [
      '<div class="route-info__section">',
      '<div class="route-info__label">Service Hours</div>',
      hoursMarkup,
      '</div>'
    ].join('');
  }

  /**
   * Build a generic labelled section for the route-info popup.
   */
  private buildRouteInfoSection(
    sectionModifier: string,
    iconName: string,
    label: string,
    itemsHtml: string[]
  ): string {
    return [
      `<div class="route-info__section route-info__section--${sectionModifier}">`,
      `<div class="route-info__label"><span class="material-icons-outlined" style="font-size:16px;vertical-align:text-bottom">${iconName}</span> ${label}</div>`,
      ...itemsHtml,
      '</div>'
    ].join('');
  }

  /**
   * Build active-alert section for the route-info popup.
   */
  private buildRouteInfoAlertsSection(schedule: IRouteSchedule): string {
    const items = schedule.alerts.map(
      (alert) =>
        `<div class="route-info__alert">${this.escapeHtml(alert.headerText)}</div>`
    );
    return this.buildRouteInfoSection(
      'alerts',
      'warning_amber',
      'Alerts',
      items
    );
  }

  /**
   * Build active-detour section for the route-info popup.
   */
  private buildRouteInfoDetoursSection(schedule: IRouteSchedule): string {
    const items = schedule.detours.map(
      (detour) =>
        `<div class="route-info__detour">${this.escapeHtml(detour.description)}</div>`
    );
    return this.buildRouteInfoSection('detours', 'alt_route', 'Detours', items);
  }

  /**
   * Escape interpolated route-info strings before injecting into HTML.
   */
  private escapeHtml(text: string): string {
    return text
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;');
  }

  /**
   * Bind the minimize button on the route info popup.
   */
  private bindRouteInfoMinimize(
    popup: HTMLElement,
    routeId: string,
    routeName: string,
    routeColor: string
  ): void {
    const minBtn = popup.querySelector('.map-popup__minimize');
    if (!minBtn) return;
    // Remove old listeners by cloning
    const fresh = minBtn.cloneNode(true);
    minBtn.replaceWith(fresh);
    const onRestore = () =>
      this.rebindRouteInfoPopupEvents(routeId, routeName, routeColor);
    fresh.addEventListener('click', () => {
      minimizePopup('route', routeName, onRestore, undefined, routeColor);
    });
    registerActivePopup('route', routeName, onRestore, undefined, routeColor);

    const closeBtn = popup.querySelector('.map-popup__close');
    if (closeBtn) {
      const freshClose = closeBtn.cloneNode(true);
      closeBtn.replaceWith(freshClose);
      freshClose.addEventListener('click', () => dismissPopup('route'));
    }
  }

  /**
   * Re-bind event listeners on the route info popup after restoring from a docked tab.
   */
  private rebindRouteInfoPopupEvents(
    routeId: string,
    routeName: string,
    routeColor: string
  ): void {
    const popup = document.getElementById(MAP_POPUP_ID);
    if (!popup) return;

    this.bindRouteInfoMinimize(popup, routeId, routeName, routeColor);
  }

  // -------------------------------------------------------------------
  // Nearby Stops Discovery  (TUC4 — Discover Stops & Schedules)
  // -------------------------------------------------------------------

  /**
   * Fetch nearby stops from the server and render them on the map.
   * Called once when the user's location is first obtained (TUC4 Step 2).
   * Stops are cleared automatically when a route is explicitly selected.
   */
  async showNearbyStops(
    position: ILatLng,
    isCurrent: () => boolean = () => true
  ): Promise<boolean> {
    if (!isCurrent()) return false;
    this.userLocation = position;

    // Don't show nearby stops if a route is already selected (TUC1 takes precedence)
    const state = this.getCurrentState();
    if (state.selectedRouteId) return false;

    this.clearRenderedNearbyStopsIfActive();
    if (!state.selectedSystems.prt && !state.selectedSystems.cmu) return true;

    // Derive system filter from the active toggles
    const system = this.getNearbySystemFilter(state.selectedSystems);

    try {
      const nearbyData = await this.fetchNearbyStops(
        position.lat,
        position.lng,
        system
      );
      if (!isCurrent() || !nearbyData) return false;
      if (nearbyData.stops.length === 0) return true;

      this.collectNearbyRouteIds(nearbyData.stops);

      this.hideRoutesWithoutNearbyStops(state.availableRoutes);

      await this.renderNearbyRouteGeometries(state.availableRoutes, isCurrent);
      if (!isCurrent()) return false;

      const stopsByRoute = this.groupNearbyStopsByRoute(nearbyData.stops);
      this.renderNearbyStopMarkers(stopsByRoute);

      this.nearbyStopsActive = true;

      this.logNearbyStopsSummary(nearbyData);
      return true;
    } catch (error) {
      console.error('[FilterController] Error showing nearby stops:', error);
      return false;
    }
  }

  /**
   * Clear stale nearby markers before (re-)rendering so system-filter changes don't stack.
   * Also restores routes that were hidden by the previous nearby-stops pass, so that if the
   * new location yields no stops (e.g. outside Pittsburgh) all routes become visible again.
   */
  private clearRenderedNearbyStopsIfActive(): void {
    if (!this.nearbyStopsActive) return;

    const routes = this.getCurrentState().availableRoutes;
    this.clearNearbyMarkersForRouteIds(this.nearbyRouteIds);
    this.restoreRoutesHiddenByNearbyStops(routes);
    this.resetNearbyStopsTracking();
  }

  /**
   * Clear nearby marker buckets for the provided route IDs.
   */
  private clearNearbyMarkersForRouteIds(routeIds: Iterable<string>): void {
    for (const routeId of routeIds) {
      this.routeRenderer.clearStopMarkers(`${routeId}_NEARBY`);
    }
    this.routeRenderer.clearStopMarkers('NEARBY_NEARBY');
  }

  /**
   * Reset nearby-stop tracking state flags.
   */
  private resetNearbyStopsTracking(): void {
    this.nearbyStopsActive = false;
    this.nearbyRouteIds.clear();
  }

  /**
   * Compute nearby-stop system filter from current system toggle state.
   */
  private getNearbySystemFilter(selectedSystems: {
    prt: boolean;
    cmu: boolean;
  }): string | undefined {
    const { prt, cmu } = selectedSystems;
    return prt && cmu ? undefined : prt ? 'PRT' : cmu ? 'CMU' : undefined;
  }

  /**
   * Collect unique route IDs that serve the returned nearby stops.
   */
  private collectNearbyRouteIds(stops: INearbyStop[]): void {
    this.nearbyRouteIds.clear();
    for (const nearbyStop of stops) {
      for (const routeId of nearbyStop.routesServingStop) {
        this.nearbyRouteIds.add(routeId);
      }
    }
  }

  /**
   * Hide routes that have no nearby stops (TUC4 Step 2).
   */
  private hideRoutesWithoutNearbyStops(routes: IRoute[]): void {
    for (const route of routes) {
      if (!this.nearbyRouteIds.has(route.id)) {
        this.routeRenderer.hideRoute(route.id);
      }
    }
  }

  /**
   * Render route geometry for nearby routes that are not currently rendered.
   */
  private async renderNearbyRouteGeometries(
    routes: IRoute[],
    isCurrent: () => boolean
  ): Promise<void> {
    for (const routeId of this.nearbyRouteIds) {
      if (!isCurrent()) return;
      await this.renderNearbyRouteGeometry(routeId, routes, isCurrent);
    }
  }

  /**
   * Render a nearby route's geometry, if available.
   */
  private async renderNearbyRouteGeometry(
    routeId: string,
    routes: IRoute[],
    isCurrent: () => boolean
  ): Promise<void> {
    if (this.routeRenderer.hasRouteGeometry(routeId)) {
      return;
    }

    try {
      const geometry = await this.fetchRouteGeometry(routeId);
      if (!isCurrent() || !geometry) {
        return;
      }

      const route = routes.find((r) => r.id === routeId);
      const color =
        route?.color ||
        this.routeColorCache.get(routeId) ||
        this.getFallbackRouteColor(routeId);
      this.routeRenderer.renderRouteGeometry(routeId, geometry, color);
    } catch (error: unknown) {
      // Nearby stops should still render even if one route has no geometry.
      const err = error as Record<string, unknown>;
      const response = err?.response as Record<string, unknown> | undefined;
      if (response?.status === 404 || err?.type === 'ClientError') {
        console.debug(
          `[FilterController] Nearby route geometry unavailable for ${routeId}; continuing with stops`
        );
      } else {
        console.error(
          `[FilterController] Failed to render nearby route geometry for ${routeId}:`,
          error
        );
      }
    }
  }

  /**
   * Group nearby stops by first serving route for marker-render keys.
   */
  private groupNearbyStopsByRoute(stops: INearbyStop[]): Map<string, IStop[]> {
    const stopsByRoute = new Map<string, IStop[]>();

    for (const nearbyStop of stops) {
      const routeKey = nearbyStop.routesServingStop[0] ?? 'NEARBY';
      const groupedStops = stopsByRoute.get(routeKey) || [];
      groupedStops.push(nearbyStop.stop);
      stopsByRoute.set(routeKey, groupedStops);
    }

    return stopsByRoute;
  }

  /**
   * Render grouped nearby stop markers.
   */
  private renderNearbyStopMarkers(stopsByRoute: Map<string, IStop[]>): void {
    for (const [routeKey, stops] of stopsByRoute.entries()) {
      this.routeRenderer.renderStopMarkers(routeKey, stops, 'NEARBY', (stop) =>
        PredictionController.getInstance().handleStopClick(stop)
      );
    }
  }

  /**
   * Log nearby-stops render summary.
   */
  private logNearbyStopsSummary(nearbyData: INearbyStopsPayload): void {
    console.log(
      `[FilterController] Rendered ${nearbyData.stops.length} nearby stops ` +
        `(${this.nearbyRouteIds.size} routes, radius: ${nearbyData.radiusMeters}m` +
        `${nearbyData.expandedRadiusApplied ? ', expanded' : ''})`
    );
  }

  /**
   * Restore the default map state: user location, nearby stops, and their
   * route/pattern geometry — without real-time bus locations.
   * Called when exiting directions mode or any overlay that replaced the
   * default view.
   */
  async restoreDefaultState(
    position: ILatLng,
    isCurrent: () => boolean = () => true
  ): Promise<void> {
    if (!isCurrent()) return;
    this.clearMapForDefaultState();
    this.resetFiltersForDefaultState();
    this.resetNearbyStopsTracking();

    // Re-show nearby stops with their route geometry (no vehicles)
    await this.showNearbyStops(position, isCurrent);
  }

  /** Revoke both foreground restoration and any older startup recovery. */
  invalidateView(): void {
    this.viewRevision++;
    this.viewRendering = false;
    if (this.pendingRouteBody?.isConnected) {
      this.renderRouteInfoMessage(
        this.pendingRouteBody,
        'Schedule loading stopped. Select the route again to retry.'
      );
    }
    this.pendingRouteBody = null;
  }

  /** Automatic GPS restoration must not replace a stop or directions selection. */
  canRefreshLocation(): boolean {
    return this.canRecoverMap();
  }

  /** Restore the entire current filter view without changing its filter values. */
  async restoreView(
    position: ILatLng,
    ownsNavigation: () => boolean
  ): Promise<boolean> {
    const revision = ++this.viewRevision;
    if (!ownsNavigation() || this.directionsController.isActive) return false;
    this.viewRendering = true;
    this.clearMapForDefaultState();
    this.resetNearbyStopsTracking();
    const predictionSession = PredictionController.getInstance().sessionVersion;
    const isCurrent = () =>
      revision === this.viewRevision &&
      ownsNavigation() &&
      !this.directionsController.isActive &&
      predictionSession === PredictionController.getInstance().sessionVersion;
    try {
      let routes = this.allRoutesCache.size
        ? Array.from(this.allRoutesCache.values())
        : this.getCurrentState().availableRoutes;
      if (this.shouldHydrateCMURoutes(routes)) {
        const fetched = await this.fetchAllRoutes();
        if (!isCurrent()) return false;
        if (!fetched.length) return false;
        routes = fetched;
      }
      if (!isCurrent()) return false;
      this.publishInitializedRoutes(routes);
      this.clearSelectedRouteIfSystemDisabled(this.getCurrentState());
      this.stateManager.reapplyFilters();
      const state = this.getCurrentState();
      if (this.handleAllSystemsDisabled(state.selectedSystems)) return true;
      if (state.selectedTime) return await this.applyDateTimeFilter(isCurrent);
      if (state.selectedRouteId)
        return await this.applyRouteFilter(state.selectedRouteId, isCurrent);
      const rendered = await this.renderFilteredRoutes(isCurrent);
      return (await this.showNearbyStops(position, isCurrent)) && rendered;
    } finally {
      if (revision === this.viewRevision) this.viewRendering = false;
    }
  }

  /**
   * Clear active map overlays and polling before restoring default state.
   */
  private clearMapForDefaultState(): void {
    this.routeRenderer.clearAllRoutes();
    this.vehicleTracker.stopPolling();
    PredictionController.getInstance().stopPolling();
    dismissPopup();
  }

  /**
   * Reset filter controls to the default map-state values.
   */
  private resetFiltersForDefaultState(): void {
    this.stateManager.updateFilter('selectedRouteId', null);
    this.stateManager.updateFilter('selectedDate', null);
    this.stateManager.updateFilter('selectedTime', null);
    this.stateManager.updateFilter('selectedDirections', {
      inbound: true,
      outbound: true
    });
  }

  /**
   * Clear nearby stop markers from the map.
   * Called when the user selects a specific route.
   */
  clearNearbyStops(): void {
    if (!this.nearbyStopsActive) return;

    const routes = this.getCurrentState().availableRoutes;

    this.clearNearbyMarkersForRouteIds(routes.map((route) => route.id));
    this.restoreRoutesHiddenByNearbyStops(routes);
    this.resetNearbyStopsTracking();

    console.log(
      '[FilterController] Cleared nearby stop markers and restored routes'
    );
  }

  /**
   * Restore visibility for routes hidden during nearby-stops mode.
   */
  private restoreRoutesHiddenByNearbyStops(routes: IRoute[]): void {
    for (const route of routes) {
      if (!this.nearbyRouteIds.has(route.id)) {
        this.routeRenderer.showRoute(route.id);
      }
    }
  }

  /**
   * Fetch nearby stops from the server endpoint.
   * GET /transit/stops/nearbystops?lat=...&lon=...
   */
  private async fetchNearbyStops(
    lat: number,
    lon: number,
    system?: string
  ): Promise<INearbyStopsPayload | null> {
    return transitApiService.getNearbyStops(lat, lon, system);
  }

  // -------------------------------------------------------------------
  // Haversine utility (TUC4 R4 — walk-time heuristic)
  // -------------------------------------------------------------------

  /**
   * Estimate walking time in minutes using the R4 heuristic (1 km ≈ 15 min).
   */
  private estimateWalkMinutes(stopLat: number, stopLon: number): number | null {
    return estimateWalkMinutes(
      this.userLocation,
      stopLat,
      stopLon,
      FilterController.WALK_MINUTES_PER_KM
    );
  }

  /**
   * Reset all filters to default
   */
  async resetFilters(): Promise<void> {
    this.stopHealthPolling();
    this.vehicleTracker.stopPolling();
    this.routeRenderer.clearAllRoutes();
    dismissPopup();
    this.stateManager.resetFilters();
    await this.initialize();
    this.syncURLWithCurrentState();
  }

  // -------------------------------------------------------------------
  // Service Health Monitoring
  // -------------------------------------------------------------------

  /** Single-flight health checks: briefly retry startup, then use the normal cadence. */
  private startHealthPolling(): void {
    if (this.healthPollEnabled) return;
    this.healthPollEnabled = true;
    this.recoveryChecks = 0;
    const version = ++this.healthPollVersion;
    const token = localStorage.getItem('token');
    const isCurrent = () =>
      this.healthPollEnabled &&
      version === this.healthPollVersion &&
      token === localStorage.getItem('token');
    const poll = async (): Promise<void> => {
      if (!isCurrent()) return;
      const request = new AbortController();
      this.healthRequest = request;
      // Bound the entire attempt, including nested rendering requests. Revoking
      // its guard prevents a late response from changing the map after timeout.
      const deadline = window.setTimeout(() => request.abort(), 30000);
      const finished = new Promise<void>((resolve) => {
        request.signal.addEventListener('abort', () => resolve(), {
          once: true
        });
      });
      try {
        await Promise.race([
          this.checkServiceHealth(
            () => isCurrent() && !request.signal.aborted,
            request.signal
          ),
          finished
        ]);
      } finally {
        window.clearTimeout(deadline);
        request.abort();
        if (this.healthRequest === request) this.healthRequest = null;
        if (isCurrent()) {
          const delay =
            this.transitRecoveryPending && this.recoveryChecks++ < 24
              ? 5000
              : 60000;
          this.healthPollInterval = window.setTimeout(() => {
            void poll();
          }, delay);
        }
      }
    };
    void poll();
  }

  /** Stop the health polling interval. */
  stopHealthPolling(): void {
    this.healthPollEnabled = false;
    this.healthPollVersion++;
    this.healthRequest?.abort();
    this.healthRequest = null;
    if (this.healthPollInterval !== null) {
      clearTimeout(this.healthPollInterval);
      this.healthPollInterval = null;
    }
  }

  /** Fetch health status and show/hide the service-status banner. */
  private async checkServiceHealth(
    isCurrent: () => boolean,
    signal: AbortSignal
  ): Promise<void> {
    try {
      const health = await transitApiService.getHealth(signal);
      if (!isCurrent()) return;
      if (!health) {
        if (this.transitRecoveryPending) this.showTransitLoadingBanner();
        return;
      }
      if (health.gtfs?.ready === false) {
        this.transitRecoveryPending = true;
        this.bulkLoaded = false;
      }
      this.updateServiceBanner(health);
      if (health.gtfs?.ready !== false && this.transitRecoveryPending) {
        await this.recoverTransitData(isCurrent, signal);
        if (!this.transitRecoveryPending) {
          // The fresh bulk metadata already includes the current route colors.
          this.colorsWereAvailable = health.trueTimeColors.available;
        }
      }
      if (!isCurrent()) return;
      this.updateServiceBanner(health);
      if (!this.transitRecoveryPending && this.canRecoverMap()) {
        await this.refreshColorsWhenRecovered(health, isCurrent);
      }
    } catch {
      // Don't show banner for network errors on the health check itself
    }
  }

  private showTransitLoadingBanner(): void {
    this.showServiceBanner(
      [
        'Transit schedules are not available yet. Routes and nearby stops will refresh automatically when ready.'
      ],
      'Loading transit data'
    );
  }

  private canRecoverMap(): boolean {
    return (
      !this.viewRendering &&
      !this.directionsController.isActive &&
      !PredictionController.getInstance().hasActiveSelection &&
      !document.getElementById(MAP_POPUP_ID)
    );
  }

  private recoveryContext(): string {
    const state = this.getCurrentState();
    return JSON.stringify([
      this.viewRevision,
      state.selectedRouteId,
      state.selectedDate,
      state.selectedTime,
      state.selectedSystems,
      state.selectedDirections,
      state.plannedLocationLabel,
      state.plannedLocationLabel === 'Current Location'
        ? null
        : state.plannedLocation
    ]);
  }

  /** Rebuild an empty startup cache, then restore the user's current view. */
  private async recoverTransitData(
    isPollingCurrent: () => boolean,
    signal: AbortSignal
  ): Promise<void> {
    if (!this.canRecoverMap()) return;
    const state = this.getCurrentState();
    const hasSystems = state.selectedSystems.prt || state.selectedSystems.cmu;
    const position =
      state.plannedLocation ?? state.currentLocation ?? this.userLocation;
    if (
      hasSystems &&
      !state.selectedRouteId &&
      !state.selectedTime &&
      !position
    )
      return;
    const context = this.recoveryContext();
    const directionsSession = this.directionsController.sessionVersion;
    const predictionSession = PredictionController.getInstance().sessionVersion;
    const isCurrent = () =>
      isPollingCurrent() &&
      this.canRecoverMap() &&
      directionsSession === this.directionsController.sessionVersion &&
      predictionSession === PredictionController.getInstance().sessionVersion &&
      context === this.recoveryContext();
    let routes = await this.fetchBulkData(isCurrent, signal);
    if (!isCurrent() || !this.bulkLoaded || !routes.length) return;
    if (this.shouldHydrateCMURoutes(routes)) {
      const allRoutes = await this.fetchAllRoutes(signal);
      if (!isCurrent() || !allRoutes.some((route) => route.system === 'CMU'))
        return;
      routes = allRoutes;
    }
    this.publishInitializedRoutes(routes);
    let restored = true;
    if (hasSystems) {
      if (state.selectedTime) {
        restored = await this.applyDateTimeFilter(isCurrent);
      } else if (state.selectedRouteId) {
        restored = await this.applyRouteFilter(
          state.selectedRouteId,
          isCurrent
        );
      } else if (position) {
        const routesRendered = await this.renderFilteredRoutes(isCurrent);
        restored =
          (await this.showNearbyStops(position, isCurrent)) && routesRendered;
      }
    }
    if (isCurrent() && restored) this.transitRecoveryPending = false;
  }

  /**
   * Refresh route colors once after TrueTime color availability recovers.
   */
  private async refreshColorsWhenRecovered(
    health: IServiceHealth,
    isCurrent: () => boolean
  ): Promise<void> {
    if (health.trueTimeColors.available && !this.colorsWereAvailable) {
      console.log(
        '[FilterController] TrueTime colors now available — refreshing routes'
      );
      const applied = await this.refreshRouteColors(isCurrent);
      if (!applied) return;
    }
    if (!isCurrent()) return;
    this.colorsWereAvailable = health.trueTimeColors.available;
  }

  /**
   * Show or hide service banner based on current health payload.
   */
  private updateServiceBanner(health: IServiceHealth): void {
    if (health.gtfs?.ready === false || this.transitRecoveryPending) {
      this.showTransitLoadingBanner();
      return;
    }
    const allHealthy = health.overall && health.trueTimeColors.available;
    if (allHealthy) {
      this.hideServiceBanner();
      return;
    }

    this.showServiceBanner(this.buildServiceHealthIssues(health));
  }

  /**
   * Build user-facing service issue list from health payload.
   */
  private buildServiceHealthIssues(health: IServiceHealth): string[] {
    const issues: string[] = [];

    if (!health.vehiclePositions.healthy) {
      issues.push('Real-time vehicle tracking is unavailable');
    }
    if (!health.tripUpdates.healthy) {
      issues.push('Arrival predictions are unavailable');
    }
    if (!health.trueTimeColors.available) {
      issues.push('Route colors are temporarily using defaults');
    }
    if (!health.tripshotLiveStatus.healthy)
      issues.push('CMU shuttle tracking is unavailable');
    if (!issues.length && !health.overall)
      issues.push('Transit service status is temporarily unavailable');

    return issues;
  }

  /**
   * Re-fetch routes from the server to pick up TrueTime colors after
   * a successful color retry.  Updates the local cache and re-renders
   * any currently-displayed route polylines with the correct color.
   */
  private async refreshRouteColors(
    isCurrent: () => boolean = () => true
  ): Promise<boolean> {
    try {
      const freshRoutes = await transitApiService.getRoutes();
      if (!isCurrent() || !this.canRecoverMap() || !freshRoutes.length)
        return false;

      // Update the local route cache and color cache
      const state = this.getCurrentState();
      for (const route of freshRoutes) {
        this.routeColorCache.set(route.id, route.color);
        this.allRoutesCache.set(route.id, route);
      }
      this.stateManager.setAvailableRoutes(freshRoutes);

      // Re-render polylines for any currently-selected route
      if (state.selectedRouteId) {
        const route = freshRoutes.find((r) => r.id === state.selectedRouteId);
        const patterns = this.patternCache.get(state.selectedRouteId);
        if (route && patterns) {
          this.routeRenderer.renderRouteGeometry(
            route.id,
            patterns,
            route.color
          );
        }
      }

      console.log('[FilterController] Route colors refreshed from server');
      return true;
    } catch (err) {
      console.warn('[FilterController] Failed to refresh route colors:', err);
      return false;
    }
  }

  /** Show the service-degraded banner with a list of issues. */
  private showServiceBanner(issues: string[], title?: string): void {
    const banner = document.getElementById('service-status-banner');
    if (!banner) return;

    banner.innerHTML = buildServiceBannerMarkup(issues, title);
    banner.hidden = false;

    const closeBtn = banner.querySelector('.service-status-banner__close');
    if (closeBtn) {
      closeBtn.addEventListener('click', () => this.hideServiceBanner());
    }
  }

  /** Hide the service-status banner. */
  private hideServiceBanner(): void {
    const banner = document.getElementById('service-status-banner');
    if (banner) {
      banner.hidden = true;
      banner.innerHTML = '';
    }
  }
}

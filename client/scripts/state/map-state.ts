/**
 * Central State Management for Map Filters
 * Manages all filter state and notifies subscribers of changes
 */

import type { IRoute, IVehicle } from '../../../common/transit.interface';
import type { ILatLng } from '../../../common/map.interface';
import { getSessionUserId, getToken } from '../services/session';

export interface ISelectedTime {
  hour: number;
  minute: number;
  period: 'AM' | 'PM';
}

export interface IMapState {
  selectedRouteId: string | null; // Route filter (Rule R1 - single route)
  selectedDate: Date | null; // Date filter for schedule-based queries
  selectedTime: ISelectedTime | null; // Time filter for schedule-based queries
  selectedSystems: {
    // System filter (Rule R2 - PRT default ON)
    prt: boolean;
    cmu: boolean;
  };
  selectedDirections: {
    // Direction filter
    inbound: boolean;
    outbound: boolean;
  };
  availableRoutes: IRoute[]; // All routes from backend
  filteredRoutes: IRoute[]; // Routes after applying all filters
  activeVehicles: IVehicle[]; // Current vehicles on selected route
  currentLocation: ILatLng | null; // GPS-based current location
  plannedLocation: ILatLng | null; // User-selected planned location (defaults to currentLocation)
  plannedLocationLabel: string | null; // Display name for planned location
  gpsPermissionGranted: boolean; // Whether the user granted GPS access
}

type StateChangeListener = (state: IMapState) => void;
type PlannedLocationScope = { identity: string; key: string | null };

export class MapStateManager {
  private static instance: MapStateManager;
  private state: IMapState;
  // Display labels are not provenance: the automatic campus fallback and a
  // rider's explicitly selected campus can share the same label/coordinates.
  private hasExplicitPlannedLocation: boolean;
  private listeners: Set<StateChangeListener> = new Set();
  private plannedLocationScope: PlannedLocationScope;
  private readonly onStorage = (event: StorageEvent): void => {
    if (event.key === 'token' || event.key === null) {
      if (this.syncPlannedLocationScope()) this.notifyListeners();
    }
  };

  private constructor() {
    this.plannedLocationScope = this.readPlannedLocationScope();
    // A planned address belongs to the immutable account ID, never a username.
    const saved = this.loadPlannedLocation();
    this.hasExplicitPlannedLocation = saved !== null;

    // Initialize with default state (Rule R2: PRT ON, CMU OFF)
    this.state = {
      ...this.defaultFilterValues(),
      availableRoutes: [],
      currentLocation: null,
      plannedLocation: saved?.location ?? null,
      plannedLocationLabel: saved?.label ?? null,
      gpsPermissionGranted: false
    };
  }

  private defaultFilterValues() {
    return {
      selectedRouteId: null,
      selectedDate: null,
      selectedTime: null,
      selectedSystems: { prt: true, cmu: false },
      selectedDirections: { inbound: true, outbound: true },
      filteredRoutes: [],
      activeVehicles: []
    };
  }

  static getInstance(): MapStateManager {
    if (!MapStateManager.instance) {
      MapStateManager.instance = new MapStateManager();
    }
    return MapStateManager.instance;
  }

  /**
   * Get current state (readonly copy)
   */
  getState(): Readonly<IMapState> {
    if (this.syncPlannedLocationScope()) this.notifyListeners();
    return { ...this.state };
  }

  /**
   * Update a specific filter
   */
  updateFilter<K extends keyof IMapState>(
    filterType: K,
    value: IMapState[K]
  ): void {
    this.state[filterType] = value;
    this.notifyListeners();
  }

  /**
   * Update multiple filters at once
   */
  updateFilters(updates: Partial<IMapState>): void {
    this.state = { ...this.state, ...updates };
    this.notifyListeners();
  }

  /**
   * Set available routes from API
   */
  setAvailableRoutes(routes: IRoute[]): void {
    this.state.availableRoutes = routes;
    this.applyFilters();
    this.notifyListeners();
  }

  /**
   * Set active vehicles for selected route
   */
  setActiveVehicles(vehicles: IVehicle[]): void {
    this.state.activeVehicles = vehicles;
    this.notifyListeners();
  }

  /**
   * Apply current filters to available routes
   */
  private applyFilters(): void {
    let filtered = [...this.state.availableRoutes];

    // Apply system filter
    filtered = filtered.filter((route) => {
      if (route.system === 'PRT') return this.state.selectedSystems.prt;
      if (route.system === 'CMU') return this.state.selectedSystems.cmu;
      return false;
    });

    // Apply route filter (Rule R1: single route selection)
    if (this.state.selectedRouteId) {
      filtered = filtered.filter(
        (route) => route.id === this.state.selectedRouteId
      );
    }

    this.state.filteredRoutes = filtered;
  }

  /**
   * Reset all filters to default state
   */
  resetFilters(): void {
    this.state = {
      ...this.defaultFilterValues(),
      availableRoutes: this.state.availableRoutes, // Keep available routes
      currentLocation: this.state.currentLocation, // Preserve location state
      plannedLocation: this.state.plannedLocation,
      plannedLocationLabel: this.state.plannedLocationLabel,
      gpsPermissionGranted: this.state.gpsPermissionGranted
    };
    this.applyFilters();
    this.notifyListeners();
  }

  /**
   * Subscribe to state changes
   */
  subscribe(listener: StateChangeListener): () => void {
    if (this.syncPlannedLocationScope()) this.notifyListeners();
    if (this.listeners.size === 0)
      window.addEventListener('storage', this.onStorage);
    this.listeners.add(listener);
    // Return unsubscribe function
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0)
        window.removeEventListener('storage', this.onStorage);
    };
  }

  /**
   * Notify all listeners of state change
   */
  private notifyListeners(): void {
    this.syncPlannedLocationScope();
    this.listeners.forEach((listener) => listener({ ...this.state }));
  }

  /**
   * Re-apply filters (call after backend filtering)
   */
  reapplyFilters(): void {
    this.applyFilters();
    this.notifyListeners();
  }

  /**
   * Update current GPS location
   */
  setCurrentLocation(location: ILatLng): void {
    this.syncPlannedLocationScope();
    this.state.currentLocation = location;
    this.state.gpsPermissionGranted = true;
    // If no custom planned location is set, keep planned = current GPS
    if (!this.hasExplicitPlannedLocation) {
      this.state.plannedLocation = location;
      this.state.plannedLocationLabel = 'Current Location';
    }
    this.notifyListeners();
  }

  /**
   * Whether the user has set a custom planned location (not just GPS default)
   */
  hasCustomPlannedLocation(): boolean {
    if (this.syncPlannedLocationScope()) this.notifyListeners();
    return this.hasExplicitPlannedLocation;
  }

  /**
   * Set a user-chosen planned location
   */
  setPlannedLocation(location: ILatLng, label: string): void {
    this.syncPlannedLocationScope();
    this.hasExplicitPlannedLocation = true;
    this.state.plannedLocation = location;
    this.state.plannedLocationLabel = label;
    this.savePlannedLocation(location, label);
    this.notifyListeners();
  }

  /**
   * Reset planned location back to current GPS location
   */
  resetPlannedLocationToCurrent(): void {
    this.syncPlannedLocationScope();
    this.hasExplicitPlannedLocation = false;
    this.state.plannedLocation = this.state.currentLocation;
    this.state.plannedLocationLabel = this.state.currentLocation
      ? 'Current Location'
      : null;
    this.clearSavedPlannedLocation();
    this.notifyListeners();
  }

  /**
   * Invalidate an unavailable GPS fix without changing an explicit selection.
   * The automatic campus fallback is never persisted as a rider's choice.
   */
  setGpsUnavailable(): void {
    this.syncPlannedLocationScope();
    this.state.gpsPermissionGranted = false;
    this.state.currentLocation = null;
    // Default planned location to CMU Pittsburgh campus
    if (!this.hasExplicitPlannedLocation) {
      this.state.plannedLocation = { lat: 40.4433, lng: -79.9436 };
      this.state.plannedLocationLabel = 'CMU Campus';
    }
    this.notifyListeners();
  }

  /**
   * Get the effective location for features (planned location or fallback)
   */
  getEffectiveLocation(): ILatLng | null {
    if (this.syncPlannedLocationScope()) this.notifyListeners();
    return this.state.plannedLocation ?? this.state.currentLocation;
  }

  // ── localStorage persistence for planned location ──────────────────
  private static PLANNED_LOCATION_PREFIX = 'scottygo:planned-location:v2:';

  private readPlannedLocationScope(): PlannedLocationScope {
    try {
      const token = getToken();
      const userId = getSessionUserId(token);
      if (userId) {
        const identity = `user:${userId}`;
        return {
          identity,
          key: `${MapStateManager.PLANNED_LOCATION_PREFIX}${encodeURIComponent(identity)}`
        };
      }
      // Invalid/anonymous sessions can choose a place for this page only.
      return { identity: `temporary:${token ?? ''}`, key: null };
    } catch {
      return { identity: 'unavailable', key: null };
    }
  }

  /** Discard another account's private destination without altering GPS state. */
  private syncPlannedLocationScope(): boolean {
    const scope = this.readPlannedLocationScope();
    if (scope.identity === this.plannedLocationScope.identity) return false;
    this.plannedLocationScope = scope;
    const saved = this.loadPlannedLocation();
    this.hasExplicitPlannedLocation = saved !== null;
    this.state.plannedLocation = saved?.location ??
      this.state.currentLocation ?? { lat: 40.4433, lng: -79.9436 };
    this.state.plannedLocationLabel =
      saved?.label ??
      (this.state.currentLocation ? 'Current Location' : 'CMU Campus');
    return true;
  }

  private savePlannedLocation(location: ILatLng, label: string): void {
    const key = this.plannedLocationScope.key;
    if (!key) return;
    try {
      localStorage.setItem(
        key,
        JSON.stringify({ lat: location.lat, lng: location.lng, label })
      );
    } catch {
      // localStorage may be unavailable — ignore
    }
  }

  private clearSavedPlannedLocation(): void {
    const key = this.plannedLocationScope.key;
    if (!key) return;
    try {
      localStorage.removeItem(key);
    } catch {
      // ignore
    }
  }

  private loadPlannedLocation(): { location: ILatLng; label: string } | null {
    const key = this.plannedLocationScope.key;
    if (!key) return null;
    try {
      // The old global key may belong to a different rider; never migrate it.
      const raw = localStorage.getItem(key);
      if (!raw) return null;
      const data: unknown = JSON.parse(raw);
      if (!data || typeof data !== 'object') return null;
      const { lat, lng, label } = data as Record<string, unknown>;
      if (
        typeof lat !== 'number' ||
        !Number.isFinite(lat) ||
        Math.abs(lat) > 90 ||
        typeof lng !== 'number' ||
        !Number.isFinite(lng) ||
        Math.abs(lng) > 180 ||
        typeof label !== 'string' ||
        !label.trim() ||
        label.length > 512
      ) {
        return null;
      }
      return { location: { lat, lng }, label: label.trim() };
    } catch {
      return null;
    }
  }
}

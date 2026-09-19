/**
 * URL State Synchronization Manager
 * Syncs filter state with browser URL hash for RESTful behavior
 * Format: /#/map?r=P1&s=PRT,CMU&d=20260227&t=1430&dir=IB,OB
 */

import type { IMapState } from './map-state';
import { MapStateManager } from './map-state';

export class URLSyncManager {
  private static instance: URLSyncManager;
  private stateManager: MapStateManager;

  private constructor() {
    this.stateManager = MapStateManager.getInstance();
    this.setupListeners();
  }

  static getInstance(): URLSyncManager {
    if (!URLSyncManager.instance) {
      URLSyncManager.instance = new URLSyncManager();
    }
    return URLSyncManager.instance;
  }

  /**
   * Setup event listeners for browser navigation
   */
  private setupListeners(): void {
    // Listen for hash changes (back/forward navigation)
    window.addEventListener('hashchange', () => {
      this.restoreStateFromURL();
    });
  }

  /**
   * Parse URL hash and return state object
   */
  private parseURL(): Partial<IMapState> {
    const hash = window.location.hash;
    const params = new URLSearchParams(hash.split('?')[1] || '');

    const state: Partial<IMapState> = {
      selectedRouteId: null,
      selectedDate: null,
      selectedTime: null,
      selectedSystems: { prt: true, cmu: false },
      selectedDirections: { inbound: true, outbound: true }
    };

    // Route filter
    const routeId = params.get('r');
    if (routeId) {
      state.selectedRouteId = routeId;
    }

    // System filter
    const systems = params.get('s');
    if (systems !== null) {
      const systemArray = systems.split(',');
      state.selectedSystems = {
        prt: systemArray.includes('PRT'),
        cmu: systemArray.includes('CMU')
      };
    }

    // Direction filter
    const directions = params.get('dir');
    if (directions !== null) {
      const dirArray = directions.split(',');
      state.selectedDirections = {
        inbound: dirArray.includes('IB'),
        outbound: dirArray.includes('OB')
      };
    }

    const date = params.get('d');
    if (date && /^\d{8}$/.test(date)) {
      const year = Number(date.slice(0, 4));
      const month = Number(date.slice(4, 6));
      const day = Number(date.slice(6, 8));
      const parsed = new Date(year, month - 1, day);
      if (
        parsed.getFullYear() === year &&
        parsed.getMonth() === month - 1 &&
        parsed.getDate() === day
      ) {
        state.selectedDate = parsed;
      }
    }
    const time = params.get('t');
    if (time && /^([01]\d|2[0-3])[0-5]\d$/.test(time)) {
      const hour = Number(time.slice(0, 2));
      state.selectedTime = {
        hour: hour % 12 || 12,
        minute: Number(time.slice(2)),
        period: hour >= 12 ? 'PM' : 'AM'
      };
    }

    return state;
  }

  /**
   * Build URL hash from current state
   */
  private buildURL(state: Readonly<IMapState>): string {
    const params = new URLSearchParams();

    // Route filter
    if (state.selectedRouteId) {
      params.set('r', state.selectedRouteId);
    }
    if (state.selectedDate && Number.isFinite(state.selectedDate.getTime())) {
      const date = state.selectedDate;
      params.set(
        'd',
        `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, '0')}${String(date.getDate()).padStart(2, '0')}`
      );
    }
    if (state.selectedTime) {
      const time = state.selectedTime;
      const hour = (time.hour % 12) + (time.period === 'PM' ? 12 : 0);
      params.set(
        't',
        `${String(hour).padStart(2, '0')}${String(time.minute).padStart(2, '0')}`
      );
    }

    // System filter (only if not default)
    const systems: string[] = [];
    if (state.selectedSystems.prt) systems.push('PRT');
    if (state.selectedSystems.cmu) systems.push('CMU');
    if (!(state.selectedSystems.prt && !state.selectedSystems.cmu)) {
      // Don't add if it's the default (PRT only)
      params.set('s', systems.join(','));
    }

    // Direction filter (only if not default)
    const directions: string[] = [];
    if (state.selectedDirections.inbound) directions.push('IB');
    if (state.selectedDirections.outbound) directions.push('OB');
    if (directions.length < 2) {
      // Only add if not showing both (default)
      params.set('dir', directions.join(','));
    }

    const queryString = params.toString();
    return queryString ? `#/map?${queryString}` : '#/map';
  }

  /**
   * Update URL from current state (without triggering hashchange)
   */
  updateURL(state: Readonly<IMapState>): void {
    const newHash = this.buildURL(state);
    if (window.location.hash !== newHash) {
      history.replaceState(null, '', newHash);
    }
  }

  /**
   * Clear the URL back to the bare path (remove hash entirely)
   */
  clearURL(): void {
    history.replaceState(null, '', window.location.pathname);
  }

  /**
   * Restore state from URL (called on page load or hash change)
   */
  restoreStateFromURL(): Partial<IMapState> {
    const urlState = this.parseURL();
    if (Object.keys(urlState).length > 0) {
      this.stateManager.updateFilters(urlState);
    }
    return urlState;
  }

  /**
   * Initialize URL sync on page load
   */
  initialize(): void {
    const urlState = this.restoreStateFromURL();
    console.log('Restored state from URL:', urlState);
  }
}

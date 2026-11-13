/**
 * Map Controls Component
 * Provides filter controls for route, calendar, time, and direction.
 * Each filter button shows its current value, and Clear appears only while a
 * filter narrows the map.
 */

import type { IRoute } from '../../../common/transit.interface';
import { MapStateManager, type IMapState } from '../state/map-state';
import { URLSyncManager } from '../state/url-sync';
import { copyViewLink } from '../utils/copy-view-link';
import { getRouteTitle } from '../utils/route-display';
import { shareTransitLink } from '../utils/share-transit-link';
import { showToast } from '../utils/toast';

type FilterSummary = {
  route: { value: string; label: string; active: boolean };
  system: { value: string; label: string; active: boolean };
  direction: { value: string; label: string; active: boolean };
  narrowed: boolean;
};

/** A route label short enough to sit inside the 48 px filter button. */
export function shortRouteLabel(routeId: string, routes: IRoute[]): string {
  if (!/^cmu-/i.test(routeId)) return routeId;
  const name = routes.find(
    (route) => route.id.toLowerCase() === routeId.toLowerCase()
  )?.name;
  return name?.match(/^([a-z0-9]{1,3})\s+route\b/i)?.[1].toUpperCase() ?? 'CMU';
}

export function summarizeFilters(state: Readonly<IMapState>): FilterSummary {
  const routeId = state.selectedRouteId;
  const routeTitle = routeId
    ? getRouteTitle(
        routeId,
        state.availableRoutes.map(({ id, name, system }) => ({
          id,
          name,
          system
        }))
      )
    : '';
  const { prt, cmu } = state.selectedSystems;
  const { inbound, outbound } = state.selectedDirections;
  const systemValue =
    prt && cmu ? 'PRT CMU' : prt ? 'PRT' : cmu ? 'CMU' : 'None';
  const systemLabel =
    prt && cmu
      ? 'PRT and CMU shuttles'
      : prt
        ? 'PRT only'
        : cmu
          ? 'CMU shuttles only'
          : 'no transit system';
  const directionValue =
    inbound && outbound ? 'Both' : inbound ? 'In' : outbound ? 'Out' : 'None';
  const directionLabel =
    inbound && outbound
      ? 'both directions'
      : inbound
        ? 'inbound only'
        : outbound
          ? 'outbound only'
          : 'no direction';
  const route = {
    value: routeId ? shortRouteLabel(routeId, state.availableRoutes) : 'All',
    label: routeId ? routeTitle : 'all routes',
    active: Boolean(routeId)
  };
  const system = {
    value: systemValue,
    label: systemLabel,
    active: !(prt && !cmu)
  };
  const direction = {
    value: directionValue,
    label: directionLabel,
    active: !(inbound && outbound)
  };
  return {
    route,
    system,
    direction,
    narrowed:
      route.active ||
      system.active ||
      direction.active ||
      Boolean(state.selectedDate || state.selectedTime)
  };
}

export class MapControls extends HTMLElement {
  private unsubscribe: (() => void) | null = null;
  private clearRequestedAt = 0;

  connectedCallback(): void {
    this.renderControls();
    this.bindControlEvents();
    const state = MapStateManager.getInstance();
    this.unsubscribe?.();
    this.unsubscribe = state.subscribe((next) => this.syncFilterState(next));
    this.syncFilterState(state.getState());
  }

  disconnectedCallback(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  private renderControls(): void {
    const canShare = typeof navigator.share === 'function';
    const shareLabel = canShare ? 'Share map view' : 'Copy view link';
    this.innerHTML = `
      <div class="control-panel">
        <button type="button" class="circle-btn map-filter-btn" id="route-filter-btn" title="Choose a route" aria-label="Route filter: all routes">
          <span class="material-icons-outlined" aria-hidden="true">directions_bus</span>
          <span class="map-filter-btn__value" data-filter-value="route" aria-hidden="true">All</span>
        </button>
        <button type="button" class="circle-btn map-filter-btn" id="system-filter-btn" title="Choose PRT or CMU shuttles" aria-label="Transit system filter: PRT only">
          <span class="system-icon" data-filter-value="system" aria-hidden="true">PRT</span>
        </button>
        <button type="button" class="circle-btn map-filter-btn" id="direction-filter-btn" title="Choose a direction" aria-label="Direction filter: both directions">
          <span class="material-icons-outlined" aria-hidden="true">sync_alt</span>
          <span class="map-filter-btn__value" data-filter-value="direction" aria-hidden="true">Both</span>
        </button>
        <button
          type="button"
          class="circle-btn danger map-filter-btn"
          id="clear-filters-btn"
          title="Show all routes again"
          aria-label="Clear all filters"
          hidden
        >
          <span class="material-icons-outlined" aria-hidden="true">filter_alt_off</span>
          <span class="map-filter-btn__value" aria-hidden="true">Clear</span>
        </button>
        <button class="circle-btn" id="copy-view-link-btn" type="button" title="${shareLabel}" aria-label="${shareLabel}">
          <span class="material-icons-outlined" aria-hidden="true">${canShare ? 'ios_share' : 'link'}</span>
        </button>
      </div>
      <span class="view-link-status" role="status" aria-live="polite"></span>
    `;
  }

  /** Read the committed filters, never a panel's unsaved draft. */
  private syncFilterState(state: Readonly<IMapState>): void {
    const summary = summarizeFilters(state);
    const parts = [
      ['route', 'Route filter', summary.route],
      ['system', 'Transit system filter', summary.system],
      ['direction', 'Direction filter', summary.direction]
    ] as const;
    for (const [key, name, part] of parts) {
      const value = this.querySelector<HTMLElement>(
        `[data-filter-value="${key}"]`
      );
      const button = value?.closest('button');
      if (!value || !button) continue;
      if (key === 'system') {
        value.innerHTML = part.value
          .split(' ')
          .map((text) => `<span class="system-text">${text}</span>`)
          .join('');
      } else value.textContent = part.value;
      button.setAttribute('aria-label', `${name}: ${part.label}`);
      button.classList.toggle('is-filtered', part.active);
    }
    const clear = this.querySelector<HTMLButtonElement>('#clear-filters-btn');
    if (!clear) return;
    if (summary.narrowed) {
      clear.hidden = false;
      return;
    }
    // Move focus before hiding the button so keyboard riders keep their place.
    if (document.activeElement === clear)
      this.querySelector<HTMLButtonElement>('#route-filter-btn')?.focus();
    clear.hidden = true;
    if (Date.now() - this.clearRequestedAt < 3000) {
      this.clearRequestedAt = 0;
      showToast('Filters cleared. Showing all PRT routes.');
    }
  }

  private bindControlEvents(): void {
    const routeBtn = this.querySelector('#route-filter-btn');
    const systemBtn = this.querySelector('#system-filter-btn');
    const directionBtn = this.querySelector('#direction-filter-btn');
    const clearBtn =
      this.querySelector<HTMLButtonElement>('#clear-filters-btn');

    routeBtn?.addEventListener('click', () =>
      this.emitFilterEvent('filterRoute')
    );
    systemBtn?.addEventListener('click', () =>
      this.emitFilterEvent('filterSystem')
    );
    directionBtn?.addEventListener('click', () =>
      this.emitFilterEvent('filterDirection')
    );
    clearBtn?.addEventListener('click', () => {
      this.clearRequestedAt = Date.now();
      this.emitFilterEvent('clearFilters');
    });
    const copyBtn = this.querySelector<HTMLButtonElement>(
      '#copy-view-link-btn'
    )!;
    copyBtn.addEventListener('click', () => {
      const url = URLSyncManager.getInstance().getViewLink(
        MapStateManager.getInstance().getState()
      );
      void shareTransitLink(url, 'ScottyGo map', copyBtn, () =>
        copyViewLink(url, copyBtn, (message) => {
          this.querySelector('.view-link-status')!.textContent = message;
          showToast(message);
        })
      );
    });
  }

  private emitFilterEvent(eventName: string): void {
    this.dispatchEvent(new CustomEvent(eventName, { bubbles: true }));
  }
}

customElements.define('map-controls', MapControls);

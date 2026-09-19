/**
 * Map Controls Component
 * Provides filter controls for route, calendar, time, and direction
 */

import { MapStateManager } from '../state/map-state';
import { URLSyncManager } from '../state/url-sync';
import { copyViewLink } from '../utils/copy-view-link';
import { showToast } from '../utils/toast';

export class MapControls extends HTMLElement {
  connectedCallback(): void {
    this.renderControls();
    this.bindControlEvents();
  }

  private renderControls(): void {
    this.innerHTML = `
      <div class="control-panel">
        <button class="circle-btn" id="route-filter-btn" title="Route Filter" aria-label="Filter routes">
          <span class="material-icons-outlined">directions_bus</span>
        </button>
        <button class="circle-btn" id="system-filter-btn" title="Transit System Filter" aria-label="Filter transit systems">
          <div class="system-icon">
            <span class="system-text">PRT</span>
            <span class="system-text">CMU</span>
          </div>
        </button>
        <button class="circle-btn" id="direction-filter-btn" title="Direction Filter" aria-label="Filter route directions">
          <span class="material-icons-outlined">sync_alt</span>
        </button>
        <button
          class="circle-btn danger"
          id="clear-filters-btn"
          title="Clear All Filters"
          aria-label="Clear all filters"
        >
          <span class="system-text">CLEAR</span>
        </button>
        <button class="circle-btn" id="copy-view-link-btn" type="button" title="Copy view link" aria-label="Copy view link">
          <span class="material-icons-outlined" aria-hidden="true">link</span>
        </button>
      </div>
      <span class="view-link-status" role="status" aria-live="polite"></span>
    `;
  }

  private bindControlEvents(): void {
    const routeBtn = this.querySelector('#route-filter-btn');
    const systemBtn = this.querySelector('#system-filter-btn');
    const directionBtn = this.querySelector('#direction-filter-btn');
    const clearBtn = this.querySelector('#clear-filters-btn');

    routeBtn?.addEventListener('click', () =>
      this.emitFilterEvent('filterRoute')
    );
    systemBtn?.addEventListener('click', () =>
      this.emitFilterEvent('filterSystem')
    );
    directionBtn?.addEventListener('click', () =>
      this.emitFilterEvent('filterDirection')
    );
    clearBtn?.addEventListener('click', () =>
      this.emitFilterEvent('clearFilters')
    );
    const copyBtn = this.querySelector<HTMLButtonElement>(
      '#copy-view-link-btn'
    )!;
    copyBtn.addEventListener('click', () => {
      const url = URLSyncManager.getInstance().getViewLink(
        MapStateManager.getInstance().getState()
      );
      void copyViewLink(url, copyBtn, (message) => {
        this.querySelector('.view-link-status')!.textContent = message;
        showToast(message);
      });
    });
  }

  private emitFilterEvent(eventName: string): void {
    this.dispatchEvent(new CustomEvent(eventName, { bubbles: true }));
  }
}

customElements.define('map-controls', MapControls);

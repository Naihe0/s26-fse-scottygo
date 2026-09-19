/**
 * Transit Search Component
 * Provides search input with dropdown results for routes and stops.
 * Delegates search to the backend via GET /map/search?q=... (TransitSearchStrategy).
 */
import { MapStateManager } from '../state/map-state';
import type { IRoute, IStop } from '../../../common/transit.interface';
import { escapeHtml } from '../utils/html';

/** Fallback color for route badges when the route has no assigned color. */
const DEFAULT_BADGE_COLOR = '#888888';

export class TransitSearch extends HTMLElement {
  private routes: IRoute[] = [];
  private routeMap: Map<string, IRoute> = new Map();
  private unsubscribe: (() => void) | null = null;

  private searchInput: HTMLInputElement | null = null;
  private clearBtn: HTMLButtonElement | null = null;
  private dropdown: HTMLElement | null = null;
  private requestVersion = 0;
  private readonly handleOutsideClick = (event: MouseEvent): void => {
    if (!this.contains(event.target as Node)) this.hideDropdown();
  };

  connectedCallback(): void {
    this.innerHTML = this.buildTemplate();

    this.searchInput = this.querySelector(
      '#transit-search-input'
    ) as HTMLInputElement;
    this.clearBtn = this.querySelector(
      '#search-clear-btn'
    ) as HTMLButtonElement;
    this.dropdown = this.querySelector('#search-dropdown') as HTMLElement;

    this.attachSearchEvents();
    this.subscribeToState();
  }

  disconnectedCallback(): void {
    this.unsubscribe?.();
    this.requestVersion++;
    document.removeEventListener('click', this.handleOutsideClick);
  }

  private handleInput(): void {
    const query = this.searchInput?.value.trim() ?? '';

    if (this.clearBtn) this.clearBtn.classList.toggle('is-visible', !!query);

    if (!query) {
      this.hideDropdown();
      this.dispatchEvent(
        new CustomEvent('search', { detail: { query: '' }, bubbles: true })
      );
      return;
    }

    this.dispatchEvent(
      new CustomEvent('search', { detail: { query }, bubbles: true })
    );
    void this.renderResults(query);
  }

  /**
   * Calls GET /map/search?q=<query> on the backend (TransitSearchStrategy).
   * The backend applies stop word filtering and returns matching routes and stops.
   */
  private async renderResults(query: string): Promise<void> {
    if (!this.dropdown) return;
    const requestVersion = ++this.requestVersion;

    const token = localStorage.getItem('token') ?? '';
    let matchedRoutes: IRoute[] = [];
    let matchedStops: IStop[] = [];

    try {
      const res = await fetch(`/search?q=${encodeURIComponent(query)}`, {
        headers: { Authorization: `Bearer ${token}` }
      });

      if (!res.ok) throw new Error(`Search failed (${res.status})`);
      if (res.ok) {
        const data = (await res.json()) as {
          payload?: { routes: IRoute[]; stops: IStop[] };
        };
        matchedRoutes = data.payload?.routes ?? [];
        matchedStops = data.payload?.stops ?? [];
      }
    } catch (err) {
      if (requestVersion !== this.requestVersion || !this.isConnected) return;
      console.warn('Transit search request failed:', err);
      this.dropdown.textContent =
        'Search is temporarily unavailable. Please try again.';
      this.showDropdown();
      return;
    }
    if (requestVersion !== this.requestVersion || !this.isConnected) return;

    if (matchedRoutes.length === 0 && matchedStops.length === 0) {
      this.dropdown.innerHTML = `<div class="search-no-results">No results found</div>`;
      this.showDropdown();
      return;
    }

    const routeItems = matchedRoutes
      .map((r) => this.buildRouteItemHTML(r))
      .join('');
    const stopItems = matchedStops
      .map((s) => this.buildStopItemHTML(s))
      .join('');

    this.dropdown.innerHTML = routeItems + stopItems;
    this.showDropdown();

    this.attachResultListeners(matchedStops);
  }

  private buildRouteItemHTML(r: IRoute): string {
    // GTFS route_id is numeric (e.g. "2073") → display route.name (the short name).
    // When route_id is alphanumeric (e.g. "61D") → it is the display name;
    // route.name holds the long description (e.g. "Murray").
    const isInternalId = /^\d+$/.test(r.id);
    let label: string;
    if (isInternalId) {
      label = r.name;
    } else if (r.id === r.name) {
      label = r.id;
    } else {
      label = `${r.id}- ${r.name}`;
    }
    return `
        <div class="search-result-item search-result-route" data-route-id="${escapeHtml(r.id)}" role="option" tabindex="0">
          <span class="material-icons-outlined search-result-icon">directions_bus</span>
          <span class="search-result-name">${escapeHtml(label)}</span>
        </div>`;
  }

  private buildStopItemHTML(s: IStop): string {
    const badges = (s.routes ?? [])
      .map((routeId: string) => {
        const route = this.routeMap.get(routeId);
        const color = /^#[\da-f]{6}$/i.test(route?.color ?? '')
          ? route!.color
          : DEFAULT_BADGE_COLOR;
        const textColor = this.getTextColor(color);
        return `<span class="route-badge" style="background:${color};color:${textColor}">${escapeHtml(routeId)}</span>`;
      })
      .join('');

    return `
          <div class="search-result-item search-result-stop" data-stop-id="${escapeHtml(s.stopId)}" role="option" tabindex="0">
            <span class="material-icons-outlined search-result-icon">place</span>
            <div class="search-result-content">
              <span class="search-result-name">${escapeHtml(s.stopName)}</span>
              ${badges ? `<div class="search-result-badges">${badges}</div>` : ''}
            </div>
          </div>`;
  }

  private attachResultListeners(matchedStops: IStop[]): void {
    if (!this.dropdown) return;
    this.attachRouteListeners(this.dropdown);
    this.attachStopListeners(this.dropdown, matchedStops);
    const options = Array.from(
      this.dropdown.querySelectorAll<HTMLElement>('[role="option"]')
    );
    options.forEach((option, index) => {
      option.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          this.searchInput?.focus();
          option.click();
        } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault();
          const next =
            (index + (event.key === 'ArrowDown' ? 1 : -1) + options.length) %
            options.length;
          options[next].focus();
        } else if (event.key === 'Escape') {
          event.preventDefault();
          this.searchInput?.focus();
          this.hideDropdown();
        }
      });
    });
  }

  private attachRouteListeners(container: HTMLElement): void {
    container.querySelectorAll('.search-result-route').forEach((el) => {
      el.addEventListener('click', () => {
        const routeId = (el as HTMLElement).dataset.routeId!;
        this.dispatchEvent(
          new CustomEvent('searchSelectRoute', {
            detail: { routeId },
            bubbles: true
          })
        );
        this.hideDropdown();
      });
    });
  }

  private attachStopListeners(
    container: HTMLElement,
    matchedStops: IStop[]
  ): void {
    const stopById = new Map(matchedStops.map((stop) => [stop.stopId, stop]));

    container.querySelectorAll('.search-result-stop').forEach((el) => {
      el.addEventListener('click', () => {
        const stopId = (el as HTMLElement).dataset.stopId!;
        const stop = stopById.get(stopId);
        this.dispatchEvent(
          new CustomEvent('searchSelectStop', {
            detail: { stopId, stop },
            bubbles: true
          })
        );
        this.hideDropdown();
      });
    });
  }

  /** Returns black or white text color depending on background luminance. */
  private getTextColor(hex: string): string {
    const clean = hex.replace('#', '');
    const r = parseInt(clean.substring(0, 2), 16);
    const g = parseInt(clean.substring(2, 4), 16);
    const b = parseInt(clean.substring(4, 6), 16);
    // Relative luminance (WCAG formula, simplified)
    const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    return luminance > 0.55 ? '#1f2937' : '#ffffff';
  }

  private clearSearch(): void {
    if (this.searchInput) this.searchInput.value = '';
    if (this.clearBtn) this.clearBtn.classList.remove('is-visible');
    this.hideDropdown();
    this.dispatchEvent(
      new CustomEvent('search', { detail: { query: '' }, bubbles: true })
    );
    this.searchInput?.focus();
  }

  private buildTemplate(): string {
    return `
      <div class="search-bar">
        <div class="search-wrapper">
          <div class="search-box">
            <span class="material-icons-outlined search-icon">search</span>
            <input
              type="text"
              id="transit-search-input"
              placeholder="Search routes or stops"
              autocomplete="off"
              aria-label="Search routes or stops"
              role="combobox"
              aria-expanded="false"
              aria-autocomplete="list"
              aria-controls="search-dropdown"
            />
            <button
              class="search-clear-btn"
              id="search-clear-btn"
              aria-label="Clear search"
            >
              <span class="material-icons-outlined">close</span>
            </button>
          </div>
          <div
            class="search-dropdown"
            id="search-dropdown"
            role="listbox"
            hidden
          ></div>
        </div>
        <button class="layers-btn" id="layers-btn" title="Toggle Layers" aria-label="Toggle map layers">
          <span class="material-icons-outlined">layers</span>
        </button>
      </div>
    `;
  }

  private attachSearchEvents(): void {
    const layersBtn = this.querySelector('#layers-btn') as HTMLButtonElement;

    this.searchInput?.addEventListener('input', () => this.handleInput());
    this.searchInput?.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        this.hideDropdown();
        return;
      }
      if (e.key === 'ArrowDown' && !this.dropdown?.hidden) {
        e.preventDefault();
        this.dropdown?.querySelector<HTMLElement>('[role="option"]')?.focus();
        return;
      }
      if (e.key !== 'Enter') return;
      e.preventDefault();
      const query = this.searchInput?.value.trim() ?? '';
      if (!query) return;
      void this.renderResults(query);
    });
    this.searchInput?.addEventListener('focus', () => {
      const query = this.searchInput?.value.trim() ?? '';
      if (query) {
        void this.renderResults(query);
      } else {
        this.dispatchEvent(
          new CustomEvent('searchFocusEmpty', { bubbles: true })
        );
      }
    });

    this.clearBtn?.addEventListener('click', () => this.clearSearch());

    layersBtn?.addEventListener('click', () => {
      this.dispatchEvent(new CustomEvent('toggleLayers', { bubbles: true }));
    });

    document.addEventListener('click', this.handleOutsideClick);
  }

  private subscribeToState(): void {
    const stateManager = MapStateManager.getInstance();
    this.unsubscribe = stateManager.subscribe((state) => {
      this.routes = state.availableRoutes;
      this.routeMap = new Map(this.routes.map((r) => [r.id, r]));
    });

    const initialState = stateManager.getState();
    this.routes = initialState.availableRoutes;
    this.routeMap = new Map(this.routes.map((r) => [r.id, r]));
  }

  private showDropdown(): void {
    if (this.dropdown) this.dropdown.hidden = false;
    this.searchInput?.setAttribute('aria-expanded', 'true');
  }

  private hideDropdown(): void {
    this.requestVersion++;
    if (this.dropdown) this.dropdown.hidden = true;
    this.searchInput?.setAttribute('aria-expanded', 'false');
  }
}

customElements.define('transit-search', TransitSearch);

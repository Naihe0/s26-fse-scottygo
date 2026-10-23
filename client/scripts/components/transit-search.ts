/** Search routes and stops through GET /search without interrupting map navigation. */
import { MapStateManager } from '../state/map-state';
import type { IRoute, IStop } from '../../../common/transit.interface';
import { escapeHtml } from '../utils/html';
import { authHeaders } from '../services/session';

const DEFAULT_BADGE_COLOR = '#888888';
const SEARCH_DELAY_MS = 220;
const SEARCH_TIMEOUT_MS = 10000;

export class TransitSearch extends HTMLElement {
  private routeMap = new Map<string, IRoute>();
  private unsubscribe: (() => void) | null = null;
  private searchInput: HTMLInputElement | null = null;
  private clearBtn: HTMLButtonElement | null = null;
  private dropdown: HTMLElement | null = null;
  private results: HTMLElement | null = null;
  private feedback: HTMLElement | null = null;
  private announcement: HTMLElement | null = null;
  private requestVersion = 0;
  private searchTimer: number | null = null;
  private requestTimer: number | null = null;
  private request: AbortController | null = null;
  private activeIndex = -1;
  private composing = false;
  private readonly handleOutsideClick = (event: MouseEvent): void => {
    if (!event.composedPath().includes(this)) this.hideDropdown();
  };
  private readonly handleFocusOut = (event: FocusEvent): void => {
    // A pointer press on a non-focusable result can briefly have no next focus.
    // Its click owns selection; outside clicks are handled separately.
    if (
      event.relatedTarget instanceof Node &&
      !this.contains(event.relatedTarget)
    ) {
      this.hideDropdown();
    }
  };

  connectedCallback(): void {
    this.composing = false;
    this.innerHTML = this.buildTemplate();
    this.searchInput = this.querySelector('#transit-search-input');
    this.clearBtn = this.querySelector('#search-clear-btn');
    this.dropdown = this.querySelector('#search-dropdown');
    this.results = this.querySelector('#search-results');
    this.feedback = this.querySelector('.search-feedback');
    this.announcement = this.querySelector('.search-announcement');
    this.attachSearchEvents();
    this.addEventListener('focusout', this.handleFocusOut);
    this.subscribeToState();
  }

  disconnectedCallback(): void {
    this.unsubscribe?.();
    this.cancelSearch();
    document.removeEventListener('click', this.handleOutsideClick);
    this.removeEventListener('focusout', this.handleFocusOut);
  }

  private handleInput(): void {
    const query = this.searchInput?.value.trim() ?? '';
    this.clearBtn?.classList.toggle('is-visible', !!query);
    if (this.composing) return;
    this.dispatchEvent(
      new CustomEvent('search', { detail: { query }, bubbles: true })
    );
    if (!query) {
      this.hideDropdown();
      return;
    }
    this.scheduleSearch(query);
  }

  /** Invalidate immediately so neither old results nor pending requests can win. */
  private cancelSearch(): void {
    this.requestVersion++;
    if (this.searchTimer !== null) window.clearTimeout(this.searchTimer);
    if (this.requestTimer !== null) window.clearTimeout(this.requestTimer);
    this.searchTimer = null;
    this.requestTimer = null;
    this.request?.abort();
    this.request = null;
  }

  private scheduleSearch(query: string, delay = SEARCH_DELAY_MS): void {
    this.cancelSearch();
    const version = this.requestVersion;
    this.showFeedback('Searching…');
    this.dropdown?.setAttribute('aria-busy', 'true');
    if (delay === 0) {
      void this.renderResults(query, version);
    } else {
      this.searchTimer = window.setTimeout(() => {
        this.searchTimer = null;
        void this.renderResults(query, version);
      }, delay);
    }
  }

  private async renderResults(query: string, version: number): Promise<void> {
    if (!this.isConnected || version !== this.requestVersion) return;
    const request = new AbortController();
    this.request = request;
    const isCurrent = () => this.isConnected && version === this.requestVersion;
    this.requestTimer = window.setTimeout(() => {
      if (!isCurrent()) return;
      this.cancelSearch();
      this.showSearchError();
    }, SEARCH_TIMEOUT_MS);

    try {
      const res = await fetch(`/search?q=${encodeURIComponent(query)}`, {
        headers: authHeaders(),
        signal: request.signal
      });
      if (!res.ok) throw new Error(`Search failed (${res.status})`);
      const data = (await res.json()) as {
        payload?: { routes: IRoute[]; stops: IStop[] };
      };
      if (!isCurrent()) return;
      this.renderMatches(
        data.payload?.routes ?? [],
        data.payload?.stops ?? [],
        query
      );
    } catch {
      if (isCurrent()) this.showSearchError();
    } finally {
      if (isCurrent()) {
        if (this.requestTimer !== null) window.clearTimeout(this.requestTimer);
        this.requestTimer = null;
        this.request = null;
        this.dropdown?.setAttribute('aria-busy', 'false');
      }
    }
  }

  private showSearchError(): void {
    this.showFeedback(
      'Search couldn’t load.',
      'Check your connection and try again.'
    );
    const retry = document.createElement('button');
    retry.type = 'button';
    retry.className = 'search-retry-btn';
    retry.textContent = 'Try again';
    retry.addEventListener('click', () => {
      const query = this.searchInput?.value.trim() ?? '';
      // Returning focus starts the request through the normal focus handler.
      if (query && document.activeElement !== this.searchInput) {
        this.searchInput?.focus();
      } else if (query) {
        this.scheduleSearch(query, 0);
      }
    });
    this.feedback?.append(retry);
  }

  private showFeedback(message: string, hint = ''): void {
    this.resetActiveOption();
    if (this.results) {
      this.results.replaceChildren();
      this.results.hidden = true;
    }
    if (this.announcement) this.announcement.textContent = '';
    if (this.feedback) {
      this.feedback.hidden = false;
      this.feedback.innerHTML = `<p role="status">${escapeHtml(message)}</p>${
        hint ? `<p class="search-feedback-hint">${escapeHtml(hint)}</p>` : ''
      }`;
    }
    this.dropdown?.setAttribute('aria-busy', 'false');
    this.showDropdown();
  }

  private renderMatches(routes: IRoute[], stops: IStop[], query: string): void {
    if (!this.results) return;
    if (!routes.length && !stops.length) {
      this.showFeedback(
        `No matches for “${query}”`,
        'Try a route number or stop name.'
      );
      return;
    }
    this.resetActiveOption();
    if (this.feedback) {
      this.feedback.hidden = true;
      this.feedback.replaceChildren();
    }
    const group = (label: string, count: number, content: string) =>
      count
        ? `<div role="group" aria-label="${label}"><div class="search-group-title" aria-hidden="true">${label}<span>${count}</span></div>${content}</div>`
        : '';
    this.results.innerHTML =
      group(
        'Routes',
        routes.length,
        routes.map((r, i) => this.buildRouteItemHTML(r, i)).join('')
      ) +
      group(
        'Stops',
        stops.length,
        stops
          .map((s, i) => this.buildStopItemHTML(s, routes.length + i))
          .join('')
      );
    this.results.hidden = false;
    if (this.announcement) {
      const count = routes.length + stops.length;
      this.announcement.textContent = `${count} ${count === 1 ? 'result' : 'results'}. Use the arrow keys to choose.`;
    }
    this.attachResultListeners(stops);
    this.showDropdown();
  }

  private buildRouteItemHTML(route: IRoute, index: number): string {
    const label = /^\d+$/.test(route.id)
      ? route.name
      : route.id === route.name
        ? route.id
        : `${route.id} · ${route.name}`;
    const system =
      route.system === 'CMU'
        ? 'CMU Shuttle'
        : route.system === 'PRT'
          ? 'PRT'
          : '';
    return `<div id="search-option-${index}" class="search-result-item search-result-route" data-route-id="${escapeHtml(route.id)}" role="option" aria-selected="false">
      <span class="material-icons-outlined search-result-icon" aria-hidden="true">directions_bus</span>
      <span class="search-result-content"><span class="search-result-name">${escapeHtml(label)}</span>${system ? `<span class="search-result-meta">${system}</span>` : ''}</span>
      <span class="material-icons-outlined search-result-arrow" aria-hidden="true">chevron_right</span>
    </div>`;
  }

  private buildStopItemHTML(stop: IStop, index: number): string {
    const badges = (stop.routes ?? [])
      .map((routeId) => {
        const route = this.routeMap.get(routeId);
        const color = /^#[\da-f]{6}$/i.test(route?.color ?? '')
          ? route!.color
          : DEFAULT_BADGE_COLOR;
        return `<span class="route-badge" style="background:${color};color:${this.getTextColor(color)}">${escapeHtml(routeId)}</span>`;
      })
      .join('');
    return `<div id="search-option-${index}" class="search-result-item search-result-stop" data-stop-id="${escapeHtml(stop.stopId)}" role="option" aria-selected="false">
      <span class="material-icons-outlined search-result-icon" aria-hidden="true">place</span>
      <span class="search-result-content"><span class="search-result-name">${escapeHtml(stop.stopName)}</span>${badges ? `<span class="search-result-badges">${badges}</span>` : ''}</span>
      <span class="material-icons-outlined search-result-arrow" aria-hidden="true">chevron_right</span>
    </div>`;
  }

  private attachResultListeners(stops: IStop[]): void {
    const stopById = new Map(stops.map((stop) => [stop.stopId, stop]));
    this.getOptions().forEach((option) => {
      option.addEventListener('click', (event) => {
        const routeId = option.dataset.routeId;
        const stopId = option.dataset.stopId;
        // Pointer selections release the onscreen keyboard. Keyboard activation
        // keeps the combobox focused without firing another search.
        if (event.detail > 0) this.searchInput?.blur();
        this.hideDropdown();
        if (routeId) {
          this.dispatchEvent(
            new CustomEvent('searchSelectRoute', {
              detail: { routeId },
              bubbles: true
            })
          );
        } else if (stopId) {
          this.dispatchEvent(
            new CustomEvent('searchSelectStop', {
              detail: { stopId, stop: stopById.get(stopId) },
              bubbles: true
            })
          );
        }
      });
    });
  }

  private getOptions(): HTMLElement[] {
    return Array.from(
      this.results?.querySelectorAll<HTMLElement>('[role="option"]') ?? []
    );
  }

  private resetActiveOption(): void {
    this.activeIndex = -1;
    this.searchInput?.removeAttribute('aria-activedescendant');
    this.getOptions().forEach((option) =>
      option.setAttribute('aria-selected', 'false')
    );
  }

  private moveActiveOption(direction: number): void {
    const options = this.getOptions();
    if (!options.length) return;
    this.activeIndex =
      this.activeIndex < 0
        ? direction > 0
          ? 0
          : options.length - 1
        : (this.activeIndex + direction + options.length) % options.length;
    options.forEach((option, index) =>
      option.setAttribute('aria-selected', String(index === this.activeIndex))
    );
    const active = options[this.activeIndex];
    this.searchInput?.setAttribute('aria-activedescendant', active.id);
    active.scrollIntoView?.({ block: 'nearest' });
  }

  private getTextColor(hex: string): string {
    const clean = hex.replace('#', '');
    const r = parseInt(clean.substring(0, 2), 16);
    const g = parseInt(clean.substring(2, 4), 16);
    const b = parseInt(clean.substring(4, 6), 16);
    return (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.55
      ? '#1f2937'
      : '#ffffff';
  }

  private clearSearch(): void {
    this.setSelection(null);
    this.dispatchEvent(
      new CustomEvent('search', { detail: { query: '' }, bubbles: true })
    );
    this.searchInput?.focus();
  }

  /** Synchronize navigation without emitting another search or moving focus. */
  setSelection(routeId: string | null): void {
    if (this.searchInput) this.searchInput.value = routeId ?? '';
    this.clearBtn?.classList.toggle('is-visible', !!routeId);
    this.hideDropdown();
    this.results?.replaceChildren();
  }

  private buildTemplate(): string {
    return `<div class="search-bar">
      <div class="search-wrapper">
        <div class="search-box">
          <span class="material-icons-outlined search-icon" aria-hidden="true">search</span>
          <input type="text" id="transit-search-input" placeholder="Search routes or stops" autocomplete="off" autocapitalize="off" spellcheck="false" enterkeyhint="search" aria-label="Search routes or stops" role="combobox" aria-expanded="false" aria-autocomplete="list" aria-controls="search-results" />
          <button type="button" class="search-clear-btn" id="search-clear-btn" aria-label="Clear search"><span class="material-icons-outlined" aria-hidden="true">close</span></button>
        </div>
        <div class="search-dropdown" id="search-dropdown" hidden>
          <div class="search-feedback" hidden></div>
          <div id="search-results" role="listbox" aria-label="Routes and stops" hidden></div>
          <p class="search-announcement" aria-live="polite" aria-atomic="true"></p>
        </div>
      </div>
      <button type="button" class="layers-btn" id="layers-btn" title="Toggle Layers" aria-label="Toggle map layers"><span class="material-icons-outlined" aria-hidden="true">layers</span></button>
    </div>`;
  }

  private attachSearchEvents(): void {
    this.searchInput?.addEventListener('input', () => this.handleInput());
    this.searchInput?.addEventListener('compositionstart', () => {
      this.composing = true;
      this.hideDropdown();
    });
    this.searchInput?.addEventListener('compositionend', () => {
      this.composing = false;
      this.handleInput();
    });
    this.searchInput?.addEventListener('keydown', (event) => {
      if (this.composing || event.isComposing) return;
      if (
        event.key === 'Escape' ||
        (event.key === 'Tab' &&
          !this.feedback?.querySelector('.search-retry-btn'))
      ) {
        this.hideDropdown();
        return;
      }
      const query = this.searchInput?.value.trim() ?? '';
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        if (this.dropdown?.hidden && query) this.scheduleSearch(query, 0);
        else this.moveActiveOption(event.key === 'ArrowDown' ? 1 : -1);
      } else if (event.key === 'Enter' && query) {
        event.preventDefault();
        const option =
          !this.dropdown?.hidden &&
          this.getOptions()[Math.max(0, this.activeIndex)];
        if (option) option.click();
        else this.scheduleSearch(query, 0);
      }
    });
    this.searchInput?.addEventListener('focus', () => {
      const query = this.searchInput?.value.trim() ?? '';
      if (query) this.scheduleSearch(query, 0);
      else
        this.dispatchEvent(
          new CustomEvent('searchFocusEmpty', { bubbles: true })
        );
    });
    this.clearBtn?.addEventListener('click', () => this.clearSearch());
    this.querySelector('#layers-btn')?.addEventListener('click', () => {
      this.hideDropdown();
      this.dispatchEvent(new CustomEvent('toggleLayers', { bubbles: true }));
    });
    document.addEventListener('click', this.handleOutsideClick);
  }

  private subscribeToState(): void {
    const stateManager = MapStateManager.getInstance();
    this.unsubscribe = stateManager.subscribe((state) => {
      this.routeMap = new Map(
        state.availableRoutes.map((route) => [route.id, route])
      );
    });
    this.routeMap = new Map(
      stateManager.getState().availableRoutes.map((route) => [route.id, route])
    );
  }

  private showDropdown(): void {
    if (this.dropdown) this.dropdown.hidden = false;
    this.searchInput?.setAttribute('aria-expanded', 'true');
  }

  private hideDropdown(): void {
    this.cancelSearch();
    this.resetActiveOption();
    if (this.dropdown) {
      this.dropdown.hidden = true;
      this.dropdown.setAttribute('aria-busy', 'false');
    }
    this.searchInput?.setAttribute('aria-expanded', 'false');
  }
}

customElements.define('transit-search', TransitSearch);

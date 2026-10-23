import { escapeHtml } from '../utils/html';

export interface IRouteSelection {
  route: string | null;
}

export interface IRouteOption {
  id: string;
  name: string;
}

export interface IRouteSelectorElement extends HTMLElement {
  show(): void;
  hide(): void;
  toggle(): void;
  isOpen(): boolean;
  setRoutes(routes: IRouteOption[]): void;
  clearSelection(): void;
  setSelection(route: string | null): void;
}

/** Route filters keep a draft until Apply; closing restores the current map. */
export class RouteSelectorPanel
  extends HTMLElement
  implements IRouteSelectorElement
{
  private routes: IRouteOption[] = [];
  private selectedRoute: string | null = null;
  private committedRoute: string | null = null;
  private isVisible = false;
  private searchValue = '';
  private isComposing = false;
  private opener: HTMLElement | null = null;

  connectedCallback(): void {
    this.ensurePanel();
    this.addEventListener('click', this.handleClick);
    this.addEventListener('keydown', this.handleKeyDown);
  }

  disconnectedCallback(): void {
    this.removeEventListener('click', this.handleClick);
    this.removeEventListener('keydown', this.handleKeyDown);
    this.opener = null;
  }

  show(): void {
    this.ensurePanel();
    if (this.isVisible) return;
    this.opener =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    const panel = this.querySelector<HTMLElement>('.route-selector-panel')!;
    panel.style.display = 'flex';
    panel.style.pointerEvents = 'auto';
    panel.classList.add('visible');
    this.isVisible = true;
    // Focus the panel without opening the phone keyboard before a search tap.
    panel.focus({ preventScroll: true });
    this.querySelector<HTMLElement>('.route-btn.selected')?.scrollIntoView?.({
      block: 'nearest'
    });
  }

  hide(): void {
    const restoreFocus = this.contains(document.activeElement);
    const panel = this.querySelector<HTMLElement>('.route-selector-panel');
    if (panel) {
      panel.classList.remove('visible');
      panel.style.display = 'none';
      panel.style.pointerEvents = 'none';
    }
    this.isVisible = false;
    this.setSelection(this.committedRoute);
    if (restoreFocus && this.opener?.isConnected) {
      this.opener.focus({ preventScroll: true });
    }
    this.opener = null;
  }

  toggle(): void {
    if (this.isVisible) this.hide();
    else this.show();
  }

  isOpen(): boolean {
    return this.isVisible;
  }

  setRoutes(routes: IRouteOption[]): void {
    this.routes = [...routes];
    this.ensurePanel();
    // A feed refresh must not replace the input or interrupt ongoing typing.
    if (!this.isComposing) this.renderResults();
    this.updateSelection();
  }

  clearSelection(): void {
    this.setSelection(null);
  }

  setSelection(route: string | null): void {
    this.selectedRoute = route;
    this.committedRoute = route;
    this.searchValue = '';
    this.isComposing = false;
    this.ensurePanel();
    this.querySelector<HTMLInputElement>('.route-search-input')!.value = '';
    this.renderResults();
  }

  private ensurePanel(): void {
    if (this.querySelector('.route-selector-panel')) return;
    this.innerHTML = `
      <section class="route-selector-panel panel" role="dialog" aria-label="Choose a route" tabindex="-1" style="display: none;">
        <div class="route-controls-heading">
          <h2>Choose a route</h2>
          <button type="button" class="route-controls-close" aria-label="Close route filter"><span aria-hidden="true">×</span></button>
        </div>
        <div class="route-search-wrapper">
          <span class="material-icons-outlined route-search-icon" aria-hidden="true">search</span>
          <input type="search" class="route-search-input" aria-label="Search routes" placeholder="Route number or name" autocomplete="off" autocapitalize="off" spellcheck="false" />
          <button type="button" class="route-search-clear" aria-label="Clear route search" hidden><span aria-hidden="true">×</span></button>
        </div>
        <button type="button" class="route-all" aria-pressed="true">All routes<span aria-hidden="true">✓</span></button>
        <p class="route-selection-summary"></p>
        <p class="route-results-status" role="status" aria-live="polite"></p>
        <div class="route-list"></div>
        <div class="filter-actions">
          <button type="button" class="filter-btn cancel-btn" id="route-cancel">Cancel</button>
          <button type="button" class="filter-btn ok-btn" id="route-ok">Show all routes</button>
        </div>
      </section>
    `;
    const input = this.querySelector<HTMLInputElement>('.route-search-input')!;
    input.addEventListener('compositionstart', () => {
      this.isComposing = true;
    });
    input.addEventListener('compositionend', () => {
      this.isComposing = false;
      this.searchValue = input.value;
      this.renderResults();
    });
    input.addEventListener('input', () => {
      this.searchValue = input.value;
      if (!this.isComposing) this.renderResults();
    });
    this.renderResults();
  }

  private renderResults(): void {
    const query = this.searchValue.trim().toLowerCase();
    const filtered = this.routes.filter(
      (route) =>
        route.id.toLowerCase().includes(query) ||
        route.name.toLowerCase().includes(query)
    );
    const list = this.querySelector<HTMLElement>('.route-list')!;
    list.innerHTML = filtered
      .map(
        (route) => `
          <button type="button" class="route-btn" data-route="${escapeHtml(route.id)}" aria-pressed="false">
            <span>${escapeHtml(route.name)}</span><span class="route-selected-check" aria-hidden="true">✓</span>
          </button>
        `
      )
      .join('');
    if (!filtered.length) {
      const empty = document.createElement('p');
      empty.className = 'route-empty';
      empty.textContent = query
        ? `No routes match “${this.searchValue.trim()}”. Try a route number or name.`
        : 'No routes are available. Try enabling a transit system.';
      list.append(empty);
    }
    list.scrollTop = 0;
    this.querySelector<HTMLElement>('.route-results-status')!.textContent =
      `${filtered.length} ${filtered.length === 1 ? 'route' : 'routes'}`;
    this.querySelector<HTMLButtonElement>('.route-search-clear')!.hidden =
      !this.searchValue;
    this.updateSelection();
  }

  private updateSelection(): void {
    this.querySelectorAll<HTMLElement>('.route-btn').forEach((button) => {
      const selected = button.dataset.route === this.selectedRoute;
      button.classList.toggle('selected', selected);
      button.setAttribute('aria-pressed', String(selected));
    });
    this.querySelector('.route-all')?.setAttribute(
      'aria-pressed',
      String(!this.selectedRoute)
    );
    const name = this.routes.find(
      (route) => route.id === this.selectedRoute
    )?.name;
    this.querySelector<HTMLElement>('.route-selection-summary')!.textContent =
      this.selectedRoute
        ? `Selected: ${name ?? this.selectedRoute}`
        : 'All enabled transit systems';
    this.querySelector<HTMLElement>('#route-ok')!.textContent = this
      .selectedRoute
      ? 'Show route'
      : 'Show all routes';
  }

  private handleClick = (event: MouseEvent): void => {
    event.stopPropagation();
    const button = (event.target as Element).closest<HTMLButtonElement>(
      'button'
    );
    if (!button) return;
    if (button.matches('.route-btn')) {
      this.selectedRoute = button.dataset.route ?? null;
      this.updateSelection();
    } else if (button.matches('.route-all')) {
      this.selectedRoute = null;
      this.updateSelection();
    } else if (button.matches('.route-search-clear')) {
      this.searchValue = '';
      this.isComposing = false;
      const input = this.querySelector<HTMLInputElement>(
        '.route-search-input'
      )!;
      input.value = '';
      this.renderResults();
      input.focus({ preventScroll: true });
    } else if (button.matches('#route-cancel, .route-controls-close')) {
      this.hide();
    } else if (button.matches('#route-ok')) {
      this.committedRoute = this.selectedRoute;
      this.dispatchEvent(
        new CustomEvent<IRouteSelection>('routeSelected', {
          detail: { route: this.selectedRoute },
          bubbles: true
        })
      );
      this.hide();
    }
  };

  private handleKeyDown = (event: KeyboardEvent): void => {
    if (
      event.key !== 'Escape' ||
      event.isComposing ||
      this.isComposing ||
      !this.isVisible
    )
      return;
    event.preventDefault();
    event.stopPropagation();
    this.hide();
  };
}

customElements.define('route-selector-panel', RouteSelectorPanel);

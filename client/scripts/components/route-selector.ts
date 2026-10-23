/**
 * Route Selector Panel Component
 * A reusable route selector panel for selecting transit routes
 * Used for Route Filter in VisRoute feature (Basic Flow steps 7-10, Rule R1)
 */

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

export class RouteSelectorPanel
  extends HTMLElement
  implements IRouteSelectorElement
{
  private routes: IRouteOption[] = [];
  private filteredRoutes: IRouteOption[] = [];
  private selectedRoute: string | null = null;
  private committedRoute: string | null = null;
  private isVisible = false;
  private searchValue = '';

  connectedCallback(): void {
    this.render();
    // Add stopPropagation at the component level to prevent any clicks from bubbling
    this.addEventListener('click', (e) => {
      e.stopPropagation();
    });
  }

  /**
   * Show the route selector panel
   */
  show(): void {
    const panel = this.querySelector('.route-selector-panel') as HTMLElement;
    if (panel) {
      panel.style.display = 'block';
      panel.style.pointerEvents = 'auto'; // Enable pointer events immediately
      this.isVisible = true;
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          panel.classList.add('visible');
        });
      });
    }
  }

  /**
   * Hide the route selector panel
   */
  hide(): void {
    const panel = this.querySelector('.route-selector-panel') as HTMLElement;
    if (panel) {
      panel.classList.remove('visible');
      panel.style.pointerEvents = 'none'; // Disable pointer events
      panel.style.display = 'none';
      this.isVisible = false;
      this.setSelection(this.committedRoute);
    }
  }

  /**
   * Toggle panel visibility
   */
  toggle(): void {
    if (this.isVisible) {
      this.hide();
    } else {
      this.show();
    }
  }

  /**
   * Check if panel is open
   */
  isOpen(): boolean {
    return this.isVisible;
  }

  /**
   * Allow setting routes dynamically
   */
  setRoutes(routes: IRouteOption[]): void {
    this.routes = routes;
    this.filteredRoutes = [...routes];
    this.searchValue = '';
    this.render();
  }

  /**
   * Clear the current route selection
   */
  clearSelection(): void {
    this.setSelection(null);
  }

  setSelection(route: string | null): void {
    this.selectedRoute = route;
    this.committedRoute = route;
    this.searchValue = '';
    this.filteredRoutes = [...this.routes];
    this.render();
  }

  private render(): void {
    // Preserve display and pointer-events styles if panel is currently visible
    const displayStyle = this.isVisible ? 'block' : 'none';
    const pointerEvents = this.isVisible ? 'auto' : 'none';

    this.innerHTML = `
      <div class="route-selector-panel panel" style="display: ${displayStyle}; pointer-events: ${pointerEvents};">
        <div class="route-search-wrapper">
          <span class="material-icons-outlined route-search-icon">search</span>
          <input type="text" class="route-search-input" aria-label="Search routes" placeholder="Search route..." value="${escapeHtml(this.searchValue)}" />
        </div>

        <div class="route-list">
          ${this.filteredRoutes
            .map(
              (route) => `
                <button class="route-btn ${this.selectedRoute === route.id ? 'selected' : ''}" data-route="${escapeHtml(route.id)}" aria-pressed="${this.selectedRoute === route.id}">
                  ${escapeHtml(route.name)}
                </button>
              `
            )
            .join('')}
        </div>

        <div class="filter-actions">
          <button class="filter-btn cancel-btn" id="route-cancel">Cancel</button>
          <button class="filter-btn ok-btn" id="route-ok">OK</button>
        </div>
      </div>
    `;

    // Re-apply the visible class if panel is currently visible
    if (this.isVisible) {
      const panel = this.querySelector('.route-selector-panel') as HTMLElement;
      if (panel) {
        panel.classList.add('visible');
      }
    }

    this.attachEvents();

    // Scroll to selected route if one exists
    if (this.selectedRoute) {
      requestAnimationFrame(() => {
        const selectedBtn = Array.from(
          this.querySelectorAll<HTMLElement>('.route-btn')
        ).find((button) => button.dataset.route === this.selectedRoute);
        if (selectedBtn) {
          selectedBtn.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
      });
    }
  }

  private attachEvents(): void {
    // Search input
    const input = this.querySelector('.route-search-input') as HTMLInputElement;
    input?.addEventListener('input', (e) => {
      e.stopPropagation();
      const value = (e.target as HTMLInputElement).value;
      const cursorPos = (e.target as HTMLInputElement).selectionStart;
      this.searchValue = value;
      // Save scroll position before re-render
      const routeList = this.querySelector('.route-list') as HTMLElement;
      const scrollTop = routeList?.scrollTop || 0;
      this.updateSearchResults(value, scrollTop, cursorPos);
    });

    // Route button selection
    this.querySelectorAll('.route-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const route = (e.currentTarget as HTMLElement).dataset.route || null;

        // Toggle: clicking an already-selected route deselects it
        if (this.selectedRoute === route) {
          this.selectedRoute = null;
          this.querySelectorAll('.route-btn').forEach((b) => {
            b.classList.remove('selected');
          });
        } else {
          this.selectedRoute = route;
          this.querySelectorAll('.route-btn').forEach((b) => {
            b.classList.remove('selected');
          });
          (e.currentTarget as HTMLElement).classList.add('selected');
        }
        this.querySelectorAll<HTMLElement>('.route-btn').forEach((button) => {
          button.setAttribute(
            'aria-pressed',
            String(button.dataset.route === this.selectedRoute)
          );
        });
      });
    });

    // Cancel button
    this.querySelector('#route-cancel')?.addEventListener('click', (e) => {
      e.stopPropagation();
      this.selectedRoute = null;
      this.hide();
    });

    // OK button - dispatch routeSelected event (null when deselected)
    this.querySelector('#route-ok')?.addEventListener('click', (e) => {
      e.stopPropagation();
      this.committedRoute = this.selectedRoute;
      const routeSelection: IRouteSelection = {
        route: this.selectedRoute
      };

      this.dispatchEvent(
        new CustomEvent('routeSelected', {
          detail: routeSelection,
          bubbles: true
        })
      );

      this.hide();
    });
  }

  /** Filter the loaded routes by ID or name, keeping scroll and caret position. */
  private updateSearchResults(
    value: string,
    scrollTop: number,
    cursorPos: number | null
  ): void {
    const query = value.trim().toLowerCase();
    this.filteredRoutes = this.routes.filter(
      (route) =>
        route.id.toLowerCase().includes(query) ||
        route.name.toLowerCase().includes(query)
    );

    this.render();

    // Restore scroll position and focus after re-render.
    const newRouteList = this.querySelector('.route-list') as HTMLElement;
    if (newRouteList) {
      newRouteList.scrollTop = scrollTop;
    }

    const newInput = this.querySelector(
      '.route-search-input'
    ) as HTMLInputElement;
    if (newInput) {
      const selection = cursorPos ?? this.searchValue.length;
      newInput.focus();
      newInput.setSelectionRange(selection, selection);
    }
  }
}

customElements.define('route-selector-panel', RouteSelectorPanel);

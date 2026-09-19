/**
 * Generic Toggle Panel Component
 * A reusable panel with toggle switches that can be configured for different use cases
 * Used for Direction Filter (Inbound/Outbound) and System Filter (PRT/CMU Shuttle)
 */

import { escapeHtml } from '../utils/html';

export interface IToggleOption {
  id: string;
  label: string;
  defaultChecked: boolean;
}

export interface ITogglePanelConfig {
  options: IToggleOption[];
  eventName: string;
}

export interface ITogglePanelElement extends HTMLElement {
  configure(config: ITogglePanelConfig): void;
  show(): void;
  hide(): void;
  toggle(): void;
  isOpen(): boolean;
  getState(): Map<string, boolean>;
  setState(state: Record<string, boolean>): void;
}

export class TogglePanel extends HTMLElement implements ITogglePanelElement {
  private isVisible = false;
  private config: ITogglePanelConfig | null = null;
  private state: Map<string, boolean> = new Map();

  connectedCallback(): void {
    // Add stopPropagation at the component level to prevent any clicks from bubbling
    this.addEventListener('click', (e) => {
      e.stopPropagation();
    });
    // Component will be initialized when configure() is called
  }

  /**
   * Configure the panel with options
   */
  configure(config: ITogglePanelConfig): void {
    this.config = config;

    // Initialize state
    config.options.forEach((option) => {
      this.state.set(option.id, option.defaultChecked);
    });

    this.render();
    this.attachEventListeners();
  }

  /**
   * Render the panel HTML
   */
  private render(): void {
    if (!this.config) return;

    const optionsHTML = this.config.options
      .map(
        (option) => `
        <div class="filter-section">
          <h3 class="filter-label">${option.label}</h3>
          <label class="toggle-switch">
            <input 
              type="checkbox" 
              id="${option.id}" 
              aria-label="${escapeHtml(option.label)}"
              ${option.defaultChecked ? 'checked' : ''} 
            />
            <span class="slider"></span>
          </label>
        </div>
      `
      )
      .join('');

    this.innerHTML = `
      <div class="toggle-filter-panel panel" style="display: none;">
        <div class="filter-content">
          ${optionsHTML}
          
          <div class="filter-actions">
            <button class="filter-btn cancel-btn" id="toggle-cancel">Cancel</button>
            <button class="filter-btn ok-btn" id="toggle-ok">OK</button>
          </div>
        </div>
      </div>
    `;
  }

  /**
   * Attach event listeners to toggles and buttons
   */
  private attachEventListeners(): void {
    if (!this.config) return;

    // Cancel button — restore toggles to their last-confirmed (committed) state
    const cancelBtn = this.querySelector('#toggle-cancel') as HTMLButtonElement;
    cancelBtn?.addEventListener('click', (e) => {
      e.stopPropagation();
      this.hide();
      this.resetToggles();
    });

    // OK button — commit current toggle positions to state, then dispatch event
    const okBtn = this.querySelector('#toggle-ok') as HTMLButtonElement;
    okBtn?.addEventListener('click', (e) => {
      e.stopPropagation();
      // Commit current toggle positions to state
      this.config!.options.forEach((option) => {
        const toggle = this.querySelector(`#${option.id}`) as HTMLInputElement;
        if (toggle) {
          this.state.set(option.id, toggle.checked);
        }
      });
      this.applyFilters();
      this.hide();
    });
  }

  /**
   * Show the panel
   */
  show(): void {
    const panel = this.querySelector('.toggle-filter-panel') as HTMLElement;
    if (panel) {
      console.log('Showing panel:', this.config?.eventName);
      panel.style.display = 'block';
      this.isVisible = true;
      // Use requestAnimationFrame to ensure display change is applied before adding visible class
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          panel.classList.add('visible');
        });
      });
    } else {
      console.error('Panel element not found when trying to show');
    }
  }

  /**
   * Hide the panel
   */
  hide(): void {
    const panel = this.querySelector('.toggle-filter-panel') as HTMLElement;
    if (panel) {
      console.log('Hiding panel:', this.config?.eventName);
      panel.classList.remove('visible');
      panel.style.display = 'none';
      this.isVisible = false;
      this.resetToggles();
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
   * Reset toggles to their previous state (on cancel)
   */
  private resetToggles(): void {
    if (!this.config) return;

    this.config.options.forEach((option) => {
      const toggle = this.querySelector(`#${option.id}`) as HTMLInputElement;
      if (toggle) {
        toggle.checked = this.state.get(option.id) || false;
      }
    });
  }

  /**
   * Apply filters and dispatch event
   */
  private applyFilters(): void {
    if (!this.config) return;

    const filterState: Record<string, boolean> = {};
    this.state.forEach((value, key) => {
      filterState[key] = value;
    });

    this.dispatchEvent(
      new CustomEvent(this.config.eventName, {
        detail: filterState,
        bubbles: true
      })
    );
  }

  /**
   * Get current filter state
   */
  getState(): Map<string, boolean> {
    return new Map(this.state);
  }

  setState(state: Record<string, boolean>): void {
    this.state = new Map(Object.entries(state));
    this.resetToggles();
  }

  /**
   * Check if panel is visible
   */
  isOpen(): boolean {
    return this.isVisible;
  }
}

customElements.define('toggle-panel', TogglePanel);

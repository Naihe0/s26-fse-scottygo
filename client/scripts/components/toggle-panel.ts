import { escapeHtml } from '../utils/html';

export interface IToggleOption {
  id: string;
  label: string;
  defaultChecked: boolean;
}

export interface ITogglePanelConfig {
  options: IToggleOption[];
  eventName: string;
  title?: string;
  emptyMessage?: string;
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

/** Accessible draft filters shared by transit systems and travel direction. */
export class TogglePanel extends HTMLElement implements ITogglePanelElement {
  private isVisible = false;
  private config: ITogglePanelConfig | null = null;
  private state: Map<string, boolean> = new Map();
  private opener: HTMLElement | null = null;

  connectedCallback(): void {
    this.addEventListener('click', this.handleClick);
    this.addEventListener('keydown', this.handleKeyDown);
    this.addEventListener('change', this.updateSummary);
  }

  disconnectedCallback(): void {
    this.removeEventListener('click', this.handleClick);
    this.removeEventListener('keydown', this.handleKeyDown);
    this.removeEventListener('change', this.updateSummary);
    this.opener = null;
  }

  configure(config: ITogglePanelConfig): void {
    this.config = config;
    this.state = new Map(
      config.options.map((option) => [option.id, option.defaultChecked])
    );
    this.render();
  }

  private render(): void {
    if (!this.config) return;
    const title = this.config.title ?? 'Map filters';
    this.innerHTML = `
      <section class="toggle-filter-panel panel" role="dialog" aria-label="${escapeHtml(title)}" tabindex="-1" style="display: ${this.isVisible ? 'flex' : 'none'};">
        <div class="route-controls-heading">
          <h2>${escapeHtml(title)}</h2>
          <button type="button" class="route-controls-close" aria-label="Close ${escapeHtml(title.toLowerCase())}"><span aria-hidden="true">×</span></button>
        </div>
        <div class="filter-content">
          ${this.config.options
            .map(
              (option) => `
            <label class="filter-section">
              <span class="filter-label">${escapeHtml(option.label)}</span>
              <span class="toggle-switch">
                <input type="checkbox" role="switch" id="${escapeHtml(option.id)}" aria-label="${escapeHtml(option.label)}" ${this.state.get(option.id) ? 'checked' : ''} />
                <span class="slider" aria-hidden="true"></span>
              </span>
            </label>
          `
            )
            .join('')}
        </div>
        <p class="toggle-selection-summary" role="status" aria-live="polite"></p>
        <div class="filter-actions">
          <button type="button" class="filter-btn cancel-btn" id="toggle-cancel">Cancel</button>
          <button type="button" class="filter-btn ok-btn" id="toggle-ok">Apply</button>
        </div>
      </section>
    `;
    if (this.isVisible) {
      this.querySelector('.toggle-filter-panel')!.classList.add('visible');
    }
    this.updateSummary();
  }

  show(): void {
    const panel = this.querySelector<HTMLElement>('.toggle-filter-panel');
    if (!panel || this.isVisible) return;
    this.opener =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    panel.style.display = 'flex';
    panel.classList.add('visible');
    this.isVisible = true;
    panel.focus({ preventScroll: true });
  }

  hide(): void {
    const restoreFocus = this.contains(document.activeElement);
    const panel = this.querySelector<HTMLElement>('.toggle-filter-panel');
    if (panel) {
      panel.classList.remove('visible');
      panel.style.display = 'none';
    }
    this.isVisible = false;
    this.resetToggles();
    if (restoreFocus && this.opener?.isConnected) {
      this.opener.focus({ preventScroll: true });
    }
    this.opener = null;
  }

  toggle(): void {
    if (this.isVisible) this.hide();
    else this.show();
  }

  private resetToggles(): void {
    this.querySelectorAll<HTMLInputElement>('input[type="checkbox"]').forEach(
      (input) => {
        input.checked = this.state.get(input.id) ?? false;
      }
    );
    this.updateSummary();
  }

  private handleClick = (event: MouseEvent): void => {
    event.stopPropagation();
    const button = (event.target as Element).closest<HTMLButtonElement>(
      'button'
    );
    if (!button || !this.config) return;
    if (button.matches('#toggle-cancel, .route-controls-close')) {
      this.hide();
    } else if (button.matches('#toggle-ok')) {
      this.querySelectorAll<HTMLInputElement>('input[type="checkbox"]').forEach(
        (input) => {
          this.state.set(input.id, input.checked);
        }
      );
      this.dispatchEvent(
        new CustomEvent(this.config.eventName, {
          detail: Object.fromEntries(this.state),
          bubbles: true
        })
      );
      this.hide();
    }
  };

  private updateSummary = (): void => {
    const summary = this.querySelector<HTMLElement>(
      '.toggle-selection-summary'
    );
    if (!summary) return;
    const inputs = [
      ...this.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')
    ];
    const checked = inputs.filter((input) => input.checked).length;
    summary.textContent = checked
      ? `${checked} of ${inputs.length} selected`
      : (this.config?.emptyMessage ?? 'No options selected');
    summary.classList.toggle('is-empty', checked === 0);
  };

  private handleKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape' || event.isComposing || !this.isVisible) return;
    event.preventDefault();
    event.stopPropagation();
    this.hide();
  };

  getState(): Map<string, boolean> {
    return new Map(this.state);
  }

  setState(state: Record<string, boolean>): void {
    this.state = new Map(Object.entries(state));
    this.resetToggles();
  }

  isOpen(): boolean {
    return this.isVisible;
  }
}

customElements.define('toggle-panel', TogglePanel);

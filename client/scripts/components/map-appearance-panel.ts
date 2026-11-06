import {
  DEFAULT_MAP_APPEARANCE,
  type MapAppearance
} from '../../../common/map-appearance';
import { readMapAppearance, writeMapAppearance } from '../utils/map-appearance';

/** Cosmetic choices are shared by the browser and the hosted iOS view. */
export class MapAppearancePanel extends HTMLElement {
  private value: MapAppearance = { ...DEFAULT_MAP_APPEARANCE };
  private apply?: (value: MapAppearance) => void;
  private focused = false;
  private host: Element | null = null;
  private readonly launch = () => this.open();
  private readonly escape = (event: KeyboardEvent) => {
    if (
      event.key === 'Escape' &&
      this.focused &&
      !document.querySelector('dialog[open]')
    ) {
      this.setFocused(false);
    }
  };

  connectedCallback(): void {
    this.host = this.closest('.map-container');
    this.innerHTML = `
      <dialog class="map-appearance" aria-labelledby="map-appearance-title">
        <header><div><p class="map-appearance__eyebrow">YOUR VIEW</p><h2 id="map-appearance-title">Map appearance</h2></div><button type="button" data-close-appearance aria-label="Close map appearance">×</button></header>
        <p class="map-appearance__hint">Keep buses and stops visible while choosing the map underneath.</p>
        <label class="map-appearance__field">Base map<select data-map-base><option value="road">Streets</option><option value="satellite">Satellite with street names</option></select></label>
        <label class="map-appearance__field">Map overlay<select data-map-overlay><option value="none">No extra overlay</option><option value="transit">Public transit lines</option><option value="traffic">Traffic conditions</option><option value="bike">Bike paths</option></select></label>
        <p class="map-appearance__hint" data-overlay-help></p>
        <label class="map-appearance__contrast"><input type="checkbox" data-map-contrast> Stronger street labels</label>
        <p class="map-appearance__hint">Higher text contrast on the Streets base map.</p>
        <p class="map-appearance__status" role="status" data-map-settings-status></p>
        <div class="map-appearance__actions"><button type="button" data-focus-map>Focus on map</button><button type="button" data-reset-map>Reset appearance</button></div>
        <p class="map-appearance__hint">Focus hides search and route tools. Buses, stops, zoom and location stay available.</p>
      </dialog>
      <button type="button" class="map-focus-exit" hidden>Show map controls</button>
    `;
    this.querySelector('[data-close-appearance]')!.addEventListener(
      'click',
      () => this.close()
    );
    this.querySelector('dialog')!.addEventListener('cancel', (event) => {
      event.preventDefault();
      this.close();
    });
    this.querySelector('[data-map-base]')!.addEventListener('change', (e) => {
      this.value.base =
        (e.target as HTMLSelectElement).value === 'satellite'
          ? 'satellite'
          : 'road';
      this.save();
    });
    this.querySelector('[data-map-overlay]')!.addEventListener(
      'change',
      (e) => {
        this.value.overlay = (e.target as HTMLSelectElement)
          .value as MapAppearance['overlay'];
        this.save();
      }
    );
    this.querySelector('[data-map-contrast]')!.addEventListener(
      'change',
      (e) => {
        this.value.contrast = (e.target as HTMLInputElement).checked;
        this.save();
      }
    );
    this.querySelector('[data-reset-map]')!.addEventListener('click', () => {
      this.value = { ...DEFAULT_MAP_APPEARANCE };
      this.save();
    });
    this.querySelector('[data-focus-map]')!.addEventListener('click', () => {
      this.close(false);
      this.setFocused(true);
    });
    this.querySelector('.map-focus-exit')!.addEventListener('click', () =>
      this.setFocused(false)
    );
    document.addEventListener('toggleLayers', this.launch);
    document.addEventListener('keydown', this.escape);
  }

  configure(apply: (value: MapAppearance) => void): void {
    this.apply = apply;
    this.value = readMapAppearance();
    apply(this.value);
    this.render();
  }

  disconnectedCallback(): void {
    document.removeEventListener('toggleLayers', this.launch);
    document.removeEventListener('keydown', this.escape);
    this.host?.classList.remove('is-map-focused');
    this.host = null;
  }

  open(): void {
    if (!this.apply) return;
    const dialog = this.querySelector('dialog')!;
    if (dialog.open) return;
    this.render();
    if (dialog.showModal) dialog.showModal();
    else dialog.setAttribute('open', '');
    document
      .getElementById('layers-btn')
      ?.setAttribute('aria-expanded', 'true');
    this.querySelector<HTMLElement>('[data-close-appearance]')!.focus();
  }

  private close(restoreFocus = true): void {
    const dialog = this.querySelector('dialog')!;
    if (dialog.close) dialog.close();
    else dialog.removeAttribute('open');
    document
      .getElementById('layers-btn')
      ?.setAttribute('aria-expanded', 'false');
    if (restoreFocus)
      document.getElementById('layers-btn')?.focus({ preventScroll: true });
  }

  private setFocused(enabled: boolean): void {
    this.focused = enabled;
    this.closest('.map-container')?.classList.toggle('is-map-focused', enabled);
    const exit = this.querySelector<HTMLButtonElement>('.map-focus-exit')!;
    exit.hidden = !enabled;
    (enabled ? exit : document.getElementById('layers-btn'))?.focus({
      preventScroll: true
    });
  }

  private save(): void {
    this.apply?.(this.value);
    const persisted = writeMapAppearance(this.value);
    this.render();
    this.querySelector('[data-map-settings-status]')!.textContent = persisted
      ? 'Saved on this browser.'
      : 'Applied for this session. Browser storage is unavailable.';
  }

  private render(): void {
    this.querySelector<HTMLSelectElement>('[data-map-base]')!.value =
      this.value.base;
    this.querySelector<HTMLSelectElement>('[data-map-overlay]')!.value =
      this.value.overlay;
    const contrast = this.querySelector<HTMLInputElement>(
      '[data-map-contrast]'
    )!;
    contrast.checked = this.value.contrast;
    contrast.disabled = this.value.base === 'satellite';
    const descriptions: Record<MapAppearance['overlay'], string> = {
      none: 'Only ScottyGo routes, buses and stops are added to the base map.',
      transit:
        'Google transit lines add wider network context. ScottyGo live markers remain.',
      traffic:
        'Traffic colors show road conditions; arrival estimates still come from the transit agency.',
      bike: 'Bike paths help you plan the first or last part of your trip.'
    };
    this.querySelector('[data-overlay-help]')!.textContent =
      descriptions[this.value.overlay];
    const launch = document.querySelector<HTMLButtonElement>('#layers-btn');
    if (launch) {
      launch.disabled = false;
      launch.setAttribute('aria-haspopup', 'dialog');
      launch.setAttribute(
        'aria-label',
        'Map appearance: ' +
          (this.value.base === 'road' ? 'Streets' : 'Satellite') +
          ', ' +
          this.value.overlay
      );
      launch.title = 'Map appearance';
      launch.setAttribute(
        'aria-pressed',
        String(
          this.value.base !== 'road' ||
            this.value.overlay !== 'none' ||
            this.value.contrast
        )
      );
    }
  }
}
customElements.define('map-appearance-panel', MapAppearancePanel);

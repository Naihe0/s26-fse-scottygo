import { createBusIcon } from '../utils/bus-icon';
import { createLocationIcon } from '../utils/location-icon';
import { createStopIcon } from '../utils/stop-icon';
import type { IOnboardingTutorialElement } from './onboarding-tutorial';

/** A small disclosure keeps symbol explanations available without covering the map. */
export class MapKey extends HTMLElement {
  private readonly onOutside = (event: Event) => {
    if (event.target instanceof Node && !this.contains(event.target))
      this.close(false);
  };
  // The panel opens upward from its toggle. Stop it below the search bar so
  // the heading and first symbol are never hidden on a short phone screen.
  private readonly fitPanel = (): void => {
    const panel = this.querySelector<HTMLElement>('.map-key__panel');
    const toggle = this.querySelector<HTMLElement>('.map-key__toggle');
    if (!panel || !toggle || panel.hidden) return;
    const container = this.closest('.map-container');
    const search = container?.querySelector('.search-bar');
    const ceiling =
      Math.max(
        container?.getBoundingClientRect().top ?? 0,
        search?.getBoundingClientRect().bottom ?? 0
      ) + 10;
    const panelBottom = toggle.getBoundingClientRect().top - 10;
    panel.style.maxHeight = `${Math.max(160, Math.floor(panelBottom - ceiling))}px`;
  };
  private readonly onEscape = (event: KeyboardEvent) => {
    if (event.key === 'Escape' && this.isOpen()) {
      event.preventDefault();
      this.close(true);
    }
  };

  connectedCallback(): void {
    this.innerHTML = `
      <button type="button" class="map-key__toggle" aria-expanded="false" aria-controls="map-key-panel">
        <span class="material-icons-outlined" aria-hidden="true">info</span>Map key
      </button>
      <section id="map-key-panel" class="map-key__panel" aria-labelledby="map-key-title" hidden>
        <h2 id="map-key-title">Reading the map</h2>
        <ul>
          <li><img data-symbol="bus" alt="" /><span><strong>Reported bus</strong><small>Triangle shows travel direction. Tap to zoom in.</small></span></li>
          <li><img data-symbol="estimated" alt="" /><span><strong>Estimated movement</strong><small>Dashed ring: a short route-based estimate between GPS reports.</small></span></li>
          <li><img data-symbol="delayed" alt="" /><span><strong>Delayed location</strong><small>Clock badge: updates paused. Tap for GPS age.</small></span></li>
          <li><img data-symbol="stop" alt="" /><span><strong>Bus stop</strong><small>Tap a dot for arrivals and directions.</small></span></li>
          <li><img data-symbol="gps" alt="" /><span><strong>Your location</strong><small>Blue marks your GPS position.</small></span></li>
          <li><img data-symbol="planned" alt="" /><span><strong>Planning location</strong><small>A place you chose to explore.</small></span></li>
          <li><span class="map-key__lines" aria-hidden="true"><i></i><i></i></span><span><strong>Routes & detours</strong><small>Route colors follow the line. Amber buses and orange-red lines mark detours.</small></span></li>
        </ul>
        <button type="button" class="map-key__guide">Take the map tour</button>
      </section>`;
    const exampleBus = {
      vid: '',
      lat: 0,
      lon: 0,
      routeId: '',
      heading: 45,
      source: 'live' as const,
      lastUpdate: '',
      isDetoured: false
    };
    const symbols = {
      bus: createBusIcon(exampleBus, 14, '#0f766e'),
      estimated: createBusIcon(exampleBus, 14, '#0f766e', 'estimated'),
      delayed: createBusIcon(exampleBus, 14, '#0f766e', 'delayed'),
      stop: createStopIcon('#0f766e', 15),
      gps: createLocationIcon('gps'),
      planned: createLocationIcon('planned')
    };
    for (const [name, icon] of Object.entries(symbols))
      this.querySelector<HTMLImageElement>(`[data-symbol="${name}"]`)!.src =
        icon.url;
    this.querySelector('button')!.addEventListener('click', () => {
      const open = !this.isOpen();
      this.querySelector('button')!.setAttribute('aria-expanded', String(open));
      this.querySelector<HTMLElement>('.map-key__panel')!.hidden = !open;
      if (open) {
        this.fitPanel();
        window.addEventListener('resize', this.fitPanel);
      } else window.removeEventListener('resize', this.fitPanel);
    });
    document.addEventListener('pointerdown', this.onOutside);
    this.querySelector('.map-key__guide')!.addEventListener('click', () => {
      this.close(true);
      document.querySelector<IOnboardingTutorialElement>('onboarding-tutorial')
        ?.start(this.querySelector<HTMLButtonElement>('.map-key__toggle')!);
    });
    document.addEventListener('keydown', this.onEscape);
  }

  disconnectedCallback(): void {
    document.removeEventListener('pointerdown', this.onOutside);
    document.removeEventListener('keydown', this.onEscape);
    window.removeEventListener('resize', this.fitPanel);
  }

  private isOpen(): boolean {
    return (
      this.querySelector('button')?.getAttribute('aria-expanded') === 'true'
    );
  }

  private close(restoreFocus: boolean): void {
    if (!this.isOpen()) return;
    this.querySelector('button')!.setAttribute('aria-expanded', 'false');
    this.querySelector<HTMLElement>('.map-key__panel')!.hidden = true;
    window.removeEventListener('resize', this.fitPanel);
    if (restoreFocus) this.querySelector('button')!.focus();
  }
}

customElements.define('map-key', MapKey);

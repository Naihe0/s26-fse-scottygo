import { createBusIcon } from '../utils/bus-icon';
import { createLocationIcon } from '../utils/location-icon';
import { createStopIcon } from '../utils/stop-icon';

/** A small disclosure keeps symbol explanations available without covering the map. */
export class MapKey extends HTMLElement {
  private readonly onOutside = (event: Event) => {
    if (event.target instanceof Node && !this.contains(event.target))
      this.close(false);
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
          <li><img data-symbol="delayed" alt="" /><span><strong>Delayed location</strong><small>Clock badge: last reported position. Tap to see its age.</small></span></li>
          <li><img data-symbol="stop" alt="" /><span><strong>Bus stop</strong><small>Tap a dot for arrivals and directions.</small></span></li>
          <li><img data-symbol="gps" alt="" /><span><strong>Your location</strong><small>Blue marks your GPS position.</small></span></li>
          <li><img data-symbol="planned" alt="" /><span><strong>Planning location</strong><small>A place you chose to explore.</small></span></li>
          <li><span class="map-key__lines" aria-hidden="true"><i></i><i></i></span><span><strong>Routes & detours</strong><small>Route colors follow the line. Amber buses and orange-red lines mark detours.</small></span></li>
        </ul>
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
    });
    document.addEventListener('pointerdown', this.onOutside);
    document.addEventListener('keydown', this.onEscape);
  }

  disconnectedCallback(): void {
    document.removeEventListener('pointerdown', this.onOutside);
    document.removeEventListener('keydown', this.onEscape);
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
    if (restoreFocus) this.querySelector('button')!.focus();
  }
}

customElements.define('map-key', MapKey);

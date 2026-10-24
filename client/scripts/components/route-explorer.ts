import type { ILatLng } from '../../../common/map.interface';
import type { IStop, IVehicle } from '../../../common/transit.interface';
import { MapStateManager, type IMapState } from '../state/map-state';
import { transitApiService } from '../services/transit-api.service';
import { getRouteTitle } from '../utils/route-display';
import { haversineMeters } from '../../../common/geo';

export interface RouteExplorerConfiguration {
  getOrigin: () => ILatLng | null;
  onSelectStop: (stop: IStop) => void;
}

/** Great-circle distance is a comparison aid, not a walking-route estimate. */
function distanceMeters(a: ILatLng, stop: IStop): number {
  return haversineMeters(a, { lat: stop.lat, lng: stop.lon });
}

function validStop(stop: IStop): boolean {
  return (
    !!stop &&
    typeof stop.stopId === 'string' &&
    typeof stop.stopName === 'string' &&
    Number.isFinite(stop.lat) &&
    Math.abs(stop.lat) <= 90 &&
    Number.isFinite(stop.lon) &&
    Math.abs(stop.lon) <= 180
  );
}

/** Browse actual stop sets and reported buses without inventing a trip sequence. */
export class RouteExplorer extends HTMLElement {
  private static nextId = 0;
  private readonly panelId = `route-explorer-${++RouteExplorer.nextId}`;
  private readonly stateManager = MapStateManager.getInstance();
  private configuration: RouteExplorerConfiguration = {
    getOrigin: () => this.stateManager.getEffectiveLocation(),
    onSelectStop: () => undefined
  };
  private unsubscribe: (() => void) | null = null;
  private selectedRoute: string | null = null;
  private direction = '';
  private directionOptionsKey = '';
  private stops: IStop[] = [];
  private request = 0;
  private requestTimer: ReturnType<typeof setTimeout> | null = null;
  private stopRequest: AbortController | null = null;
  private resolveCancelledRequest: (() => void) | null = null;
  private nearestKey = '';
  private isLoading = false;
  private hasError = false;
  private loaded = false;

  configure(configuration: RouteExplorerConfiguration): void {
    this.configuration = configuration;
    if (this.isConnected) this.renderNearestStop();
  }

  connectedCallback(): void {
    this.renderShell();
    this.unsubscribe?.();
    this.unsubscribe = this.stateManager.subscribe((state) =>
      this.updateState(state)
    );
    this.updateState(this.stateManager.getState());
  }

  disconnectedCallback(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.cancelRequest();
    this.close(false);
    this.selectedRoute = null;
  }

  open(): void {
    if (!this.selectedRoute) return;
    const dialog = this.querySelector<HTMLDialogElement>('dialog')!;
    if (dialog.open) return;
    if (dialog.showModal) dialog.showModal();
    else dialog.setAttribute('open', '');
    this.trigger.setAttribute('aria-expanded', 'true');
    this.querySelector<HTMLButtonElement>('[data-close]')!.focus();
    this.renderVehicles(this.stateManager.getState().activeVehicles);
    this.renderNearestStop();
    if (!this.loaded && !this.isLoading) void this.loadStops();
  }

  close(restoreFocus = true): void {
    const dialog = this.querySelector<HTMLDialogElement>('dialog');
    if (!dialog?.open) return;
    if (dialog.close) dialog.close();
    else dialog.removeAttribute('open');
    this.trigger.setAttribute('aria-expanded', 'false');
    if (restoreFocus && this.isConnected && !this.hidden) this.trigger.focus();
  }

  private get trigger(): HTMLButtonElement {
    return this.querySelector<HTMLButtonElement>('.route-explorer__trigger')!;
  }

  private renderShell(): void {
    this.innerHTML = `
      <button type="button" class="route-explorer__trigger" aria-expanded="false" aria-controls="${this.panelId}">
        <span class="material-icons-outlined" aria-hidden="true">route</span>Explore route
      </button>
      <dialog id="${this.panelId}" class="route-explorer__dialog" aria-labelledby="${this.panelId}-title">
        <header class="route-explorer__header">
          <div><p>Explore route</p><h2 id="${this.panelId}-title"></h2></div>
          <button type="button" data-close aria-label="Close route explorer">×</button>
        </header>
        <div class="route-explorer__body">
          <button type="button" data-overview class="route-explorer__overview"><span class="material-icons-outlined" aria-hidden="true">zoom_out_map</span>Show full route</button>
          <label class="route-explorer__field">Browse stop direction<select aria-label="Route direction"></select></label>
          <p class="route-explorer__note">Choose a direction for stops. Bus visibility follows your map filters.</p>
          <section class="route-explorer__nearest" aria-label="Nearest boarding stop"></section>
          <section class="route-explorer__vehicles" aria-labelledby="${this.panelId}-buses">
            <h3 id="${this.panelId}-buses">Buses shown on map <span data-bus-count></span></h3>
            <p class="route-explorer__note">Tap a bus to find it on the map.</p>
            <ul data-buses></ul><p data-no-buses class="route-explorer__note">No buses shown for the current map filters.</p>
          </section>
          <section aria-labelledby="${this.panelId}-stops">
            <h3 id="${this.panelId}-stops">Stops</h3>
            <label class="route-explorer__field route-explorer__search"><span class="route-explorer__sr-only">Search route stops</span><input type="search" placeholder="Find a stop on this route" aria-label="Search route stops" autocomplete="off" /></label>
            <p class="route-explorer__note">Stops are listed alphabetically, not in travel order.</p>
            <p data-status role="status"></p>
            <button type="button" data-retry hidden>Retry loading stops</button>
            <ul data-stops></ul>
          </section>
        </div>
      </dialog>`;
    this.trigger.addEventListener('click', () => this.open());
    this.querySelector('[data-close]')!.addEventListener('click', () =>
      this.close()
    );
    this.querySelector('dialog')!.addEventListener('cancel', (event) => {
      event.preventDefault();
      this.close();
    });
    this.querySelector('dialog')!.addEventListener('keydown', (event) => {
      if ((event as KeyboardEvent).key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        this.close();
      }
    });
    this.querySelector('[data-overview]')!.addEventListener('click', () => {
      const routeId = this.selectedRoute;
      this.close(false);
      this.dispatchEvent(
        new CustomEvent('routeOverview', {
          detail: { routeId },
          bubbles: true,
          composed: true
        })
      );
    });
    this.querySelector('select')!.addEventListener('change', () => {
      this.direction = this.querySelector('select')!.value;
      this.renderVehicles(this.stateManager.getState().activeVehicles);
      void this.loadStops();
    });
    this.querySelector('input')!.addEventListener('input', () =>
      this.renderStops()
    );
    this.querySelector('[data-retry]')!.addEventListener(
      'click',
      () => void this.loadStops()
    );
  }

  private updateState(state: Readonly<IMapState>): void {
    this.hidden = !state.selectedRouteId;
    const routeChanged = this.selectedRoute !== state.selectedRouteId;
    if (routeChanged) {
      this.cancelRequest();
      this.selectedRoute = state.selectedRouteId;
      this.stops = [];
      this.loaded = false;
      this.hasError = false;
      this.querySelector('input')!.value = '';
      if (!this.selectedRoute) {
        this.close(false);
        return;
      }
    }
    if (!this.selectedRoute) return;
    const route = state.availableRoutes.find(
      (item) => item.id === this.selectedRoute
    );
    const directions = [
      ...new Set(
        route?.directions?.length ? route.directions : ['INBOUND', 'OUTBOUND']
      )
    ];
    const directionOptionsKey = JSON.stringify(directions);
    const previousDirection = this.direction;
    if (routeChanged || directionOptionsKey !== this.directionOptionsKey) {
      this.directionOptionsKey = directionOptionsKey;
      this.direction =
        !routeChanged && directions.includes(this.direction)
          ? this.direction
          : (directions.find(
              (value) =>
                (state.selectedDirections.inbound && value === 'INBOUND') ||
                (state.selectedDirections.outbound && value === 'OUTBOUND')
            ) ?? directions[0]);
      const select = this.querySelector('select')!;
      select.replaceChildren(
        ...directions.map((direction) => {
          const option = document.createElement('option');
          option.value = direction;
          option.textContent =
            direction.charAt(0).toUpperCase() +
            direction.slice(1).toLowerCase();
          return option;
        })
      );
      select.value = this.direction;
      select.disabled = directions.length === 1;
    }
    if (
      this.querySelector('dialog')!.open &&
      (routeChanged || previousDirection !== this.direction)
    )
      void this.loadStops();
    this.querySelector('h2')!.textContent = getRouteTitle(
      this.selectedRoute,
      state.availableRoutes
    );
    this.renderVehicles(state.activeVehicles);
    this.renderNearestStop();
  }

  private cancelRequest(): void {
    this.request++;
    this.stopRequest?.abort();
    this.stopRequest = null;
    this.resolveCancelledRequest?.();
    this.resolveCancelledRequest = null;
    if (this.requestTimer) clearTimeout(this.requestTimer);
    this.requestTimer = null;
    this.isLoading = false;
  }

  private async loadStops(): Promise<void> {
    if (!this.selectedRoute) return;
    this.cancelRequest();
    const request = this.request;
    const routeId = this.selectedRoute;
    const direction = this.direction;
    this.stopRequest = new AbortController();
    const signal = this.stopRequest.signal;
    this.isLoading = true;
    this.loaded = false;
    this.hasError = false;
    this.stops = [];
    this.renderStops();
    this.renderNearestStop();
    try {
      const timeout = new Promise<null>((resolve) => {
        this.resolveCancelledRequest = () => resolve(null);
        this.requestTimer = setTimeout(() => resolve(null), 15_000);
      });
      const result = await Promise.race([
        transitApiService.getStops(routeId, direction, signal),
        timeout
      ]);
      if (request !== this.request || !this.isConnected) return;
      this.hasError = result === null;
      const unique = new Map<string, IStop>();
      for (const stop of result ?? [])
        if (validStop(stop))
          unique.set(`${stop.stopId}:${stop.lat}:${stop.lon}`, stop);
      this.stops = [...unique.values()].sort((a, b) =>
        a.stopName.localeCompare(b.stopName, undefined, { numeric: true })
      );
      this.loaded = !this.hasError;
    } catch {
      if (request !== this.request || !this.isConnected) return;
      this.hasError = true;
    } finally {
      if (request === this.request && this.isConnected) {
        if (this.requestTimer) clearTimeout(this.requestTimer);
        this.requestTimer = null;
        this.resolveCancelledRequest = null;
        this.stopRequest?.abort();
        this.stopRequest = null;
        this.isLoading = false;
        this.renderStops();
        this.renderNearestStop();
      }
    }
  }

  private selectStop(stop: IStop): void {
    this.close(false);
    this.configuration.onSelectStop(stop);
  }

  private renderStops(): void {
    const query = this.querySelector('input')!.value.trim().toLocaleLowerCase();
    const visible = this.stops.filter((stop) =>
      `${stop.stopName} ${stop.stopId}`.toLocaleLowerCase().includes(query)
    );
    const status = this.querySelector<HTMLElement>('[data-status]')!;
    status.textContent = this.isLoading
      ? 'Loading stops…'
      : this.hasError
        ? 'Stops could not be loaded. Please retry.'
        : !visible.length
          ? query
            ? 'No stops match your search.'
            : 'No stops available in this direction.'
          : `${visible.length} ${visible.length === 1 ? 'stop' : 'stops'}`;
    this.querySelector<HTMLButtonElement>('[data-retry]')!.hidden =
      !this.hasError;
    const list = this.querySelector<HTMLElement>('[data-stops]')!;
    list.setAttribute('aria-busy', String(this.isLoading));
    list.replaceChildren(
      ...visible.map((stop) => {
        const item = document.createElement('li');
        const button = document.createElement('button');
        button.type = 'button';
        const name = document.createElement('strong');
        name.textContent = stop.stopName;
        const id = document.createElement('span');
        id.textContent = `Stop ${stop.stopId}`;
        button.append(name, id);
        button.addEventListener('click', () => this.selectStop(stop));
        item.appendChild(button);
        return item;
      })
    );
  }

  private renderNearestStop(): void {
    const container = this.querySelector<HTMLElement>(
      '.route-explorer__nearest'
    );
    if (!container) return;
    const origin = this.configuration.getOrigin();
    if (
      !origin ||
      !Number.isFinite(origin.lat) ||
      Math.abs(origin.lat) > 90 ||
      !Number.isFinite(origin.lng) ||
      Math.abs(origin.lng) > 180 ||
      !this.stops.length ||
      this.isLoading ||
      this.hasError
    ) {
      container.hidden = true;
      container.replaceChildren();
      this.nearestKey = '';
      return;
    }
    container.hidden = false;
    const ranked = this.stops
      .map((stop) => ({ stop, distance: distanceMeters(origin, stop) }))
      .sort((a, b) => a.distance - b.distance);
    const nearest = ranked[0];
    const state = this.stateManager.getState();
    const context =
      state.plannedLocationLabel &&
      state.plannedLocationLabel !== 'Current Location'
        ? state.plannedLocationLabel
        : 'your location';
    const heading = document.createElement('h3');
    heading.textContent = 'Nearest boarding stop';
    const note = document.createElement('p');
    note.className = 'route-explorer__note';
    const distance =
      nearest.distance < 1000
        ? `${Math.round(nearest.distance / 10) * 10} m`
        : `${(nearest.distance / 1000).toFixed(1)} km`;
    const nearestKey = `${nearest.stop.stopId}:${nearest.stop.lat}:${nearest.stop.lon}:${nearest.stop.stopName}:${distance}:${context}`;
    if (nearestKey === this.nearestKey) return;
    this.nearestKey = nearestKey;
    const restoreFocus = container.contains(document.activeElement);
    note.textContent = `${distance} from ${context} · straight-line distance`;
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = nearest.stop.stopName;
    button.addEventListener('click', () => this.selectStop(nearest.stop));
    container.replaceChildren(heading, note, button);
    if (restoreFocus) button.focus();
  }

  private renderVehicles(vehicles: IVehicle[]): void {
    const list = this.querySelector<HTMLElement>('[data-buses]')!;
    const directions = this.stateManager.getState().selectedDirections;
    const focused = list.contains(document.activeElement)
      ? (document.activeElement as HTMLElement)
      : null;
    const relevant = [
      ...new Map(
        vehicles
          .filter(
            (vehicle) =>
              vehicle.routeId === this.selectedRoute &&
              (vehicle.direction === 'INBOUND'
                ? directions.inbound
                : vehicle.direction === 'OUTBOUND'
                  ? directions.outbound
                  : true)
          )
          .map((vehicle) => [vehicle.vid, vehicle])
      ).values()
    ];
    const previous = new Map(
      [...list.querySelectorAll<HTMLLIElement>('li')].map((item) => [
        item.dataset.vid,
        item
      ])
    );
    for (const [index, vehicle] of relevant.entries()) {
      let item = previous.get(vehicle.vid);
      if (!item) {
        item = document.createElement('li');
        item.dataset.vid = vehicle.vid;
        const button = document.createElement('button');
        button.type = 'button';
        button.addEventListener('click', () => {
          this.close(false);
          this.dispatchEvent(
            new CustomEvent('selectBus', {
              detail: { vid: vehicle.vid, routeId: this.selectedRoute },
              bubbles: true,
              composed: true
            })
          );
        });
        item.appendChild(button);
      }
      const captured = new Date(vehicle.lastUpdate);
      const timestamp = Number.isFinite(captured.getTime())
        ? `${vehicle.source === 'static' ? 'Cached report' : 'Reported'} ${captured.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' })}${Date.now() - captured.getTime() > 90_000 ? ' · delayed' : ''}`
        : 'Report time unavailable';
      item.querySelector('button')!.textContent =
        `Bus ${vehicle.vid} · ${timestamp}${vehicle.direction ? '' : ' · direction unavailable'}`;
      if (list.children[index] !== item)
        list.insertBefore(item, list.children[index] ?? null);
      previous.delete(vehicle.vid);
    }
    previous.forEach((item) => item.remove());
    if (focused?.isConnected && document.activeElement !== focused)
      focused.focus();
    else if (focused && !focused.isConnected)
      this.querySelector<HTMLButtonElement>('[data-close]')!.focus();
    this.querySelector('[data-bus-count]')!.textContent =
      `(${relevant.length})`;
    this.querySelector<HTMLElement>('[data-no-buses]')!.hidden =
      relevant.length > 0;
  }
}

customElements.define('route-explorer', RouteExplorer);

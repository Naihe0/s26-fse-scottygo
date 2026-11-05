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
  private stopListOrigin = '';
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
        <div class="route-explorer__views" role="tablist" aria-label="Route details">
          <button type="button" role="tab" data-view="stops" id="${this.panelId}-stops-tab" aria-controls="${this.panelId}-stops-view" aria-selected="true">Stops</button>
          <button type="button" role="tab" data-view="buses" id="${this.panelId}-buses-tab" aria-controls="${this.panelId}-buses-view" aria-selected="false" tabindex="-1">Buses <span data-bus-count></span></button>
        </div>
        <div class="route-explorer__body">
          <button type="button" data-overview class="route-explorer__overview"><span class="material-icons-outlined" aria-hidden="true">zoom_out_map</span>Show full route</button>
          <div role="tabpanel" id="${this.panelId}-stops-view" aria-labelledby="${this.panelId}-stops-tab">
          <label class="route-explorer__field">Stop direction<select aria-label="Route direction"></select></label>
          <section class="route-explorer__nearest" aria-label="Nearest boarding stop"></section>
          <section aria-labelledby="${this.panelId}-stops">
            <h3 id="${this.panelId}-stops">Stops</h3>
            <label class="route-explorer__field route-explorer__search"><span class="route-explorer__sr-only">Search route stops</span><input type="search" placeholder="Street, stop number or transfer route" aria-label="Search route stops" autocomplete="off" /></label>
            <label class="route-explorer__field" data-stop-sort>Order stops<select aria-label="Order stops"><option value="name">Stop name (A–Z)</option><option value="distance">Nearest first</option></select></label>
            <p class="route-explorer__note" data-order-note></p>
            <p data-status role="status"></p>
            <button type="button" data-retry hidden>Retry loading stops</button>
            <ul data-stops></ul>
          </section>
          </div>
          <div role="tabpanel" id="${this.panelId}-buses-view" aria-labelledby="${this.panelId}-buses-tab" hidden>
            <section class="route-explorer__vehicles" aria-labelledby="${this.panelId}-buses">
              <h3 id="${this.panelId}-buses">Buses shown on map</h3>
              <details data-vehicle-tools><summary>Find a bus</summary>
                <label class="route-explorer__field">Find bus or reported stop<input type="search" data-bus-query placeholder="Bus number, stop ID or name" autocomplete="off"></label>
                <label class="route-explorer__field">Order buses<select data-bus-order><option value="feed">Agency order</option><option value="near">Closest to start</option><option value="recent">Newest GPS first</option></select></label>
                <label class="vehicle-recent"><input type="checkbox" data-recent-gps> Recent GPS only</label>
                <small>Recent means measured within 90 seconds. Distances are straight-line from your starting point. List filters leave map markers in place.</small>
              </details>
              <label class="route-explorer__field" data-bus-filter hidden>Bus direction<select aria-label="Bus direction"><option value="">All directions</option><option value="INBOUND">Inbound</option><option value="OUTBOUND">Outbound</option><option value="OTHER">Other or unreported</option></select></label>
              <p data-bus-results class="route-explorer__note" role="status" hidden></p>
              <ul data-buses></ul><p data-no-buses class="route-explorer__note">No buses shown for the current map filters.</p>
              <button type="button" data-bus-reset hidden>Reset bus list</button>
            </section>
          </div>
        </div>
      </dialog>`;
    const tabs = [...this.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
    const selectTab = (active: HTMLButtonElement) => {
      for (const tab of tabs) {
        const selected = tab === active;
        tab.setAttribute('aria-selected', String(selected));
        tab.tabIndex = selected ? 0 : -1;
        this.querySelector<HTMLElement>(
          `#${tab.getAttribute('aria-controls')}`
        )!.hidden = !selected;
      }
      this.querySelector<HTMLElement>('.route-explorer__body')!.scrollTop = 0;
    };
    tabs.forEach((tab, index) => {
      tab.addEventListener('click', () => selectTab(tab));
      tab.addEventListener('keydown', (event) => {
        const keys: Record<string, number> = {
          ArrowLeft: 1 - index,
          ArrowRight: 1 - index,
          Home: 0,
          End: 1
        };
        const target = tabs[keys[event.key]];
        if (!target) return;
        event.preventDefault();
        selectTab(target);
        target.focus();
      });
    });
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
    this.querySelector('[data-stop-sort] select')!.addEventListener(
      'change',
      () => this.renderStops()
    );
    this.querySelector('[data-bus-filter] select')!.addEventListener(
      'change',
      () => this.renderVehicles(this.stateManager.getState().activeVehicles)
    );
    const updateBuses = () =>
      this.renderVehicles(this.stateManager.getState().activeVehicles);
    this.querySelector('[data-bus-query]')!.addEventListener(
      'input',
      updateBuses
    );
    this.querySelector('[data-bus-order]')!.addEventListener(
      'change',
      updateBuses
    );
    this.querySelector('[data-recent-gps]')!.addEventListener(
      'change',
      updateBuses
    );
    this.querySelector('[data-bus-reset]')!.addEventListener('click', () => {
      this.resetBusTools();
      updateBuses();
      this.querySelector<HTMLElement>('[data-vehicle-tools] summary')!.focus();
    });
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
      this.resetBusTools();
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
    if (this.querySelector('dialog')!.open) {
      this.renderVehicles(state.activeVehicles);
      this.renderNearestStop();
    }
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
        this.renderVehicles(this.stateManager.getState().activeVehicles);
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
    const origin = this.configuration.getOrigin();
    const canRank =
      !!origin &&
      Number.isFinite(origin.lat) &&
      Math.abs(origin.lat) <= 90 &&
      Number.isFinite(origin.lng) &&
      Math.abs(origin.lng) <= 180;
    const sort = this.querySelector<HTMLSelectElement>(
      '[data-stop-sort] select'
    )!;
    this.querySelector<HTMLElement>('[data-stop-sort]')!.hidden =
      !canRank || !this.stops.length;
    const byDistance = canRank && sort.value === 'distance';
    this.stopListOrigin = origin ? `${origin.lat},${origin.lng}` : '';
    const note = byDistance
      ? 'Straight-line distance from your starting point.'
      : 'Stops are listed alphabetically, not in travel order.';
    this.querySelector('[data-order-note]')!.textContent = this.stops.some(
      (stop) => !stop.routes?.length
    )
      ? note + ' Transfer listings are incomplete.'
      : note;
    const visible = this.stops
      .filter((stop) =>
        [stop.stopName, stop.stopId, ...(stop.routes ?? [])].some((text) =>
          text.toLowerCase().includes(query)
        )
      )
      .map((stop) => ({
        stop,
        meters: byDistance ? distanceMeters(origin, stop) : 0
      }));
    if (byDistance) visible.sort((a, b) => a.meters - b.meters);
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
      ...visible.map(({ stop, meters }) => {
        const item = document.createElement('li');
        const button = document.createElement('button');
        button.type = 'button';
        button.dataset.explorerStop = stop.stopId;
        const name = document.createElement('strong');
        name.textContent = stop.stopName;
        const id = document.createElement('span');
        id.textContent = `Stop ${stop.stopId}`;
        if (byDistance)
          id.textContent +=
            meters < 1000
              ? ' · ' + Math.round(meters) + ' m'
              : ' · ' + (meters / 1000).toFixed(1) + ' km';
        button.append(name, id);
        const transfers = [...new Set(stop.routes ?? [])].filter(
          (route) => route !== this.selectedRoute
        );
        if (transfers.length) {
          const connections = document.createElement('span');
          connections.textContent = 'Transfer to ' + transfers.join(' · ');
          button.append(connections);
        }
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
    if ((origin ? `${origin.lat},${origin.lng}` : '') !== this.stopListOrigin) {
      const focused =
        document.activeElement instanceof HTMLElement
          ? document.activeElement.dataset.explorerStop
          : undefined;
      this.renderStops();
      if (focused)
        [...this.querySelectorAll<HTMLButtonElement>('[data-explorer-stop]')]
          .find((button) => button.dataset.explorerStop === focused)
          ?.focus({ preventScroll: true });
    }
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

  private resetBusTools(): void {
    this.querySelector<HTMLInputElement>('[data-bus-query]')!.value = '';
    this.querySelector<HTMLSelectElement>('[data-bus-order]')!.value = 'feed';
    this.querySelector<HTMLInputElement>('[data-recent-gps]')!.checked = false;
    this.querySelector<HTMLSelectElement>('[data-bus-filter] select')!.value =
      '';
  }

  private renderVehicles(vehicles: IVehicle[]): void {
    const list = this.querySelector<HTMLElement>('[data-buses]')!;
    const directions = this.stateManager.getState().selectedDirections;
    const focused = list.contains(document.activeElement)
      ? (document.activeElement as HTMLElement)
      : null;
    const onMap = [
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
    const busDirection = this.querySelector<HTMLSelectElement>(
      '[data-bus-filter] select'
    )!;
    const group = (v: IVehicle) =>
      v.direction === 'INBOUND' || v.direction === 'OUTBOUND'
        ? v.direction
        : 'OTHER';
    this.querySelector<HTMLElement>('[data-bus-filter]')!.hidden =
      !busDirection.value && new Set(onMap.map(group)).size < 2;
    const origin = this.configuration.getOrigin();
    const canRank =
      origin &&
      Number.isFinite(origin.lat) &&
      Number.isFinite(origin.lng) &&
      Math.abs(origin.lat) <= 90 &&
      Math.abs(origin.lng) <= 180;
    const distances = new Map(
      onMap.map((v) => [
        v.vid,
        canRank &&
        Number.isFinite(v.lat) &&
        Number.isFinite(v.lon) &&
        Math.abs(v.lat) <= 90 &&
        Math.abs(v.lon) <= 180
          ? haversineMeters(origin, { lat: v.lat, lng: v.lon })
          : Infinity
      ])
    );
    const query = this.querySelector<HTMLInputElement>('[data-bus-query]')!
      .value.trim()
      .toLowerCase();
    const order = this.querySelector<HTMLSelectElement>('[data-bus-order]')!;
    order.querySelector<HTMLOptionElement>('[value="near"]')!.disabled =
      !canRank;
    if (!canRank && order.value === 'near') order.value = 'feed';
    const freshOnly =
      this.querySelector<HTMLInputElement>('[data-recent-gps]')!.checked;
    const stopNames = new Map(
      this.stops.map((stop) => [stop.stopId, stop.stopName])
    );
    const now = Date.now();
    const relevant = onMap.filter((v) => {
      const age = now - Date.parse(v.lastUpdate);
      return (
        (!busDirection.value || group(v) === busDirection.value) &&
        (!freshOnly || (v.source === 'live' && age >= 0 && age <= 90000)) &&
        (!query ||
          [v.vid, v.currentStopId, stopNames.get(v.currentStopId ?? '')].some(
            (text) => text?.toLowerCase().includes(query)
          ))
      );
    });
    if (order.value === 'near')
      relevant.sort((a, b) => distances.get(a.vid)! - distances.get(b.vid)!);
    if (order.value === 'recent') {
      const time = (v: IVehicle) => Date.parse(v.lastUpdate) || 0;
      relevant.sort((a, b) => time(b) - time(a));
    }
    const active = Boolean(query || freshOnly || busDirection.value);
    const count = this.querySelector<HTMLElement>('[data-bus-results]')!;
    count.hidden = !active;
    const resultText = `${relevant.length} of ${onMap.length} buses shown`;
    if (count.textContent !== resultText) count.textContent = resultText;
    this.querySelector<HTMLButtonElement>('[data-bus-reset]')!.hidden =
      !active && order.value === 'feed';
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
      const direction = vehicle.direction
        ? vehicle.direction.charAt(0).toUpperCase() +
          vehicle.direction.slice(1).toLowerCase()
        : 'Direction unavailable';
      const status = {
        STOPPED_AT: 'Stopped at a stop',
        INCOMING_AT: 'Approaching a stop',
        IN_TRANSIT_TO: 'Between stops'
      };
      const title = [
        `Bus ${vehicle.vid}`,
        direction,
        vehicle.isDetoured && 'Detour',
        vehicle.currentStatus && status[vehicle.currentStatus]
      ]
        .filter(Boolean)
        .join(' · ');
      const meters = distances.get(vehicle.vid)!;
      const platform =
        vehicle.currentStopId &&
        `Stop ${stopNames.get(vehicle.currentStopId) ? stopNames.get(vehicle.currentStopId) + ' · ' : ''}#${vehicle.currentStopId}`;
      const distance =
        Number.isFinite(meters) &&
        (meters < 1000
          ? Math.round(meters) + ' m'
          : (meters / 1000).toFixed(1) + ' km') + ' from start';
      const detail = [platform, distance, timestamp]
        .filter(Boolean)
        .join(' · ');
      const button = item.querySelector('button')!;
      if (button.textContent !== title + detail) {
        const primary = document.createElement('strong');
        primary.textContent = title;
        const secondary = document.createElement('span');
        secondary.textContent = detail;
        button.replaceChildren(primary, secondary);
      }
      if (list.children[index] !== item)
        list.insertBefore(item, list.children[index] ?? null);
      previous.delete(vehicle.vid);
    }
    previous.forEach((item) => item.remove());
    if (focused?.isConnected && document.activeElement !== focused)
      focused.focus();
    else if (focused && !focused.isConnected)
      this.querySelector<HTMLButtonElement>('[data-close]')!.focus();
    this.querySelector('[data-bus-count]')!.textContent = `(${onMap.length})`;
    const empty = this.querySelector<HTMLElement>('[data-no-buses]')!;
    empty.hidden = relevant.length > 0;
    empty.textContent =
      query || freshOnly
        ? 'No buses match these list filters.'
        : busDirection.value
          ? 'No buses shown in this direction.'
          : 'No buses shown for the current map filters.';
  }
}

customElements.define('route-explorer', RouteExplorer);

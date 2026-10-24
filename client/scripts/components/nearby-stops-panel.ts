import type { ILatLng } from '../../../common/map.interface';
import type {
  INearbyStop,
  IPrediction,
  IStop
} from '../../../common/transit.interface';
import { MapStateManager } from '../state/map-state';
import { transitApiService } from '../services/transit-api.service';
import { getRouteTitle } from '../utils/route-display';
import { showToast } from '../utils/toast';

export interface NearbyStopsContext {
  getCenter(): ILatLng;
  getOrigin(): { position: ILatLng; label: string } | null;
  onSelectStop(stop: IStop): void | Promise<void>;
}

const CAMPUS = { lat: 40.4433, lng: -79.9436 };
const ARRIVAL_LIMIT = 5;
const ARRIVAL_CONCURRENCY = 3;
const REFRESH_MS = 30_000;

function validPosition(point: ILatLng | undefined): point is ILatLng {
  return (
    !!point &&
    Number.isFinite(point.lat) &&
    Number.isFinite(point.lng) &&
    Math.abs(point.lat) <= 90 &&
    Math.abs(point.lng) <= 180
  );
}

/** A list-based discovery path that never changes the rider's GPS or plan. */
export class NearbyStopsPanel extends HTMLElement {
  private context: NearbyStopsContext | null = null;
  private readonly state = MapStateManager.getInstance();
  private unsubscribe: (() => void) | null = null;
  private opened = false;
  private origin = CAMPUS;
  private originLabel = 'CMU Campus · default area';
  private minutes = 10;
  private routeOnly = false;
  private stops: INearbyStop[] = [];
  private version = 0;
  private request: AbortController | null = null;
  private arrivalRequest: AbortController | null = null;
  private refreshTimer: number | null = null;
  private loading = false;
  private filterSignature = '';
  private readonly onEscape = (event: KeyboardEvent): void => {
    if (this.opened && event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      this.close();
    }
  };
  private readonly onVisibility = (): void => {
    if (document.hidden) {
      this.arrivalRequest?.abort();
      this.arrivalRequest = null;
    } else if (this.opened && !this.loading) {
      void this.refreshArrivals();
    }
  };

  configure(context: NearbyStopsContext): void {
    this.context = context;
  }

  connectedCallback(): void {
    this.innerHTML = `
      <button type="button" class="nearby-stops__launch" aria-expanded="false" aria-controls="nearby-stops-sheet">
        <span class="material-icons-outlined" aria-hidden="true">near_me</span> Near me
      </button>
      <dialog id="nearby-stops-sheet" class="nearby-stops__sheet" aria-labelledby="nearby-stops-title">
        <header class="nearby-stops__header"><div><p class="nearby-stops__eyebrow">EXPLORE</p><h2 id="nearby-stops-title">Nearby stops</h2></div><button type="button" class="nearby-stops__close" aria-label="Close nearby stops">×</button></header>
        <p class="nearby-stops__origin"></p>
        <div class="nearby-stops__area-actions"><button type="button" data-action="area">Search this area</button><button type="button" data-action="origin">Use my starting point</button></div>
        <fieldset class="nearby-stops__range"><legend>Walking range estimate</legend><div>${[5, 10, 15].map((minutes) => `<button type="button" data-range="${minutes}" aria-pressed="${minutes === 10}">${minutes} min</button>`).join('')}</div></fieldset>
        <div class="nearby-stops__scope" role="group" aria-label="Routes serving nearby stops"><button type="button" data-scope="all" aria-pressed="true">All routes</button><button type="button" data-scope="route" aria-pressed="false" hidden></button></div>
        <p class="nearby-stops__note">Distances are straight-line estimates. Map transit systems apply.</p>
        <p class="nearby-stops__status" role="status" aria-live="polite"></p>
        <button type="button" class="nearby-stops__retry" hidden>Try again</button>
        <ol class="nearby-stops__list" aria-label="Nearby stops ordered by distance"></ol>
        <p class="nearby-stops__comparison">Next arrivals at the nearest 5 stops refresh every 30 seconds while this list is open.</p>
      </dialog>`;
    this.querySelector('.nearby-stops__launch')?.addEventListener(
      'click',
      () => (this.opened ? this.close() : this.open())
    );
    this.querySelector('.nearby-stops__close')?.addEventListener('click', () =>
      this.close()
    );
    this.querySelector('dialog')?.addEventListener('cancel', (event) => {
      event.preventDefault();
      this.close();
    });
    this.querySelector('[data-action="area"]')?.addEventListener(
      'click',
      () => {
        const center = this.context?.getCenter();
        if (!validPosition(center)) return;
        this.origin = { ...center };
        this.originLabel = 'Current map area';
        void this.loadStops();
      }
    );
    this.querySelector('[data-action="origin"]')?.addEventListener(
      'click',
      () => {
        this.useStartingPoint();
        void this.loadStops();
      }
    );
    this.querySelectorAll<HTMLButtonElement>('[data-range]').forEach(
      (button) => {
        button.addEventListener('click', () => {
          this.minutes = Number(button.dataset.range);
          void this.loadStops();
        });
      }
    );
    this.querySelectorAll<HTMLButtonElement>('[data-scope]').forEach(
      (button) => {
        button.addEventListener('click', () => {
          this.routeOnly = button.dataset.scope === 'route';
          void this.loadStops();
        });
      }
    );
    this.querySelector('.nearby-stops__retry')?.addEventListener(
      'click',
      () => void this.loadStops()
    );
    this.filterSignature = this.currentFilterSignature();
    this.unsubscribe = this.state.subscribe(() => {
      const signature = this.currentFilterSignature();
      if (signature === this.filterSignature) return;
      this.filterSignature = signature;
      if (!this.state.getState().selectedRouteId) this.routeOnly = false;
      if (this.opened) void this.loadStops();
    });
    document.addEventListener('keydown', this.onEscape);
    document.addEventListener('visibilitychange', this.onVisibility);
  }

  disconnectedCallback(): void {
    this.close(false);
    this.unsubscribe?.();
    this.unsubscribe = null;
    document.removeEventListener('keydown', this.onEscape);
    document.removeEventListener('visibilitychange', this.onVisibility);
  }

  open(): void {
    if (this.opened || !this.isConnected) return;
    this.opened = true;
    this.useStartingPoint();
    this.routeOnly = !!this.state.getState().selectedRouteId;
    const sheet = this.querySelector<HTMLDialogElement>(
      '.nearby-stops__sheet'
    )!;
    if (typeof sheet.showModal === 'function') sheet.showModal();
    else sheet.setAttribute('open', '');
    this.querySelector('.nearby-stops__launch')!.setAttribute(
      'aria-expanded',
      'true'
    );
    this.querySelector<HTMLButtonElement>('.nearby-stops__close')!.focus({
      preventScroll: true
    });
    this.refreshTimer = window.setInterval(() => {
      if (!document.hidden && !this.loading) void this.refreshArrivals();
    }, REFRESH_MS);
    void this.loadStops();
  }

  close(restoreFocus = true): void {
    const wasOpen = this.opened;
    this.opened = false;
    this.cancelRequests();
    if (this.refreshTimer !== null) window.clearInterval(this.refreshTimer);
    this.refreshTimer = null;
    const sheet = this.querySelector<HTMLDialogElement>('.nearby-stops__sheet');
    if (sheet?.open) {
      if (typeof sheet.close === 'function') sheet.close();
      else sheet.removeAttribute('open');
    }
    const launch = this.querySelector<HTMLButtonElement>(
      '.nearby-stops__launch'
    );
    launch?.setAttribute('aria-expanded', 'false');
    if (wasOpen && restoreFocus) launch?.focus({ preventScroll: true });
  }

  private useStartingPoint(): void {
    const origin = this.context?.getOrigin();
    if (origin && validPosition(origin.position)) {
      this.origin = { ...origin.position };
      this.originLabel = origin.label;
    } else {
      this.origin = { ...CAMPUS };
      this.originLabel = 'CMU Campus · default area';
    }
  }

  private currentFilterSignature(): string {
    const { selectedSystems, selectedRouteId } = this.state.getState();
    return JSON.stringify([selectedSystems, selectedRouteId]);
  }

  private cancelRequests(): void {
    this.version++;
    this.request?.abort();
    this.arrivalRequest?.abort();
    this.request = null;
    this.arrivalRequest = null;
    this.loading = false;
  }

  private updateControls(): void {
    const routeId = this.state.getState().selectedRouteId;
    this.querySelector('.nearby-stops__origin')!.textContent = this.originLabel;
    this.querySelectorAll<HTMLElement>('[data-range]').forEach((button) => {
      button.setAttribute(
        'aria-pressed',
        String(Number(button.dataset.range) === this.minutes)
      );
    });
    this.querySelector('[data-scope="all"]')!.setAttribute(
      'aria-pressed',
      String(!this.routeOnly)
    );
    const selectedRoute = this.querySelector<HTMLButtonElement>(
      '[data-scope="route"]'
    )!;
    selectedRoute.hidden = !routeId;
    selectedRoute.textContent = routeId ? this.routeTitle(routeId) : '';
    selectedRoute.setAttribute('aria-pressed', String(this.routeOnly));
  }

  private routeTitle(routeId: string): string {
    return getRouteTitle(routeId, this.state.getState().availableRoutes);
  }

  private async loadStops(): Promise<void> {
    if (!this.opened) return;
    this.cancelRequests();
    const version = this.version;
    this.updateControls();
    const list = this.querySelector<HTMLOListElement>('.nearby-stops__list')!;
    const status = this.querySelector<HTMLElement>('.nearby-stops__status')!;
    const retry = this.querySelector<HTMLButtonElement>(
      '.nearby-stops__retry'
    )!;
    list.replaceChildren();
    this.stops = [];
    retry.hidden = true;
    const { selectedSystems, selectedRouteId } = this.state.getState();
    if (!selectedSystems.prt && !selectedSystems.cmu) {
      status.textContent =
        'Turn on PRT or CMU in the map filters to find nearby stops.';
      list.setAttribute('aria-busy', 'false');
      return;
    }
    const system =
      selectedSystems.prt && selectedSystems.cmu
        ? undefined
        : selectedSystems.prt
          ? 'PRT'
          : 'CMU';
    const routeId = this.routeOnly ? (selectedRouteId ?? undefined) : undefined;
    const radiusMeters = Math.round((this.minutes * 1000) / 15);
    const request = new AbortController();
    this.request = request;
    this.loading = true;
    status.textContent = 'Finding nearby stops…';
    list.setAttribute('aria-busy', 'true');
    try {
      const data = await transitApiService.getNearbyStops(
        this.origin.lat,
        this.origin.lng,
        system,
        {
          radiusMeters,
          routeId,
          signal: request.signal
        }
      );
      if (!this.opened || version !== this.version) return;
      if (!data || !Array.isArray(data.stops))
        throw new Error('Nearby stops unavailable');
      const seen = new Set<string>();
      this.stops = data.stops
        .filter((item) => {
          if (
            !item?.stop?.stopId ||
            typeof item.stop.stopName !== 'string' ||
            !validPosition({ lat: item.stop.lat, lng: item.stop.lon }) ||
            !Number.isFinite(item.distanceMeters) ||
            item.distanceMeters < 0 ||
            item.distanceMeters > radiusMeters ||
            seen.has(item.stop.stopId)
          )
            return false;
          seen.add(item.stop.stopId);
          return true;
        })
        .sort(
          (a, b) =>
            a.distanceMeters - b.distanceMeters ||
            a.stop.stopName.localeCompare(b.stop.stopName)
        );
      status.textContent = this.stops.length
        ? `${this.stops.length} ${this.stops.length === 1 ? 'stop' : 'stops'} within about ${this.minutes} minutes’ walk`
        : 'No stops in this range. Try 15 min, All routes, or Search this area.';
      this.renderStops();
      void this.refreshArrivals();
    } catch {
      if (!this.opened || version !== this.version) return;
      status.textContent =
        'Nearby stops could not load. Check your connection and try again.';
      retry.hidden = false;
    } finally {
      if (version === this.version) {
        this.loading = false;
        list.setAttribute('aria-busy', 'false');
        this.request = null;
      }
    }
  }

  private renderStops(): void {
    const list = this.querySelector('.nearby-stops__list')!;
    this.stops.forEach((item, index) => {
      const li = document.createElement('li');
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'nearby-stops__stop';
      button.dataset.stopId = item.stop.stopId;
      const title = document.createElement('strong');
      title.textContent = item.stop.stopName;
      const distance = document.createElement('span');
      distance.className = 'nearby-stops__distance';
      distance.textContent = `${Math.round(item.distanceMeters)} m · ~${Math.max(1, Math.ceil((item.distanceMeters * 15) / 1000))} min walk`;
      const routes = document.createElement('span');
      routes.className = 'nearby-stops__routes';
      const suppliedRoutes = item.routesServingStop ?? item.stop.routes ?? [];
      const routeIds = [
        ...new Set(
          Array.isArray(suppliedRoutes)
            ? suppliedRoutes.filter((id) => typeof id === 'string')
            : []
        )
      ];
      routeIds.slice(0, 5).forEach((id) => {
        const badge = document.createElement('span');
        badge.textContent = this.routeTitle(id);
        routes.append(badge);
      });
      if (routeIds.length > 5) {
        const more = document.createElement('span');
        more.textContent = `+${routeIds.length - 5} more`;
        routes.append(more);
      }
      const arrival = document.createElement('span');
      arrival.className = 'nearby-stops__arrival';
      arrival.dataset.arrivalStop = item.stop.stopId;
      arrival.textContent =
        index < ARRIVAL_LIMIT ? 'Checking next arrival…' : 'Tap for arrivals';
      button.append(title, distance, routes, arrival);
      button.addEventListener('click', () => {
        this.close(false);
        Promise.resolve()
          .then(() => this.context?.onSelectStop(item.stop))
          .catch(() => showToast('Could not open this stop. Try again.'));
      });
      li.append(button);
      list.append(li);
    });
  }

  private async refreshArrivals(): Promise<void> {
    if (
      !this.opened ||
      document.hidden ||
      !this.stops.length ||
      this.arrivalRequest
    )
      return;
    const version = this.version;
    const request = new AbortController();
    this.arrivalRequest = request;
    const candidates = this.stops.slice(0, ARRIVAL_LIMIT);
    const routeId = this.routeOnly
      ? (this.state.getState().selectedRouteId ?? undefined)
      : undefined;
    let cursor = 0;
    const current = () =>
      this.opened && version === this.version && !request.signal.aborted;
    const worker = async () => {
      while (current() && cursor < candidates.length) {
        const stop = candidates[cursor++].stop;
        let predictions: IPrediction[] | null;
        try {
          predictions = await transitApiService.getPredictionsResult(
            stop.stopId,
            routeId,
            request.signal
          );
        } catch {
          predictions = null;
        }
        if (!current()) return;
        const target = [
          ...this.querySelectorAll<HTMLElement>('[data-arrival-stop]')
        ].find((element) => element.dataset.arrivalStop === stop.stopId);
        if (target) target.textContent = this.arrivalLabel(predictions);
      }
    };
    await Promise.all(
      Array.from(
        { length: Math.min(ARRIVAL_CONCURRENCY, candidates.length) },
        () => worker()
      )
    );
    if (this.arrivalRequest === request) this.arrivalRequest = null;
  }

  private arrivalLabel(predictions: IPrediction[] | null): string {
    if (!predictions) return 'Arrival unavailable · tap to retry';
    const next = predictions
      .filter(
        (item) =>
          typeof item?.routeId === 'string' &&
          Number.isFinite(item.predictedArrivalTime) &&
          item.predictedArrivalTime >= Date.now() - 30_000
      )
      .sort((a, b) => a.predictedArrivalTime - b.predictedArrivalTime)[0];
    if (!next) return 'No upcoming arrivals';
    const minutes = Math.max(
      0,
      Math.ceil((next.predictedArrivalTime - Date.now()) / 60_000)
    );
    return `${this.routeTitle(next.routeId)} · ${minutes === 0 ? 'Due' : `${minutes} min`}${next.vid === 'Scheduled' ? ' · scheduled' : ''}${next.isDelayed ? ' · delayed' : ''}`;
  }
}

customElements.define('nearby-stops-panel', NearbyStopsPanel);

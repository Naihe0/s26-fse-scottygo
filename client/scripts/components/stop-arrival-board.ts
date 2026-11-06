import type { IPrediction, IStop } from '../../../common/transit.interface';
import { keyArrivalRows } from '../utils/arrival-identity';
import { DepartureWatch } from './departure-watch';

const PAGE_SIZE = 8;
const localClock = new Intl.DateTimeFormat('en-US', {
  hour: 'numeric',
  minute: '2-digit',
  timeZone: 'America/New_York'
});

function countdown(timestamp: number, now: number): string {
  const seconds = Math.round((timestamp - now) / 1000);
  if (seconds < -60) return 'Estimate passed';
  if (seconds <= 0) return 'Due';
  return seconds < 60 ? `${seconds}s` : `${Math.ceil(seconds / 60)} min`;
}

function validArrivals(rows: IPrediction[]): IPrediction[] {
  return rows.filter(
    (row) =>
      row &&
      typeof row.routeId === 'string' &&
      typeof row.predictedArrivalTime === 'number' &&
      Number.isFinite(new Date(row.predictedArrivalTime).getTime())
  );
}

/** The card and its minimized tab share this state. Filtering changes the
 * visible rows without discarding buses the rider picked for directions. */
export class StopArrivalBoard {
  private host!: HTMLElement;
  private directions!: HTMLButtonElement;
  private selected = new Set<string>();
  private keys: Map<IPrediction, string>;
  private adjustments = new Map<string, number>();
  private view: 'all' | 'first' | 'selected' = 'all';
  private withinMinutes = 0;
  private nextFilterChange = Infinity;
  private route = '';
  private clockTime = false;
  private expanded = false;
  private limit = PAGE_SIZE;
  private checkedAt: number | null;
  private unavailable: boolean;
  private watch?: DepartureWatch;

  constructor(
    private predictions: IPrediction[],
    available: boolean,
    private readonly routeColor: (route: string) => string,
    stop?: Pick<IStop, 'stopId' | 'stopName'>
  ) {
    this.predictions = validArrivals(predictions);
    this.keys = keyArrivalRows(this.predictions);
    this.unavailable = !available;
    this.checkedAt = available ? Date.now() : null;
    if (stop) this.watch = new DepartureWatch(stop, () => {
      this.syncWatchMode();
      const trigger = this.host.querySelector<HTMLButtonElement>('[data-watch-selected]');
      (trigger && !trigger.hidden ? trigger : this.directions).focus({ preventScroll: true });
    });
  }

  get selectedPredictions(): IPrediction[] {
    return this.predictions.filter((p) => this.selected.has(this.keys.get(p)!));
  }

  get selectedKeys(): string[] {
    return this.selectedPredictions.map(p => this.keys.get(p)!);
  }

  get lastCheckedAt(): number | null {
    return this.checkedAt;
  }

  get hasPredictions(): boolean {
    return this.predictions.length > 0;
  }

  mount(host: HTMLElement, directions: HTMLButtonElement): void {
    this.host = host;
    this.directions = directions;
    const scrollTop = host.querySelector('ul')?.scrollTop ?? 0;
    host.innerHTML = `
      <div class="arrival-board__bar">
        <details><summary>Arrivals <span aria-hidden="true">▾</span></summary>
          <div class="arrival-board__options">
            <label data-route-label>Route <select data-route></select></label>
            <label>Show departures <select data-view><option value="all">All departures</option><option value="first">Next per route</option><option value="selected">Selected only</option></select></label>
            <label>Time window <select data-within><option value="0">Any time</option><option value="15">Next 15 minutes</option><option value="30">Next 30 minutes</option><option value="60">Next hour</option></select></label>
            <label><input type="checkbox" data-clock> Pittsburgh clock time</label>
          </div>
        </details>
        <button type="button" data-refresh aria-label="Refresh arrival times"><span data-checked></span><span aria-hidden="true">↻</span></button>
      </div>
      <div class="arrival-board__hint">
        <span>Tap buses to include in directions</span>
        <button type="button" data-clear>Clear selection</button>
      </div>
      <ul class="map-popup__list" aria-label="Upcoming arrivals"></ul>
      <p class="map-popup__empty" hidden>No upcoming arrivals</p>
      <button type="button" data-reset-view hidden>Show all departures</button>
      <button type="button" data-watch-selected hidden>Watch departure</button>
      <section class="departure-watch" hidden></section>`;
    this.watch?.mount(host.querySelector<HTMLElement>('.departure-watch')!);
    host.querySelector('[data-watch-selected]')!.addEventListener('click', () => {
      const row = this.selectedPredictions;
      if (!this.watch || row.length !== 1) return;
      this.watch.start(this.keys.get(row[0])!, row[0]);
      this.syncWatchMode();
    });
    const details = host.querySelector('details')!;
    details.open = this.expanded;
    details.addEventListener('toggle', () => {
      this.expanded = details.open;
    });
    const select = host.querySelector<HTMLSelectElement>('[data-route]')!;
    select.addEventListener('change', () => {
      this.route = select.value;
      this.limit = PAGE_SIZE;
      this.render();
    });
    const view = host.querySelector<HTMLSelectElement>('[data-view]')!;
    const within = host.querySelector<HTMLSelectElement>('[data-within]')!;
    view.value = this.view;
    within.value = String(this.withinMinutes);
    const changeView = () => {
      this.view =
        view.value === 'first' || view.value === 'selected'
          ? view.value
          : 'all';
      this.withinMinutes = Number(within.value);
      this.limit = PAGE_SIZE;
      this.render();
    };
    view.addEventListener('change', changeView);
    within.addEventListener('change', changeView);
    host.querySelector('[data-reset-view]')!.addEventListener('click', () => {
      view.value = 'all';
      within.value = '0';
      this.route = '';
      changeView();
      this.host.querySelector<HTMLElement>('[data-key], summary')?.focus();
    });
    const clock = host.querySelector<HTMLInputElement>('[data-clock]')!;
    clock.checked = this.clockTime;
    clock.addEventListener('change', () => {
      this.clockTime = clock.checked;
      this.tick();
    });
    host.querySelector('[data-clear]')!.addEventListener('click', () => {
      this.selected.clear();
      this.render();
      this.directions.focus({ preventScroll: true });
    });
    this.render();
    this.host.querySelector('ul')!.scrollTop = scrollTop;
  }

  refresh(predictions: IPrediction[]): void {
    const previous = new Map(
      this.predictions.map((p) => [this.keys.get(p), p.predictedArrivalTime])
    );
    this.predictions = validArrivals(predictions);
    this.keys = keyArrivalRows(this.predictions);
    const present = new Set(this.keys.values());
    this.adjustments.clear();
    for (const p of this.predictions) {
      const key = this.keys.get(p)!;
      const oldTime = previous.get(key);
      if (oldTime === undefined) continue;
      const delta = p.predictedArrivalTime - oldTime;
      if (Math.abs(delta) >= 120_000)
        this.adjustments.set(key, Math.round(delta / 60_000));
    }
    this.selected.forEach((k) => {
      if (!present.has(k)) this.selected.delete(k);
    });
    this.checkedAt = Date.now();
    this.unavailable = false;
    this.render();
  }

  setUnavailable(value: boolean): void {
    this.unavailable = value;
    this.syncWatchData();
    const empty = this.host.querySelector<HTMLElement>('.map-popup__empty');
    if (empty) empty.hidden = value;
    this.tick();
  }

  tick(): void {
    this.watch?.tick();
    const now = Date.now();
    if (!this.unavailable && now >= this.nextFilterChange) {
      this.render();
      return;
    }
    this.host.querySelectorAll<HTMLElement>('[data-arrival]').forEach((row) => {
      const timestamp = Number(row.dataset.arrival);
      const time = row.querySelector('time')!;
      const label =
        this.unavailable || this.clockTime
          ? `${localClock.format(timestamp)} ET`
          : countdown(timestamp, now);
      if (time.textContent !== label) time.textContent = label;
    });
  }

  private visibleDepartures(): IPrediction[] {
    const now =
      this.unavailable && this.checkedAt !== null ? this.checkedAt : Date.now();
    this.nextFilterChange = Infinity;
    const windowMs = this.withinMinutes * 60_000;
    const scoped = this.predictions.filter((p) => {
      if (this.route && p.routeId !== this.route) return false;
      if (this.view === 'selected' && !this.selected.has(this.keys.get(p)!))
        return false;
      if (this.view !== 'first' && !windowMs) return true;
      const expires = p.predictedArrivalTime + 60_001;
      if (expires <= now) return false;
      const enters = p.predictedArrivalTime - windowMs;
      if (windowMs && enters > now) {
        this.nextFilterChange = Math.min(this.nextFilterChange, enters);
        return false;
      }
      this.nextFilterChange = Math.min(this.nextFilterChange, expires);
      return true;
    });
    if (this.view !== 'first') return scoped;
    const nextByRoute = new Map<string, IPrediction>();
    for (const p of scoped) {
      const first = nextByRoute.get(p.routeId);
      if (!first || first.predictedArrivalTime > p.predictedArrivalTime)
        nextByRoute.set(p.routeId, p);
    }
    return [...nextByRoute.values()].sort(
      (a, b) => a.predictedArrivalTime - b.predictedArrivalTime
    );
  }

  private render(): void {
    const list = this.host.querySelector<HTMLUListElement>('ul')!;
    const focused = document.activeElement;
    const moreWasFocused =
      list.contains(focused) &&
      focused?.classList.contains('arrival-board__more');
    const focusedKey =
      focused instanceof HTMLElement && list.contains(focused)
        ? focused.dataset.key
        : undefined;
    const scroll = list.scrollTop;
    const select = this.host.querySelector<HTMLSelectElement>('[data-route]')!;
    const routes = [...new Set(this.predictions.map((p) => p.routeId))].sort();
    if (!routes.includes(this.route)) this.route = '';
    const values = ['', ...routes];
    if (
      values.length !== select.options.length ||
      values.some((v, i) => select.options[i]?.value !== v)
    ) {
      select.replaceChildren(
        ...values.map((v) => new Option(v || 'All routes', v))
      );
    }
    select.value = this.route;
    this.host.querySelector<HTMLElement>('[data-route-label]')!.hidden =
      routes.length <= 1;
    const filtered = this.visibleDepartures();
    const visible = filtered.slice(0, this.limit);
    list.replaceChildren(...visible.map((p) => this.createRow(p)));
    if (visible.length < filtered.length) {
      const item = document.createElement('li');
      const more = document.createElement('button');
      more.type = 'button';
      more.className = 'arrival-board__more';
      const nextCount = Math.min(PAGE_SIZE, filtered.length - visible.length);
      more.textContent = `Show ${nextCount} later ${nextCount === 1 ? 'arrival' : 'arrivals'}`;
      more.addEventListener('click', () => {
        this.limit += PAGE_SIZE;
        this.render();
        const rows = list.querySelectorAll<HTMLButtonElement>('[data-key]');
        rows[visible.length]?.focus();
      });
      item.append(more);
      list.append(item);
    }
    const hint = this.host.querySelector<HTMLElement>('.arrival-board__hint')!;
    hint.hidden = !filtered.length;
    let empty = this.host.querySelector<HTMLElement>('.map-popup__empty');
    if (filtered.length) empty?.remove();
    else {
      if (!empty) {
        empty = document.createElement('p');
        empty.className = 'map-popup__empty';
        this.host.append(empty);
      }
      empty.textContent = this.predictions.length
        ? this.view === 'selected'
          ? 'No selected departures in this view.'
          : 'No departures match these filters.'
        : 'No upcoming arrivals';
      empty.hidden = this.unavailable;
    }
    this.host.querySelector<HTMLButtonElement>('[data-reset-view]')!.hidden =
      Boolean(filtered.length) || !this.predictions.length;
    const freshness = this.host.querySelector<HTMLElement>('[data-checked]')!;
    freshness.textContent =
      this.checkedAt === null
        ? 'Refresh'
        : `Checked ${localClock.format(this.checkedAt)} ET`;
    this.syncSelection();
    this.syncWatchData();
    this.tick();
    list.scrollTop = scroll;
    if (focusedKey) {
      const rows = Array.from(
        list.querySelectorAll<HTMLButtonElement>('[data-key]')
      );
      (
        rows.find((row) => row.dataset.key === focusedKey) ?? this.directions
      ).focus({ preventScroll: true });
    } else if (moreWasFocused) {
      (
        list.querySelector<HTMLButtonElement>('.arrival-board__more') ??
        this.directions
      ).focus({ preventScroll: true });
    }
  }

  private createRow(p: IPrediction): HTMLElement {
    const li = document.createElement('li');
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'map-popup__arrival map-popup__arrival--selectable';
    row.dataset.arrival = String(p.predictedArrivalTime);
    const key = this.keys.get(p)!;
    row.dataset.key = key;
    const route = document.createElement('span');
    route.className = 'map-popup__route-badge';
    route.style.backgroundColor = this.routeColor(p.routeId);
    route.textContent = p.routeId;
    const time = document.createElement('time');
    time.className = 'map-popup__minutes';
    time.dateTime = new Date(p.predictedArrivalTime).toISOString();
    const meta = document.createElement('span');
    meta.className = 'map-popup__meta';
    meta.textContent = [
      p.vid === 'Scheduled' ? 'Scheduled' : p.vid ? `Bus ${p.vid}` : '',
      p.isDelayed ? 'Delayed' : ''
    ]
      .filter(Boolean)
      .join(' · ');
    row.append(route, time, meta);
    const delta = this.adjustments.get(key);
    if (delta !== undefined) {
      const change = document.createElement('small');
      change.className = 'arrival-board__change';
      change.textContent = `Updated · ${Math.abs(delta)} min ${delta < 0 ? 'earlier' : 'later'}`;
      row.append(change);
    }
    row.addEventListener('click', () => {
      if (this.selected.has(key)) this.selected.delete(key);
      else this.selected.add(key);
      if (this.view === 'selected') this.render();
      else this.syncSelection();
    });
    li.append(row);
    return li;
  }

  private syncSelection(): void {
    this.host.querySelectorAll<HTMLElement>('[data-key]').forEach((row) => {
      const selected = this.selected.has(row.dataset.key!);
      row.setAttribute('aria-pressed', String(selected));
      row.classList.toggle('map-popup__arrival--selected', selected);
    });
    const count = this.selected.size;
    this.host.querySelector<HTMLButtonElement>('[data-watch-selected]')!.hidden = !this.watch || count !== 1;
    this.host.querySelector<HTMLButtonElement>('[data-clear]')!.hidden =
      count === 0;
    this.directions.querySelector('[data-directions-label]')!.textContent =
      count
        ? `Directions (${count} ${count === 1 ? 'bus' : 'buses'})`
        : 'Directions';
  }

  /** A restored/foreground card must fetch current arrivals before reminders resume. */
  setActive(active: boolean): void { this.watch?.setActive(active); }

  private syncWatchData(): void {
    this.watch?.update(new Map(this.predictions.map(p => [this.keys.get(p)!, p])), !this.unavailable, this.checkedAt);
    this.syncWatchMode();
  }

  private syncWatchMode(): void {
    const watching = Boolean(this.watch?.isWatching);
    this.host.dataset.watching = String(watching);
    this.host.closest('.map-popup')?.classList.toggle('map-popup--watching', watching);
  }
}

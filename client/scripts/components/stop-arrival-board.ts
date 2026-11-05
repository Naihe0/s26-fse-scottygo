import type { IPrediction } from '../../../common/transit.interface';

const PAGE_SIZE = 8;
const localClock = new Intl.DateTimeFormat('en-US', {
  hour: 'numeric',
  minute: '2-digit',
  timeZone: 'America/New_York'
});

function identity(p: IPrediction): string {
  return JSON.stringify([
    p.stopId,
    p.routeId,
    p.vid && p.vid !== 'Scheduled' ? p.vid : p.predictedArrivalTime
  ]);
}

function countdown(timestamp: number, now: number): string {
  const seconds = Math.round((timestamp - now) / 1000);
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
  private route = '';
  private clockTime = false;
  private expanded = false;
  private limit = PAGE_SIZE;
  private checkedAt: number | null;
  private unavailable: boolean;

  constructor(
    private predictions: IPrediction[],
    available: boolean,
    private readonly routeColor: (route: string) => string
  ) {
    this.predictions = validArrivals(predictions);
    this.unavailable = !available;
    this.checkedAt = available ? Date.now() : null;
  }

  get selectedPredictions(): IPrediction[] {
    return this.predictions.filter((p) => this.selected.has(identity(p)));
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
      <p class="map-popup__empty" hidden>No upcoming arrivals</p>`;
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
    this.predictions = validArrivals(predictions);
    const present = new Set(this.predictions.map(identity));
    this.selected.forEach((k) => {
      if (!present.has(k)) this.selected.delete(k);
    });
    this.checkedAt = Date.now();
    this.unavailable = false;
    this.render();
  }

  setUnavailable(value: boolean): void {
    this.unavailable = value;
    const empty = this.host.querySelector<HTMLElement>('.map-popup__empty');
    if (empty) empty.hidden = value;
    this.tick();
  }

  tick(): void {
    const now = Date.now();
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
    const filtered = this.predictions.filter(
      (p) => !this.route || p.routeId === this.route
    );
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
        list
          .querySelectorAll<HTMLButtonElement>('[data-key]')
          [visible.length]?.focus();
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
      empty.textContent = 'No upcoming arrivals';
      empty.hidden = this.unavailable;
    }
    const freshness = this.host.querySelector<HTMLElement>('[data-checked]')!;
    freshness.textContent =
      this.checkedAt === null
        ? 'Refresh'
        : `Checked ${localClock.format(this.checkedAt)} ET`;
    this.syncSelection();
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
    row.dataset.key = identity(p);
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
    row.addEventListener('click', () => {
      const key = identity(p);
      if (this.selected.has(key)) this.selected.delete(key);
      else this.selected.add(key);
      this.syncSelection();
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
    this.host.querySelector<HTMLButtonElement>('[data-clear]')!.hidden =
      count === 0;
    this.directions.querySelector('[data-directions-label]')!.textContent =
      count
        ? `Directions (${count} ${count === 1 ? 'bus' : 'buses'})`
        : 'Directions';
  }
}

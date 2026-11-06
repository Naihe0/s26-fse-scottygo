import type { IPrediction, IStop } from '../../../common/transit.interface';
import { shareDepartureSummary } from '../utils/share-departure';
import { showToast } from '../utils/toast';

const clock = new Intl.DateTimeFormat('en-US', {
  hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York'
});
const setText = (node: Element, text: string) => {
  if (node.textContent !== text) node.textContent = text;
};

/** One chosen visit, independent of the departures selected for walking.
 * Uses the existing stop ticker; holds its identity across ETA corrections. */
export class DepartureWatch {
  private host?: HTMLElement;
  private watched?: { key: string; row: IPrediction };
  private rows = new Map<string, IPrediction>();
  private available = false;
  private checkedAt: number | null = null;
  private active = true;
  private reminder = 0;
  private fired = false;
  private reminderNeedsReceipt = false;

  constructor(
    private stop: Pick<IStop, 'stopId' | 'stopName'>,
    private onBack: () => void
  ) {}

  get isWatching(): boolean { return Boolean(this.watched); }

  mount(host: HTMLElement): void {
    this.host = host;
    host.className = 'departure-watch';
    host.innerHTML = `
      <div class="departure-watch__heading"><strong data-watch-title></strong><button type="button" data-watch-back>All arrivals</button></div>
      <p class="departure-watch__caption">Estimated arrival</p>
      <strong class="departure-watch__countdown" data-watch-countdown aria-live="off" tabindex="-1"></strong>
      <p class="departure-watch__clock" data-watch-clock></p>
      <p class="departure-watch__status" data-watch-status role="status" aria-atomic="true"></p>
      <label class="departure-watch__reminder">On-screen reminder<select data-watch-reminder><option value="0">Off</option><option value="2">2 min before</option><option value="5">5 min before</option></select></label>
      <div class="departure-watch__actions"><button type="button" data-watch-next>Next departure</button><button type="button" data-watch-share>Share departure</button></div>
      <p class="departure-watch__note">Reminders work while this card is open.</p>`;
    host.querySelector('[data-watch-back]')!.addEventListener('click', () => this.close());
    host.addEventListener('keydown', event => {
      if (event.key === 'Escape' && !event.isComposing && this.watched) {
        event.preventDefault();
        event.stopPropagation();
        this.close();
      }
    });
    const select = host.querySelector<HTMLSelectElement>('[data-watch-reminder]')!;
    select.value = String(this.reminder);
    select.addEventListener('change', () => {
      const minutes = select.value === '2' ? 2 : select.value === '5' ? 5 : 0;
      if (minutes !== this.reminder) { this.fired = false; this.reminderNeedsReceipt = false; }
      this.reminder = minutes;
      this.tick();
    });
    host.querySelector('[data-watch-next]')!.addEventListener('click', () => {
      const next = this.next();
      if (!this.ready() || !next) return;
      this.watched = { key: next[0], row: next[1] };
      this.fired = false;
      this.reminderNeedsReceipt = false;
      this.tick();
      host.querySelector<HTMLElement>('[data-watch-countdown]')!.focus();
    });
    const share = host.querySelector<HTMLButtonElement>('[data-watch-share]')!;
    share.addEventListener('click', () => {
      if (!this.watched) return;
      void shareDepartureSummary(this.watched.row, this.stop, {
        available: this.ready(), missing: !this.rows.has(this.watched.key),
        checkedAt: this.checkedAt
      }, share, showToast);
    });
    this.tick();
  }

  start(key: string, row: IPrediction): void {
    this.watched = { key, row };
    this.reminder = 0;
    this.fired = false;
    this.reminderNeedsReceipt = false;
    if (this.host) this.host.querySelector<HTMLSelectElement>('[data-watch-reminder]')!.value = '0';
    this.tick();
    this.host?.querySelector<HTMLElement>('[data-watch-countdown]')?.focus();
  }

  close(): void {
    this.watched = undefined;
    this.reminder = 0;
    this.fired = false;
    this.reminderNeedsReceipt = false;
    this.tick();
    this.onBack();
  }

  update(rows: Map<string, IPrediction>, available: boolean, checkedAt: number | null): void {
    this.rows = rows;
    this.available = available;
    this.checkedAt = checkedAt;
    const current = this.watched && rows.get(this.watched.key);
    if (this.fired && (!available || !current || current.predictedArrivalTime !== this.watched?.row.predictedArrivalTime))
      this.reminderNeedsReceipt = true;
    if (current && this.watched) this.watched.row = current;
    this.tick();
  }

  setActive(active: boolean): void {
    if (!active && this.fired) this.reminderNeedsReceipt = true;
    this.active = active;
    this.tick();
  }

  private ready(): boolean {
    return this.active && this.available && Boolean(this.host?.isConnected) && !document.hidden &&
      this.checkedAt !== null && Date.now() - this.checkedAt <= 90_000;
  }

  private next(): [string, IPrediction] | undefined {
    if (!this.watched) return;
    const { row, key } = this.watched;
    return [...this.rows].filter(([candidate, p]) => candidate !== key &&
      p.routeId === row.routeId && p.stopId === row.stopId &&
      p.predictedArrivalTime > Math.max(Date.now(), row.predictedArrivalTime))
      .sort((a, b) => a[1].predictedArrivalTime - b[1].predictedArrivalTime)[0];
  }

  tick(): void {
    const host = this.host;
    if (!host) return;
    host.hidden = !this.watched;
    if (!this.watched) return;
    const { key, row } = this.watched;
    const missing = !this.rows.has(key);
    const ready = this.ready() && !missing;
    if (!ready && this.fired) this.reminderNeedsReceipt = true;
    const remaining = row.predictedArrivalTime - Date.now();
    const seconds = Math.ceil(remaining / 1000);
    const time = seconds < -60 ? 'Estimate passed' : seconds <= 0 ? 'Due' :
      seconds < 60 ? `${seconds}s` : `${Math.ceil(seconds / 60)} min`;
    setText(host.querySelector('[data-watch-title]')!, `Route ${row.routeId}${row.vid && row.vid !== 'Scheduled' ? ' · Bus ' + row.vid : ''}`);
    setText(host.querySelector('[data-watch-countdown]')!, ready ? time : '—');
    setText(host.querySelector('[data-watch-clock]')!, `${ready ? '' : 'Last shown · '}${clock.format(row.predictedArrivalTime)} ET${row.vid === 'Scheduled' ? ' · Scheduled' : ''}`);
    const reminder = host.querySelector<HTMLSelectElement>('[data-watch-reminder]')!;
    reminder.disabled = !ready;
    let status = missing ? 'No longer in the latest arrivals. Choose another departure or refresh.' :
      !ready ? `Waiting for fresh arrival times.${this.reminder ? ' Reminder paused.' : ''}` :
      this.fired ? this.reminderNeedsReceipt ? 'Reminder already shown. Check the updated estimate above.' : `Route ${row.routeId} is expected within ${this.reminder} min.` :
      this.reminder ? `Reminder set for ${this.reminder} min before the estimate.` : 'Times may change as the bus approaches.';
    if (ready && this.reminder && !this.fired && remaining >= 0 && remaining <= this.reminder * 60_000) {
      this.fired = true;
      status = `Route ${row.routeId} is expected within ${this.reminder} min.`;
    }
    if (ready && remaining < -60_000) status = 'This estimate has passed. Check the latest arrivals.';
    const statusNode = host.querySelector<HTMLElement>('[data-watch-status]')!;
    statusNode.dataset.reminded = String(this.fired && ready);
    setText(statusNode, status);
    host.querySelector<HTMLButtonElement>('[data-watch-next]')!.disabled = !this.ready() || !this.next();
  }
}


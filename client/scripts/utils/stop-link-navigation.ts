import type { IStop } from '../../../common/transit.interface';
import { authHeaders, getToken, isSameSession } from '../services/session';
import { validShortcutStopId } from './rider-shortcuts';

export interface SharedStopNavigationOptions {
  openStop(stop: IStop): void | Promise<void>;
  onError(message: string, retry: () => Promise<void>): void;
}

const DEADLINE_MS = 15_000;
const record = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

function readStop(value: unknown, expectedId: string): IStop | null {
  if (
    !record(value) ||
    value.stopId !== expectedId ||
    !validShortcutStopId(value.stopId) ||
    typeof value.stopName !== 'string' ||
    !value.stopName.trim() ||
    value.stopName.length > 300
  )
    return null;
  if (
    typeof value.lat !== 'number' ||
    typeof value.lon !== 'number' ||
    !Number.isFinite(value.lat) ||
    !Number.isFinite(value.lon) ||
    Math.abs(value.lat) > 90 ||
    Math.abs(value.lon) > 180
  )
    return null;
  const strings = (items: unknown) =>
    Array.isArray(items)
      ? items
          .filter(
            (item): item is string =>
              typeof item === 'string' && item.length <= 160
          )
          .slice(0, 30)
      : [];
  return {
    stopId: value.stopId,
    stopName: value.stopName.trim(),
    lat: value.lat,
    lon: value.lon,
    routes: strings(value.routes),
    dtradd: strings(value.dtradd),
    dtrrem: strings(value.dtrrem)
  };
}

/** Resolves shared and saved stops against current transit data before opening them. */
export class SharedStopNavigation {
  private generation = 0;
  private controller: AbortController | null = null;

  constructor(private readonly options: SharedStopNavigationOptions) {}

  cancel(): void {
    this.generation += 1;
    this.controller?.abort();
    this.controller = null;
  }

  async open(stopId: string): Promise<void> {
    this.cancel();
    const generation = this.generation;
    const token = getToken();
    const current = () =>
      generation === this.generation && isSameSession(token);
    const retry = async () => {
      if (current()) await this.open(stopId);
    };
    if (!validShortcutStopId(stopId)) {
      this.options.onError(
        'This stop link is not valid. Choose a stop from map search.',
        retry
      );
      return;
    }
    const controller = new AbortController();
    this.controller = controller;
    let timedOut = false;
    let rejectAbort: (() => void) | null = null;
    const aborted = new Promise<never>((_resolve, reject) => {
      rejectAbort = () =>
        reject(new DOMException('Stop lookup cancelled', 'AbortError'));
      controller.signal.addEventListener('abort', rejectAbort, { once: true });
    });
    const timer = window.setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, DEADLINE_MS);
    try {
      const response = await Promise.race([
        fetch(`/search?q=${encodeURIComponent(stopId)}`, {
          headers: authHeaders(),
          signal: controller.signal
        }),
        aborted
      ]);
      if (!current()) return;
      if (!response.ok) {
        const message =
          response.status === 401
            ? 'Sign in again to open this stop.'
            : 'Could not load this stop. Try again.';
        this.options.onError(message, retry);
        return;
      }
      const body: unknown = await Promise.race([response.json(), aborted]);
      if (!current()) return;
      if (
        !record(body) ||
        body.name !== 'SearchTransitCompleted' ||
        !record(body.payload) ||
        !Array.isArray(body.payload.stops)
      )
        throw new Error('Invalid stop search response');
      const stop = body.payload.stops
        .map((item) => readStop(item, stopId))
        .find((item) => item !== null);
      if (!stop) {
        this.options.onError(
          'This stop is unavailable in the current transit data. Try again or search for a nearby stop.',
          retry
        );
        return;
      }
      window.clearTimeout(timer);
      await this.options.openStop(stop);
    } catch {
      if (!current() || (controller.signal.aborted && !timedOut)) return;
      this.options.onError(
        timedOut
          ? 'Loading this stop took too long. Try again.'
          : 'Could not load this stop. Check your connection and try again.',
        retry
      );
    } finally {
      window.clearTimeout(timer);
      if (rejectAbort)
        controller.signal.removeEventListener('abort', rejectAbort);
      if (this.controller === controller) this.controller = null;
    }
  }
}

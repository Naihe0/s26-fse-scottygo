/**
 * GTFS-RT Service Alerts Service
 *
 * Fetches the PRT GTFS-RT alerts protobuf feed and stores decoded alerts
 * in memory. Alerts are refreshed periodically (every 5 minutes).
 *
 * Public access:
 *   alertsService.getAlerts()  → IServiceAlert[]
 *   alertsService.start()      — begins the polling loop
 *   alertsService.stop()       — clears the interval
 */

import { transit_realtime } from 'gtfs-realtime-bindings';
import { IServiceAlert } from '../../common/transit.interface';

const GTFSRT_ALERTS_URL =
  'https://truetime.portauthority.org/gtfsrt-bus/alerts';

/** How often we re-fetch the alert feed (milliseconds). */
const POLL_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

function tag(): string {
  return `[AlertsService ${new Date().toISOString()}]`;
}

class AlertsService {
  private alerts: IServiceAlert[] = [];

  private intervalId: ReturnType<typeof setInterval> | null = null;

  private fetchInProgress = false;

  private lastError: string | null = null;

  private healthy = false;

  private isStopping = false;

  private fetchAbortController: AbortController | null = null;

  // ── Public API ───────────────────────────────────────────────────────

  getAlerts(): IServiceAlert[] {
    return this.alerts;
  }

  isHealthy(): boolean {
    return this.healthy;
  }

  getLastError(): string | null {
    return this.lastError;
  }

  /**
   * Returns the previous alerts so the caller can diff for changes.
   */
  start(): void {
    if (this.intervalId) return;
    this.isStopping = false;
    console.log(
      `${tag()} Starting alert feed polling (every ${POLL_INTERVAL_MS / 1000}s)`
    );

    // Initial fetch
    this.fetchAlerts().catch(() => {});

    this.intervalId = setInterval(() => {
      if (!this.fetchInProgress) {
        this.fetchAlerts().catch(() => {});
      }
    }, POLL_INTERVAL_MS);

    this.intervalId.unref?.();
  }

  stop(): void {
    this.isStopping = true;
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      console.log(`${tag()} Stopped alert feed polling`);
    }
    this.fetchAbortController?.abort();
    this.fetchAbortController = null;
  }

  /**
   * Callback invoked when alerts change. Set by the app to push via Socket.io.
   */
  onAlertsChanged: ((alerts: IServiceAlert[]) => void) | null = null;

  // ── Private ──────────────────────────────────────────────────────────

  private async fetchAlerts(): Promise<void> {
    if (this.isStopping) {
      return;
    }

    const abortController = new AbortController();
    this.fetchAbortController = abortController;
    this.fetchInProgress = true;
    const deadline = setTimeout(() => abortController.abort(), 15_000);
    deadline.unref?.();

    try {
      const response = await fetch(GTFSRT_ALERTS_URL, {
        signal: abortController.signal
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${response.statusText}`);
      }

      const buffer = await response.arrayBuffer();
      const feed = transit_realtime.FeedMessage.decode(new Uint8Array(buffer));

      const newAlerts: IServiceAlert[] = [];
      for (const entity of feed.entity) {
        const decoded = this.decodeAlertEntity(entity);
        if (decoded) newAlerts.push(decoded);
      }

      if (
        !this.isStopping &&
        !abortController.signal.aborted &&
        this.fetchAbortController === abortController
      )
        this.applyFetchedAlerts(newAlerts);
    } catch (err) {
      if (this.fetchAbortController === abortController)
        this.handleFetchError(err);
    } finally {
      clearTimeout(deadline);
      if (this.fetchAbortController === abortController) {
        this.fetchAbortController = null;
        this.fetchInProgress = false;
      }
    }
  }

  private decodeAlertEntity(
    entity: transit_realtime.IFeedEntity
  ): IServiceAlert | null {
    if (!entity.alert) return null;

    const alert = entity.alert;

    const headerText = alert.headerText?.translation?.[0]?.text ?? '';
    const descriptionText = alert.descriptionText?.translation?.[0]?.text ?? '';

    return {
      id: entity.id,
      headerText,
      descriptionText,
      routeIds: this.decodeRouteIds(alert),
      activePeriods: this.decodeActivePeriods(alert)
    };
  }

  private decodeRouteIds(alert: transit_realtime.IAlert): string[] {
    const routeIds: string[] = [];
    if (alert.informedEntity) {
      for (const ie of alert.informedEntity) {
        if (ie.routeId) {
          routeIds.push(ie.routeId);
        }
      }
    }
    return routeIds;
  }

  private decodeActivePeriods(
    alert: transit_realtime.IAlert
  ): { start: string; end: string }[] {
    const activePeriods: { start: string; end: string }[] = [];
    if (alert.activePeriod) {
      for (const ap of alert.activePeriod) {
        activePeriods.push({
          start: ap.start
            ? new Date(Number(ap.start) * 1000).toISOString()
            : '',
          end: ap.end ? new Date(Number(ap.end) * 1000).toISOString() : ''
        });
      }
    }
    return activePeriods;
  }

  private applyFetchedAlerts(newAlerts: IServiceAlert[]): void {
    const changed = JSON.stringify(newAlerts) !== JSON.stringify(this.alerts);

    this.alerts = newAlerts;
    this.healthy = true;
    this.lastError = null;

    if (changed && this.onAlertsChanged) {
      this.onAlertsChanged(newAlerts);
    }

    if (!this.isStopping) {
      console.log(`${tag()} Fetched ${newAlerts.length} service alerts`);
    }
  }

  private handleFetchError(err: unknown): void {
    const isAbortError =
      typeof err === 'object' &&
      err !== null &&
      'name' in err &&
      err.name === 'AbortError';

    if (this.isStopping) {
      return;
    }

    this.healthy = false;
    this.lastError = isAbortError
      ? 'Alert feed request timed out'
      : err instanceof Error
        ? err.message
        : 'Unknown error fetching alerts';
    console.error(`${tag()} Failed to fetch alerts:`, this.lastError);
  }
}

const alertsService = new AlertsService();
export default alertsService;

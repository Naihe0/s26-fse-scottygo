/**
 * GTFS-RT Service Alerts Service
 *
 * Polls the PRT GTFS-RT alerts protobuf feed every five minutes and keeps the
 * decoded alerts in memory. onAlertsChanged fires when the snapshot changes.
 */

import { transit_realtime } from 'gtfs-realtime-bindings';
import { IServiceAlert } from '../../common/transit.interface';
import { PollingFeed } from './polling-feed';

const GTFSRT_ALERTS_URL =
  'https://truetime.portauthority.org/gtfsrt-bus/alerts';

const SEVERITY_LEVELS: ReadonlySet<string> = new Set([
  'INFO',
  'WARNING',
  'SEVERE'
]);

/** Prefer English, then an untagged translation, then any non-empty one. */
function translatedText(
  value?: transit_realtime.ITranslatedString | null
): string {
  const translations =
    value?.translation?.filter((item) => item.text?.trim()) ?? [];
  const chosen =
    translations.find((item) => /^en(?:-|$)/i.test(item.language ?? '')) ??
    translations.find((item) => !item.language) ??
    translations[0];
  return chosen?.text?.trim() ?? '';
}

/** Accept only plain HTTP(S) links without embedded credentials. */
function alertUrl(value: string): string | undefined {
  if (!/^https?:\/\//i.test(value) || /[\s<>]/.test(value)) return undefined;
  try {
    const url = new URL(value);
    return url.username || url.password ? undefined : url.href;
  } catch {
    return undefined;
  }
}

/** Name of an explicitly supplied enum value; unknown/other values are omitted. */
function enumName(
  alert: transit_realtime.IAlert,
  key: 'effect' | 'cause' | 'severityLevel',
  names: Record<string, string | number>
): string | undefined {
  // Protobuf defaults are inherited even when the agency omitted the field.
  if (!Object.prototype.hasOwnProperty.call(alert, key)) return undefined;
  const value = alert[key];
  const name = typeof value === 'number' ? names[value] : undefined;
  return typeof name === 'string' &&
    !name.startsWith('UNKNOWN_') &&
    !name.startsWith('OTHER_')
    ? name
    : undefined;
}

/** ISO time for a period endpoint: '' when open-ended, null when invalid. */
function periodTime(
  period: transit_realtime.ITimeRange,
  key: 'start' | 'end'
): string | null {
  if (!Object.prototype.hasOwnProperty.call(period, key) || period[key] == null)
    return '';
  const seconds = Number(period[key]);
  const date = new Date(seconds * 1000);
  return Number.isSafeInteger(seconds) &&
    seconds >= 0 &&
    Number.isFinite(date.getTime())
    ? date.toISOString()
    : null;
}

function activePeriods(
  alert: transit_realtime.IAlert
): IServiceAlert['activePeriods'] {
  const periods: IServiceAlert['activePeriods'] = [];
  for (const period of alert.activePeriod ?? []) {
    const start = periodTime(period, 'start');
    const end = periodTime(period, 'end');
    // Ignore malformed ranges without losing all other alerts in the feed.
    if (start === null || end === null || (start && end && start >= end))
      continue;
    periods.push({ start, end });
  }
  return periods;
}

function routeIds(alert: transit_realtime.IAlert): string[] {
  const ids = (alert.informedEntity ?? [])
    .map((entity) => entity.routeId)
    .filter((id): id is string => !!id);
  return [...new Set(ids)];
}

/** Decode one feed entity, or return null when it carries no alert. */
export function decodeAlertEntity(
  entity: transit_realtime.IFeedEntity
): IServiceAlert | null {
  const alert = entity.alert;
  if (!alert) return null;

  const url = alertUrl(translatedText(alert.url));
  const effect = enumName(alert, 'effect', transit_realtime.Alert.Effect);
  const cause = enumName(alert, 'cause', transit_realtime.Alert.Cause);
  const severity = enumName(
    alert,
    'severityLevel',
    transit_realtime.Alert.SeverityLevel
  );

  return {
    id: entity.id,
    headerText: translatedText(alert.headerText),
    descriptionText: translatedText(alert.descriptionText),
    routeIds: routeIds(alert),
    activePeriods: activePeriods(alert),
    ...(url ? { url } : {}),
    ...(effect ? { effect } : {}),
    ...(cause ? { cause } : {}),
    ...(severity && SEVERITY_LEVELS.has(severity)
      ? { severityLevel: severity as IServiceAlert['severityLevel'] }
      : {})
  };
}

export class AlertsService extends PollingFeed<IServiceAlert[]> {
  private alerts: IServiceAlert[] = [];

  /** Set by the app to push changed snapshots to connected clients. */
  onAlertsChanged: ((alerts: IServiceAlert[]) => void) | null = null;

  constructor() {
    super({
      name: 'AlertsService',
      intervalMs: 5 * 60_000,
      timeoutMs: 15_000,
      maxAgeMs: 15 * 60_000
    });
  }

  getAlerts(): IServiceAlert[] {
    return this.alerts;
  }

  protected async fetchSnapshot(
    signal: AbortSignal
  ): Promise<IServiceAlert[]> {
    const response = await this.fetchOk(GTFSRT_ALERTS_URL, signal);
    const feed = transit_realtime.FeedMessage.decode(
      new Uint8Array(await response.arrayBuffer())
    );
    return feed.entity
      .map(decodeAlertEntity)
      .filter((alert): alert is IServiceAlert => alert !== null);
  }

  protected applySnapshot(alerts: IServiceAlert[]): void {
    const changed = JSON.stringify(alerts) !== JSON.stringify(this.alerts);
    this.alerts = alerts;
    if (changed) this.onAlertsChanged?.(alerts);
    this.log.info(`Fetched ${alerts.length} service alerts`);
  }
}

const alertsService = new AlertsService();
export default alertsService;

import type { IPrediction, IStop } from '../../../common/transit.interface';
import { publicStopPath } from './public-stop-path';
import { copyViewLink } from './copy-view-link';
import { shareTransitLink } from './share-transit-link';

export interface DepartureFreshness {
  available: boolean;
  missing: boolean;
  /** Last successful check, not the time of an unsuccessful refresh attempt. */
  checkedAt: number | null;
}

type DepartureStop = Pick<IStop, 'stopId' | 'stopName'>;
interface DepartureSummary {
  title: string;
  text: string;
  url: string;
}
const clock = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  year: 'numeric',
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
  timeZoneName: 'short'
});
const plain = (value: unknown, limit: number) =>
  typeof value === 'string'
    ? value.replace(/\s+/g, ' ').trim().slice(0, limit)
    : '';
const formatClock = (value: number | null) =>
  typeof value === 'number' && Number.isFinite(new Date(value).getTime())
    ? clock.format(value)
    : null;

/** A point-in-time estimate and public platform link, with no rider state. */
export function buildDepartureSummary(
  prediction: IPrediction,
  stop: DepartureStop,
  freshness: DepartureFreshness,
  base = window.location.href
): DepartureSummary | null {
  if (prediction.stopId !== stop.stopId) return null;
  const path = publicStopPath(stop.stopId);
  const route = plain(prediction.routeId, 80);
  if (!path || !route) return null;
  let url: string;
  try {
    const source = new URL(base);
    if (!['http:', 'https:'].includes(source.protocol)) return null;
    url = new URL(path, source.origin).href;
  } catch {
    return null;
  }
  const bus = plain(prediction.vid, 80);
  const scheduled = bus.toLowerCase() === 'scheduled';
  const vehicle =
    bus && !scheduled ? ` · Bus ${bus}` : '';
  const stopName = plain(stop.stopName, 180) || 'Platform';
  const qualifier = freshness.missing
    ? `No longer in current arrivals. Last shown ${scheduled ? 'scheduled time' : 'estimate'}`
    : freshness.available
      ? scheduled ? 'Scheduled time' : 'Live estimate'
      : scheduled ? 'Last known scheduled time' : 'Last known estimate';
  const text = [
    `Route ${route}${vehicle}`,
    `${stopName} · Stop ${stop.stopId}`,
    `${qualifier}: ${formatClock(prediction.predictedArrivalTime) ?? 'time unavailable'}`,
    `Checked: ${formatClock(freshness.checkedAt) ?? 'not recorded'}`,
    'Times are estimates in Pittsburgh time and can change.'
  ].join('\n');
  return { title: 'ScottyGo departure', text, url };
}

/** Called directly from the share button; no await before the native share call. */
export async function shareDepartureSummary(
  prediction: IPrediction,
  stop: DepartureStop,
  freshness: DepartureFreshness,
  trigger: HTMLButtonElement,
  announce: (message: string) => void
): Promise<void> {
  if (trigger.disabled) return;
  const summary = buildDepartureSummary(prediction, stop, freshness);
  if (!summary) {
    announce('This departure cannot be shared yet.');
    return;
  }
  await shareTransitLink(
    summary.url,
    summary.title,
    trigger,
    () =>
      copyViewLink(`${summary.text}\n${summary.url}`, trigger, announce, {
        title: 'Copy departure details',
        description: 'Select and copy this estimate and stop link.',
        label: 'Departure summary',
        copiedMessage: 'Departure details and stop link copied.',
        unavailableMessage: 'Copy the details in the dialog.',
        multiline: true
      }),
    summary.text
  );
}

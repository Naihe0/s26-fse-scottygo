import type {
  INotification,
  IServiceAlert
} from '../../../common/transit.interface';
import type { IRouteDisplay } from './route-display';
import {
  appendLinkedText,
  formatAlertMetadata,
  formatNotificationTime,
  notificationTopics,
  routeMapUrl,
  safeHttpUrl
} from './alert-content';

type RouteResolver = (routeId: string) => IRouteDisplay;

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  text?: string
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function appendDescription(
  card: HTMLElement,
  text: string,
  label: string
): void {
  if (!text.trim()) return;
  const body = element('p', 'notif-body');
  appendLinkedText(body, text);
  if (text.length <= 320) {
    card.append(body);
    return;
  }
  const details = element('details', 'notif-details');
  const summary = element('summary', 'notif-summary');
  summary.dataset.action = 'description';
  const preview = text.slice(0, 190).replace(/\s+\S*$/, '');
  summary.append(
    element('span', 'notif-preview', `${preview}…`),
    element('span', 'notif-read-more', `Read full ${label}`),
    element('span', 'notif-read-less', 'Show less')
  );
  details.append(summary, body);
  card.append(details);
}

function routeLink(routeId: string, resolve: RouteResolver): HTMLAnchorElement {
  const link = element('a', 'notif-route', resolve(routeId).title);
  link.href = routeMapUrl(routeId);
  link.setAttribute('aria-label', `View ${resolve(routeId).title} on map`);
  link.dataset.action = `route:${routeId}`;
  return link;
}

function appendRoutes(
  card: HTMLElement,
  routeIds: string[],
  resolve: RouteResolver
): void {
  const ids = [...new Set(routeIds)].filter(Boolean);
  if (ids.length === 0) return;
  const routes = element('div', 'notif-routes');
  routes.setAttribute('aria-label', 'Affected routes');
  ids.slice(0, 6).forEach((id) => routes.append(routeLink(id, resolve)));
  card.append(routes);
  if (ids.length > 6) {
    const details = element('details', 'notif-route-details');
    const summary = element('summary', '', `${ids.length - 6} more routes`);
    summary.dataset.action = 'more-routes';
    const remaining = element('div', 'notif-routes');
    ids.slice(6).forEach((id) => remaining.append(routeLink(id, resolve)));
    details.append(summary, remaining);
    card.append(details);
  }
}

function dateLabel(timestamp: string): string | null {
  if (!timestamp) return null;
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) return null;
  return date.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short'
  });
}

function appendWindows(
  card: HTMLElement,
  periods: IServiceAlert['activePeriods'] = []
): void {
  const windows = periods.flatMap((period) => {
    const start = dateLabel(period.start);
    const end = dateLabel(period.end);
    if (!start && !end) return [];
    return [
      start && end
        ? `${start} – ${end}`
        : start
          ? `From ${start}; end not provided`
          : `Until ${end}`
    ];
  });
  if (windows.length === 0) return;
  const details = element('details', 'notif-window');
  const summary = element('summary', '', 'Alert window');
  summary.dataset.action = 'window';
  details.append(summary);
  windows.forEach((window) => details.append(element('p', '', window)));
  details.append(
    element(
      'p',
      'notif-window-note',
      'When the agency is displaying this alert; service disruption times may differ.'
    )
  );
  card.append(details);
}

export function createServiceAlertCard(
  alert: IServiceAlert,
  resolve: RouteResolver
): HTMLLIElement {
  const card = element('li', 'notif-card notif-card--service');
  card.dataset.key = `alert:${alert.id ?? alert.headerText}`;
  const meta = element('div', 'notif-card-meta');
  meta.append(element('span', 'notif-kind', 'PRT service alert'));
  const severity = formatAlertMetadata(alert.severityLevel);
  if (severity) {
    const label = element('span', 'notif-severity', severity);
    label.dataset.severity = alert.severityLevel!;
    meta.append(label);
  }
  const title = element('h2', 'notif-title');
  appendLinkedText(title, alert.headerText || 'Service alert');
  card.append(meta, title);
  const topics = [
    formatAlertMetadata(alert.effect),
    formatAlertMetadata(alert.cause)
  ].filter((label): label is string => !!label);
  if (topics.length)
    card.append(element('p', 'notif-topics', [...new Set(topics)].join(' · ')));
  appendDescription(card, alert.descriptionText ?? '', 'alert');
  appendRoutes(card, alert.routeIds ?? [], resolve);
  appendWindows(card, alert.activePeriods);
  const url = alert.url ? safeHttpUrl(alert.url) : null;
  if (url) {
    const source = element('a', 'notif-source', 'Agency details ↗');
    source.href = url;
    source.target = '_blank';
    source.rel = 'noopener noreferrer';
    source.dataset.action = 'source';
    source.setAttribute('aria-label', 'Agency details (opens in a new tab)');
    card.append(source);
  }
  return card;
}

export function notificationKey(notif: INotification): string {
  return (
    notif._id ??
    `${notif.routeId}:${notif.vid}:${notif.createdAt}:${notif.message}`
  );
}

export function createLiveUpdateCard(
  notif: INotification,
  resolve: RouteResolver,
  formatMessage: (text: string) => string
): HTMLLIElement {
  const card = element('li', 'notif-card notif-card--live');
  card.dataset.key = `notification:${notificationKey(notif)}`;
  const meta = element('div', 'notif-card-meta');
  const time = element(
    'time',
    'notif-time',
    formatNotificationTime(notif.createdAt)
  );
  const date = new Date(notif.createdAt);
  if (Number.isFinite(date.getTime())) {
    time.dateTime = date.toISOString();
    time.title = date.toLocaleString();
  }
  meta.append(element('span', 'notif-kind', 'Rider update'), time);
  const display = resolve(notif.routeId);
  card.append(meta, element('h2', 'notif-title', display.title));
  if (notif.vid)
    card.append(element('p', 'notif-subtitle', `Bus #${notif.vid}`));
  const topics = notificationTopics(notif.changedFields);
  if (topics.length)
    card.append(element('p', 'notif-topics', topics.join(' · ')));
  appendDescription(card, formatMessage(notif.message), 'update');
  appendRoutes(card, [notif.routeId], resolve);
  return card;
}

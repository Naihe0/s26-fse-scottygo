import type {
  INotification,
  IServiceAlert
} from '../../../common/transit.interface';
import type { IRouteDisplay } from './route-display';

type RouteDisplayResolver = (routeId: string) => IRouteDisplay;
type MessageFormatter = (message: string) => string;

function getQueryTokens(query: string): string[] {
  return query
    .toLowerCase()
    .split(/\s+/)
    .map((token) => token.trim())
    .filter(Boolean);
}

function stripUrls(text: string): string {
  return text.replace(/https?:\/\/\S+/gi, ' ');
}

function isShortBusLikeToken(token: string): boolean {
  return /^[a-z]\d{1,3}$/i.test(token);
}

function matchesTokenizedQuery(query: string, fields: string[]): boolean {
  const tokens = getQueryTokens(query);
  if (tokens.length === 0) return true;

  const normalizedFields = fields.map((field) => field.toLowerCase());
  return tokens.every((token) =>
    normalizedFields.some((field) => field.includes(token))
  );
}

export function matchesNotificationQuery(
  notif: INotification,
  query: string,
  resolveRouteDisplay: RouteDisplayResolver,
  formatMessage: MessageFormatter
): boolean {
  const display = resolveRouteDisplay(notif.routeId);
  return matchesTokenizedQuery(query, [
    notif.message,
    notif.routeId,
    notif.vid ?? '',
    display.title,
    display.subtitle,
    formatMessage(notif.message)
  ]);
}

export function matchesAlertQuery(
  alert: IServiceAlert,
  query: string,
  resolveRouteDisplay: RouteDisplayResolver
): boolean {
  const tokens = getQueryTokens(query);
  const routeFields = alert.routeIds.flatMap((routeId) => {
    const display = resolveRouteDisplay(routeId);
    return [routeId, display.title];
  });
  const stopFields = (alert.stopIds ?? []).flatMap(id => [id, `stop #${id}`]);

  if (tokens.length === 1 && isShortBusLikeToken(tokens[0])) {
    return matchesTokenizedQuery(query, [...routeFields, ...stopFields]);
  }

  return matchesTokenizedQuery(query, [
    alert.headerText,
    stripUrls(alert.descriptionText),
    ...routeFields, ...stopFields
  ]);
}

/**
 * Contextual keyword search (Strategy pattern).
 *
 * Each search context uses its own strategy and data source:
 *  - UserSearchStrategy                GET /account/users/search
 *  - RouteSearchStrategy               GET /routes/search
 *  - TransitSearchStrategy             GET /search
 *  - TransitAutocompleteStrategy       map search autocomplete (Socket.IO)
 *  - NotificationAutocompleteStrategy  notification autocomplete (Socket.IO)
 *
 * Strategies that search natural-language text drop stop words first.
 */

import { TransitModel } from '../models/transit.model';
import { User } from '../models/user.model';
import { NotificationModel } from '../models/notification.model';
import gtfsService from '../services/gtfs.service';
import tripshotService from '../services/tripshot.service';
import alertsService from '../services/alerts.service';
import notificationSourcesService from '../services/notification-sources.service';
import {
  filterStopWords,
  toSearchTokens,
  matchesAllQueryTokens,
  matchesNotificationText
} from './search.utils';
import type {
  IRoute,
  IStop,
  ITransitSearchResult
} from '../../common/transit.interface';
import type { ISearchSuggestion } from '../../common/socket.interface';

export { filterStopWords } from './search.utils';

const MAX_TRANSIT_RESULTS = 5;
const MAX_AUTOCOMPLETE_SUGGESTIONS = 8;

export interface ISearchStrategy<T> {
  search(query: string): Promise<T>;
}

/** Runs a search with the strategy chosen for the current context. */
export class SearchContext<T> {
  constructor(private readonly strategy: ISearchStrategy<T>) {}

  executeSearch(query: string): Promise<T> {
    return this.strategy.search(query);
  }
}

const routeMatches = (route: IRoute, lowerQuery: string) =>
  route.id.toLowerCase().includes(lowerQuery) ||
  route.name.toLowerCase().includes(lowerQuery);

/** Usernames containing the query (case-insensitive), alphabetically. */
export class UserSearchStrategy implements ISearchStrategy<string[]> {
  async search(query: string): Promise<string[]> {
    const lower = query.trim().toLowerCase();
    const usernames = await User.getAllUsernames();
    return usernames
      .filter((username) => username.toLowerCase().includes(lower))
      .sort((a, b) => a.localeCompare(b));
  }
}

/** Up to five PRT routes whose ID or name contains the query. */
export class RouteSearchStrategy implements ISearchStrategy<IRoute[]> {
  async search(query: string): Promise<IRoute[]> {
    const filtered = filterStopWords(query);
    if (filtered === null) return [];
    const routes = await TransitModel.getRoutes();
    return routes
      .filter((route) => routeMatches(route, filtered))
      .slice(0, MAX_TRANSIT_RESULTS);
  }
}

/**
 * Up to five routes and five stops (PRT and CMU) whose text contains every
 * query token. Stops include the routes that serve them.
 */
export class TransitSearchStrategy implements ISearchStrategy<ITransitSearchResult> {
  async search(query: string): Promise<ITransitSearchResult> {
    const exactStopId = query.trim().toLowerCase();
    const queryTokens = toSearchTokens(query);
    if (
      queryTokens.length === 0 &&
      !/^[a-z0-9][a-z0-9_.:-]{0,119}$/.test(exactStopId)
    )
      return { routes: [], stops: [] };

    const [prtRoutes, cmuRoutes] = await Promise.all([
      TransitModel.getRoutes(),
      tripshotService.getRoutes()
    ]);
    const cmuStops = await Promise.all(
      cmuRoutes.map((route) => tripshotService.getStops(route.id))
    );

    const routes = [...prtRoutes, ...cmuRoutes]
      .filter((r) => matchesAllQueryTokens(queryTokens, `${r.id} ${r.name}`))
      .slice(0, MAX_TRANSIT_RESULTS);
    const stops = uniqueStops([
      ...gtfsService.getAllStops(),
      ...cmuStops.flat()
    ])
      .filter(
        (s) =>
          s.stopId.toLowerCase() === exactStopId ||
          matchesAllQueryTokens(queryTokens, `${s.stopName} ${s.stopId}`)
      )
      // A shared stop link must resolve even when many names or IDs contain it.
      .sort(
        (a, b) =>
          Number(b.stopId.toLowerCase() === exactStopId) -
          Number(a.stopId.toLowerCase() === exactStopId)
      )
      .slice(0, MAX_TRANSIT_RESULTS);

    return { routes, stops };
  }
}

/** First occurrence of each stop ID; CMU routes share many stops. */
function uniqueStops(stops: IStop[]): IStop[] {
  const seen = new Set<string>();
  return stops.filter((stop) => {
    if (seen.has(stop.stopId)) return false;
    seen.add(stop.stopId);
    return true;
  });
}

/** First occurrence of each label, ignoring case and blank labels. */
function uniqueLabels<T>(items: T[], label: (item: T) => string): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = label(item).trim().toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Up to five route IDs/names and stop names/IDs for the map search bar. */
export class TransitAutocompleteStrategy implements ISearchStrategy<string[]> {
  async search(query: string): Promise<string[]> {
    const { routes, stops } = await new TransitSearchStrategy().search(query);
    const labels = [
      ...routes.flatMap((route) => [route.id, route.name]),
      ...stops.flatMap((stop) => [stop.stopName, stop.stopId])
    ].map((label) => label.trim());
    return uniqueLabels(labels, (label) => label).slice(0, MAX_TRANSIT_RESULTS);
  }
}

/**
 * Short suggestions for the notifications search bar: matching routes, live
 * vehicles, recent rider notifications (labelled by route and bus so a click
 * runs a reliable route/bus search), and agency alert headlines.
 */
export class NotificationAutocompleteStrategy implements ISearchStrategy<
  ISearchSuggestion[]
> {
  async search(query: string): Promise<ISearchSuggestion[]> {
    const lower = filterStopWords(query);
    if (lower === null) return [];

    const [routes, notifications, vehicles] = await Promise.all([
      notificationSourcesService.getAllSubscribableRoutes(),
      NotificationModel.searchNotifications({}),
      notificationSourcesService.getAllLiveVehicles()
    ]);

    const suggestions: ISearchSuggestion[] = [
      ...routes
        .filter((route) => routeMatches(route, lower))
        .slice(0, 4)
        .map((route) => ({ label: route.id, type: 'route' as const })),
      ...vehicles
        .filter((vehicle) => vehicle.vid.toLowerCase().includes(lower))
        .slice(0, 3)
        .map((vehicle) => ({
          label: vehicle.vid,
          type: 'vehicle' as const,
          vid: vehicle.vid
        })),
      ...notifications
        .filter((notification) => matchesNotificationText(notification, lower))
        .slice(0, 2)
        .map((notification) => ({
          label: `Route ${notification.routeId} · Bus #${notification.vid}`,
          type: 'notification' as const,
          routeId: notification.routeId,
          vid: notification.vid
        })),
      ...alertsService
        .getAlerts()
        .filter(
          (alert) =>
            alert.headerText.toLowerCase().includes(lower) ||
            alert.descriptionText.toLowerCase().includes(lower) ||
            alert.routeIds.some((id) => id.toLowerCase().includes(lower))
        )
        .slice(0, 3)
        .filter((alert) => alert.headerText)
        .map((alert) => ({ label: alert.headerText, type: 'alert' as const }))
    ];

    return uniqueLabels(suggestions, (suggestion) => suggestion.label).slice(
      0,
      MAX_AUTOCOMPLETE_SUGGESTIONS
    );
  }
}

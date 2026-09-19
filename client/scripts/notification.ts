import './components/app-header';
import './components/live-notifications';
import { io } from 'socket.io-client';
import type {
  INotification,
  IServiceAlert
} from '../../common/transit.interface';
import {
  fetchRouteDisplayMap,
  formatNotificationMessage,
  getRouteDisplay,
  type IRouteDisplayMeta
} from './utils/route-display';
import {
  matchesAlertQuery,
  matchesNotificationQuery
} from './utils/notification-search';
import {
  createLiveUpdateCard,
  createServiceAlertCard
} from './utils/notification-card';
import { formatNotificationTime } from './utils/alert-content';

type View = 'all' | 'service' | 'live';
type Snapshot<T> = { items: T[]; loaded: boolean; failed: boolean };

const list = document.getElementById('notif-list')!;
const emptyEl = document.getElementById('notif-empty')!;
const statusEl = document.getElementById('notif-status')!;
const countEl = document.getElementById('notif-count')!;
const searchInput = document.getElementById(
  'notif-search-input'
) as HTMLInputElement;
const clearBtn = document.getElementById('notif-search-clear')!;
const refreshBtn = document.getElementById(
  'notif-refresh'
) as HTMLButtonElement;
const filters = [
  ...document.querySelectorAll<HTMLButtonElement>('[data-notif-view]')
];

let view: View = 'all';
let prefillContext: { route?: string; bus?: string } | null = null;
let alerts: Snapshot<IServiceAlert> = {
  items: [],
  loaded: false,
  failed: false
};
let notifications: Snapshot<INotification> = {
  items: [],
  loaded: false,
  failed: false
};
let routeDisplayById = new Map<string, IRouteDisplayMeta>();
let requestVersion = 0;
let loading = false;
let disposed = false;
let lastSuccessfulRefresh: number | null = null;
let renderSignature = '';
let controller: AbortController | null = null;
let socketRefreshTimer: ReturnType<typeof setTimeout> | null = null;

const resolveRouteDisplay = (id: string) =>
  getRouteDisplay(id, routeDisplayById);
const formatMessage = (message: string) =>
  formatNotificationMessage(message, routeDisplayById);

function authHeaders(): Record<string, string> {
  return { Authorization: `Bearer ${localStorage.getItem('token') ?? ''}` };
}

function renderCards(
  visibleAlerts: IServiceAlert[],
  visibleNotifications: INotification[]
): void {
  const signature = JSON.stringify([
    visibleAlerts,
    visibleNotifications,
    [...routeDisplayById]
  ]);
  if (signature === renderSignature) {
    list.querySelectorAll<HTMLTimeElement>('time[datetime]').forEach((time) => {
      time.textContent = formatNotificationTime(time.dateTime);
    });
    return;
  }
  renderSignature = signature;
  // Background refreshes preserve expanded descriptions and keyboard focus.
  const expanded = new Set(
    [...list.querySelectorAll('details[open]')].map((details) => {
      const key = details.closest<HTMLElement>('[data-key]')?.dataset.key;
      return `${key}:${details.querySelector<HTMLElement>('summary')?.dataset.action}`;
    })
  );
  const focused = document.activeElement as HTMLElement | null;
  const focusedKey = list.contains(focused)
    ? focused?.closest<HTMLElement>('[data-key]')?.dataset.key
    : undefined;
  const focusedAction = focusedKey ? focused?.dataset.action : undefined;
  const cards = [
    ...visibleAlerts.map((alert) =>
      createServiceAlertCard(alert, resolveRouteDisplay)
    ),
    ...visibleNotifications.map((notification) =>
      createLiveUpdateCard(notification, resolveRouteDisplay, formatMessage)
    )
  ];
  list.replaceChildren(...cards);
  for (const card of cards) {
    for (const details of card.querySelectorAll('details')) {
      const action =
        details.querySelector<HTMLElement>('summary')?.dataset.action;
      details.open = expanded.has(`${card.dataset.key}:${action}`);
    }
    if (focusedKey === card.dataset.key && focusedAction) {
      [...card.querySelectorAll<HTMLElement>('[data-action]')]
        .find((item) => item.dataset.action === focusedAction)
        ?.focus({ preventScroll: true });
    }
  }
}

function render(): void {
  const query = searchInput.value.trim();
  clearBtn.classList.toggle('is-visible', query.length > 0);
  clearBtn.setAttribute('aria-hidden', String(query.length === 0));
  const visibleAlerts =
    view === 'live'
      ? []
      : alerts.items.filter((alert) => {
          if (prefillContext?.route)
            return alert.routeIds.some(
              (id) => id.toLowerCase() === prefillContext!.route!.toLowerCase()
            );
          if (prefillContext?.bus) return false;
          return matchesAlertQuery(alert, query, resolveRouteDisplay);
        });
  const visibleNotifications =
    view === 'service'
      ? []
      : notifications.items
          .filter((notification) => {
            if (prefillContext)
              return (
                (!prefillContext.route ||
                  notification.routeId.toLowerCase() ===
                    prefillContext.route.toLowerCase()) &&
                (!prefillContext.bus || notification.vid === prefillContext.bus)
              );
            return matchesNotificationQuery(
              notification,
              query,
              resolveRouteDisplay,
              formatMessage
            );
          })
          .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  renderCards(visibleAlerts, visibleNotifications);

  const count = visibleAlerts.length + visibleNotifications.length;
  countEl.textContent = `${count} ${count === 1 ? 'update' : 'updates'}${query ? ' found' : ''}`;
  const relevant =
    view === 'service'
      ? [alerts]
      : view === 'live'
        ? [notifications]
        : [alerts, notifications];
  const allFailed = relevant.every((source) => source.failed && !source.loaded);
  emptyEl.classList.toggle('is-visible', count === 0);
  if (loading && relevant.every((source) => !source.loaded)) {
    emptyEl.textContent = 'Gathering transit updates…';
  } else if (allFailed) {
    emptyEl.textContent =
      'Updates are unavailable right now. Try Refresh to reconnect.';
  } else if (query) {
    emptyEl.textContent = `No updates match “${query}”. Try a route, bus number, or another keyword.`;
  } else if (view === 'live') {
    emptyEl.textContent =
      'No rider updates in the last 30 minutes. Follow routes to receive new reports while using ScottyGo.';
  } else if (view === 'service') {
    emptyEl.textContent = 'No service alerts to show right now.';
  } else {
    emptyEl.textContent =
      'No service alerts or recent rider updates to show right now.';
  }

  const failedNames = [
    alerts.failed ? 'Service alerts' : '',
    notifications.failed ? 'Rider updates' : ''
  ].filter(Boolean);
  if (loading) {
    statusEl.textContent = 'Refreshing updates…';
  } else if (failedNames.length) {
    const hasSnapshot =
      (alerts.failed && alerts.loaded) ||
      (notifications.failed && notifications.loaded);
    statusEl.textContent = `${failedNames.join(' and ')} could not refresh.${hasSnapshot ? ' Showing the last available updates.' : ''} Try Refresh.`;
  } else if (lastSuccessfulRefresh) {
    statusEl.textContent = `Updated ${new Date(lastSuccessfulRefresh).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}. Refreshes automatically while this page is open.`;
  } else {
    statusEl.textContent = 'Updates have not loaded yet.';
  }
  statusEl.classList.toggle('has-error', failedNames.length > 0 && !loading);
  list.setAttribute('aria-busy', String(loading));
  refreshBtn.disabled = loading;
  refreshBtn.textContent = loading ? 'Refreshing…' : 'Refresh';
  filters.forEach((filter) =>
    filter.setAttribute(
      'aria-pressed',
      String(filter.dataset.notifView === view)
    )
  );
}

async function fetchSnapshot<T>(
  path: string,
  signal: AbortSignal
): Promise<T[]> {
  const response = await fetch(path, { headers: authHeaders(), signal });
  if (!response.ok) throw new Error('Updates unavailable');
  const data = await response.json();
  if (!Array.isArray(data.payload)) throw new Error('Invalid update response');
  return data.payload;
}

async function refresh(): Promise<void> {
  if (disposed) return;
  const version = ++requestVersion;
  controller?.abort();
  controller = new AbortController();
  const requestController = controller;
  const timeout = setTimeout(() => requestController.abort(), 20_000);
  loading = true;
  render();
  const results = await Promise.allSettled([
    fetchSnapshot<IServiceAlert>('/notifications/alerts', controller.signal),
    fetchSnapshot<INotification>(
      '/notifications/notifications',
      controller.signal
    )
  ]);
  clearTimeout(timeout);
  if (disposed || version !== requestVersion) return;
  const [alertResult, notificationResult] = results;
  alerts =
    alertResult.status === 'fulfilled'
      ? { items: alertResult.value, loaded: true, failed: false }
      : { ...alerts, failed: true };
  notifications =
    notificationResult.status === 'fulfilled'
      ? { items: notificationResult.value, loaded: true, failed: false }
      : { ...notifications, failed: true };
  if (results.some((result) => result.status === 'fulfilled'))
    lastSuccessfulRefresh = Date.now();
  loading = false;
  render();
}

function scheduleRefresh(): void {
  if (document.hidden || disposed || socketRefreshTimer) return;
  socketRefreshTimer = setTimeout(() => {
    socketRefreshTimer = null;
    void refresh();
  }, 250);
}

function init(): void {
  const token = localStorage.getItem('token');
  if (!token) {
    window.location.replace('/auth');
    return;
  }
  const params = new URLSearchParams(window.location.search);
  const requestedView = params.get('type');
  if (
    requestedView === 'all' ||
    requestedView === 'service' ||
    requestedView === 'live'
  )
    view = requestedView;
  searchInput.value = params.get('route') ?? params.get('bus') ?? '';
  if (params.get('route') || params.get('bus'))
    prefillContext = {
      route: params.get('route') || undefined,
      bus: params.get('bus') || undefined
    };
  searchInput.addEventListener('input', () => {
    prefillContext = null;
    render();
  });
  clearBtn.addEventListener('click', () => {
    searchInput.value = '';
    prefillContext = null;
    history.replaceState(null, '', window.location.pathname);
    render();
    searchInput.focus();
  });
  filters.forEach((filter) =>
    filter.addEventListener('click', () => {
      view = filter.dataset.notifView as View;
      render();
    })
  );
  refreshBtn.addEventListener('click', () => void refresh());
  void fetchRouteDisplayMap(authHeaders()).then((routes) => {
    if (disposed) return;
    routeDisplayById = routes;
    render();
  });
  void refresh();

  const socket = io({ query: { token } });
  socket.on('alertUpdate', scheduleRefresh);
  document.addEventListener('scottygo:notification', scheduleRefresh);
  const visibilityRefresh = () => {
    if (!document.hidden) scheduleRefresh();
  };
  document.addEventListener('visibilitychange', visibilityRefresh);
  const timer = setInterval(() => {
    if (!document.hidden && !loading) void refresh();
  }, 60_000);
  window.addEventListener('pageshow', (event) => {
    if (event.persisted && !disposed) {
      socket.connect();
      scheduleRefresh();
    }
  });
  window.addEventListener('pagehide', (event) => {
    socket.disconnect();
    controller?.abort();
    requestVersion++;
    loading = false;
    if (socketRefreshTimer) clearTimeout(socketRefreshTimer);
    socketRefreshTimer = null;
    // BFCache freezes timers; retain one set of listeners for restoration.
    if (event.persisted) return;
    disposed = true;
    clearInterval(timer);
    document.removeEventListener('scottygo:notification', scheduleRefresh);
    document.removeEventListener('visibilitychange', visibilityRefresh);
  });
}

init();

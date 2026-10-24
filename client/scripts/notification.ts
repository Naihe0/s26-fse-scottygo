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
  createServiceAlertCard,
  type NotificationCardActions
} from './utils/notification-card';
import { formatNotificationTime } from './utils/alert-content';
import { authHeaders, getToken, isSameSession } from './services/session';
import { showToast } from './utils/toast';
import {
  NotificationReadStore,
  buildInboxShare,
  groupInbox,
  inboxKey,
  inboxRoutes,
  shareInboxSummary,
  sortInbox,
  type InboxEntry,
  type InboxSort
} from './utils/notification-inbox';

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
const savedOnlyBtn = document.getElementById('notif-saved-only');
const unreadOnlyBtn = document.getElementById('notif-unread-only');
const sortSelect = document.getElementById(
  'notif-sort'
) as HTMLSelectElement | null;
const groupSelect = document.getElementById(
  'notif-group'
) as HTMLSelectElement | null;
const scopeStatus = document.getElementById('notif-scope-status');
const inboxAnnouncement = document.getElementById('notif-inbox-announcement');
const readStore = new NotificationReadStore();
let savedOnly = false;
let unreadOnly = false;
let sort: InboxSort = 'priority';
let grouped = false;
let savedRoutes: Snapshot<string> = { items: [], loaded: false, failed: false };
let savedRequest: AbortController | null = null;
let savedRequestVersion = 0;
let savedLoading = false;

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

function renderCards(entries: InboxEntry[]): void {
  const signature = JSON.stringify([
    entries,
    [...routeDisplayById],
    entries.map((entry) => readStore.isRead(entry)),
    grouped,
    savedOnly,
    savedRoutes.items
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
  const oldCards = [...list.querySelectorAll<HTMLElement>('.notif-card')];
  const focusedIndex = oldCards.findIndex(
    (card) => card.dataset.key === focusedKey
  );
  const cards = entries.map((entry) => {
    const actions: NotificationCardActions = {
      read: readStore.isRead(entry),
      onReadChange: (read) => {
        readStore.setRead(entry, read);
        render();
        if (inboxAnnouncement)
          inboxAnnouncement.textContent = read
            ? 'Marked as read.'
            : 'Marked unread.';
      },
      onShare: (trigger) =>
        void shareInboxSummary(
          buildInboxShare(entry, (id) => resolveRouteDisplay(id).title),
          trigger,
          showToast
        )
    };
    return entry.kind === 'service'
      ? createServiceAlertCard(entry.value, resolveRouteDisplay, actions)
      : createLiveUpdateCard(
          entry.value,
          resolveRouteDisplay,
          formatMessage,
          actions
        );
  });
  if (grouped) {
    const byKey = new Map(cards.map((card) => [card.dataset.key, card]));
    const savedIds = new Set(savedRoutes.items.map((id) => id.toLowerCase()));
    const sections = groupInbox(entries).map((group) => {
      const section = document.createElement('li');
      section.className = 'notif-route-group';
      const header = document.createElement('h2');
      header.className = 'notif-group-heading';
      const headerRoutes = [...group.routeIds];
      if (savedOnly) {
        headerRoutes.sort(
          (a, b) =>
            Number(savedIds.has(b.toLowerCase())) -
            Number(savedIds.has(a.toLowerCase()))
        );
      }
      const titles = headerRoutes.map((id) => resolveRouteDisplay(id).title);
      const title = titles.length
        ? titles.slice(0, 2).join(' + ') +
          (titles.length > 2 ? ` + ${titles.length - 2} more` : '')
        : 'Network updates';
      header.textContent = `${title} · ${group.entries.length}`;
      const nested = document.createElement('ul');
      nested.className = 'notif-group-list';
      nested.setAttribute('aria-label', title);
      group.entries.forEach((entry) => {
        const card = byKey.get(inboxKey(entry));
        if (card) nested.append(card);
      });
      section.append(header, nested);
      return section;
    });
    list.replaceChildren(...sections);
  } else list.replaceChildren(...cards);
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
  if (focusedKey && !cards.some((card) => card.dataset.key === focusedKey)) {
    const next = cards[Math.max(0, Math.min(focusedIndex, cards.length - 1))];
    (
      next?.querySelector<HTMLButtonElement>('[data-action="read"]') ??
      unreadOnlyBtn ??
      searchInput
    )?.focus({ preventScroll: true });
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
  const saved = new Set(savedRoutes.items.map((id) => id.toLowerCase()));
  const unique = new Map<string, InboxEntry>();
  const candidates: InboxEntry[] = [
    ...visibleAlerts.map((value): InboxEntry => ({ kind: 'service', value })),
    ...visibleNotifications.map(
      (value): InboxEntry => ({ kind: 'live', value })
    )
  ];
  for (const entry of candidates) {
    if (
      savedOnly &&
      !inboxRoutes(entry).some((route) => saved.has(route.toLowerCase()))
    )
      continue;
    if (unreadOnly && readStore.isRead(entry)) continue;
    unique.set(inboxKey(entry), entry);
  }
  const entries = sortInbox([...unique.values()], sort);
  renderCards(entries);

  const count = entries.length;
  const unread = entries.filter((entry) => !readStore.isRead(entry)).length;
  countEl.textContent = `${count} ${count === 1 ? 'update' : 'updates'}${query ? ' found' : ''} · ${unread} unread`;
  savedOnlyBtn?.setAttribute('aria-pressed', String(savedOnly));
  unreadOnlyBtn?.setAttribute('aria-pressed', String(unreadOnly));
  if (scopeStatus) {
    scopeStatus.hidden = !savedOnly;
    scopeStatus.textContent = savedLoading
      ? 'Loading saved routes…'
      : savedRoutes.failed
        ? `Saved routes could not refresh.${savedRoutes.loaded ? ' Using the last available list.' : ''} Try Refresh.`
        : `${savedRoutes.items.length} saved ${savedRoutes.items.length === 1 ? 'route' : 'routes'}.`;
  }
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
  } else if (relevant.some((source) => source.failed)) {
    emptyEl.textContent = query
      ? `No updates match “${query}” in the available results. Some updates could not load. Try Refresh to check all sources.`
      : 'No updates in the available results. Some updates could not load. Try Refresh to check all sources.';
  } else if (savedOnly && savedLoading && !savedRoutes.loaded) {
    emptyEl.textContent = 'Loading your saved routes…';
  } else if (savedOnly && savedRoutes.failed && !savedRoutes.loaded) {
    emptyEl.textContent =
      'Your saved routes could not load. Try Refresh or turn off Saved routes.';
  } else if (
    savedOnly &&
    savedRoutes.loaded &&
    savedRoutes.items.length === 0
  ) {
    emptyEl.textContent = 'Save a route to see its updates here. ';
    const link = document.createElement('a');
    link.href = '/subscriptions';
    link.textContent = 'Choose routes';
    emptyEl.append(link);
  } else if (unreadOnly) {
    emptyEl.textContent =
      'No unread updates match these filters. Turn off Unread to see updates you have read.';
  } else if (savedOnly) {
    emptyEl.textContent = query
      ? `No updates for saved routes match “${query}”.`
      : 'No updates for your saved routes in this view.';
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

async function loadSavedRoutes(): Promise<void> {
  if (disposed) return;
  const token = getToken();
  const version = ++savedRequestVersion;
  savedRequest?.abort();
  const request = new AbortController();
  savedRequest = request;
  savedLoading = true;
  render();
  const timeout = setTimeout(() => request.abort(), 15_000);
  try {
    const rows = await fetchSnapshot<{ routeId: string }>(
      '/notifications/subscriptions',
      request.signal
    );
    if (disposed || version !== savedRequestVersion || !isSameSession(token))
      return;
    savedRoutes = {
      items: [
        ...new Set(
          rows.flatMap((row) =>
            typeof row?.routeId === 'string' ? [row.routeId] : []
          )
        )
      ],
      loaded: true,
      failed: false
    };
  } catch {
    if (disposed || version !== savedRequestVersion || !isSameSession(token))
      return;
    savedRoutes = { ...savedRoutes, failed: true };
  } finally {
    clearTimeout(timeout);
    if (!disposed && version === savedRequestVersion && isSameSession(token)) {
      savedLoading = false;
      savedRequest = null;
      render();
    }
  }
}

async function refresh(): Promise<void> {
  if (disposed) return;
  const token = getToken();
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
  if (disposed || version !== requestVersion || !isSameSession(token)) return;
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
  const token = getToken();
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
  refreshBtn.addEventListener('click', () => {
    void refresh();
    void loadSavedRoutes();
  });
  savedOnlyBtn?.addEventListener('click', () => {
    savedOnly = !savedOnly;
    render();
    if (savedOnly) void loadSavedRoutes();
  });
  unreadOnlyBtn?.addEventListener('click', () => {
    unreadOnly = !unreadOnly;
    render();
  });
  sortSelect?.addEventListener('change', () => {
    sort = sortSelect.value === 'newest' ? 'newest' : 'priority';
    render();
  });
  groupSelect?.addEventListener('change', () => {
    grouped = groupSelect.value === 'route';
    render();
  });
  const storageChanged = (event: StorageEvent) => {
    if ((event.key === 'token' || event.key === null) && reloadChangedSession())
      return;
    if (
      event.key?.startsWith('scottygo:notification-inbox:') ||
      event.key === null
    ) {
      readStore.reload();
      render();
    }
  };
  window.addEventListener('storage', storageChanged);
  void fetchRouteDisplayMap(authHeaders()).then((routes) => {
    if (disposed) return;
    routeDisplayById = routes;
    render();
  });
  void refresh();
  void loadSavedRoutes();

  const socket = io({ auth: { token } });
  socket.on('alertUpdate', scheduleRefresh);
  document.addEventListener('scottygo:notification', scheduleRefresh);
  const visibilityRefresh = () => {
    if (!document.hidden) scheduleRefresh();
  };
  document.addEventListener('visibilitychange', visibilityRefresh);
  const timer = setInterval(() => {
    if (!document.hidden && !loading) void refresh();
  }, 60_000);
  const restorePage = (event: PageTransitionEvent) => {
    if (event.persisted && !disposed) {
      if (reloadChangedSession()) return;
      socket.connect();
      scheduleRefresh();
      void loadSavedRoutes();
    }
  };
  const hidePage = (event: PageTransitionEvent) => cleanup(!event.persisted);
  function reloadChangedSession(): boolean {
    if (isSameSession(token)) return false;
    cleanup(true);
    window.location.reload();
    return true;
  }
  function cleanup(permanent: boolean): void {
    socket.disconnect();
    controller?.abort();
    savedRequest?.abort();
    savedRequestVersion++;
    savedLoading = false;
    requestVersion++;
    loading = false;
    if (socketRefreshTimer) clearTimeout(socketRefreshTimer);
    socketRefreshTimer = null;
    // BFCache freezes timers; retain one set of listeners for restoration.
    if (!permanent) return;
    disposed = true;
    clearInterval(timer);
    document.removeEventListener('scottygo:notification', scheduleRefresh);
    document.removeEventListener('visibilitychange', visibilityRefresh);
    window.removeEventListener('storage', storageChanged);
    window.removeEventListener('pageshow', restorePage);
    window.removeEventListener('pagehide', hidePage);
  }
  window.addEventListener('pageshow', restorePage);
  window.addEventListener('pagehide', hidePage);
}

init();

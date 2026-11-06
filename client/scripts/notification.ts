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
import {
  formatAlertMetadata,
  formatNotificationTime
} from './utils/alert-content';
import { agencyWindowState } from './utils/agency-window';
import { authHeaders, getToken, isSameSession } from './services/session';
import { showToast } from './utils/toast';
import { SavedUpdateStore } from './utils/saved-updates';
import {
  INBOX_READ_LIMIT,
  NotificationReadStore,
  buildInboxShare,
  groupInbox,
  inboxKey,
  inboxAccount,
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
const markShownRead = document.querySelector<HTMLButtonElement>(
  '#notif-mark-shown-read'
);
const sortSelect = document.getElementById(
  'notif-sort'
) as HTMLSelectElement | null;
const groupSelect = document.getElementById(
  'notif-group'
) as HTMLSelectElement | null;
const scopeStatus = document.getElementById('notif-scope-status');
const inboxAnnouncement = document.getElementById('notif-inbox-announcement');
const readStore = new NotificationReadStore();
const savedUpdates = new SavedUpdateStore();
const readingListBtn = document.getElementById('notif-reading-list');
const main = document.querySelector<HTMLElement>('main.content');
let readingListOnly = false;
let savedOnly = false;
let unreadOnly = false;
let sort: InboxSort = 'priority';
let grouped = false;
let shownUnread: InboxEntry[] = [];
let lastBatch: InboxEntry[] = [];
const routeSelect = document.querySelector<HTMLSelectElement>('#notif-route');
const severitySelect =
  document.querySelector<HTMLSelectElement>('#notif-severity');
const resetFilters = document.querySelector<HTMLButtonElement>('#notif-reset');
const windowSelect = document.querySelector<HTMLSelectElement>('#notif-window');
const topicSelect = document.querySelector<HTMLSelectElement>('#notif-topic');
const undoRead = document.querySelector<HTMLButtonElement>('#notif-undo');
let routeOptionsKey = '';
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

function feedEntries(): InboxEntry[] {
  return [
    ...alerts.items.map((value): InboxEntry => ({ kind: 'service', value })),
    ...notifications.items.map((value): InboxEntry => ({ kind: 'live', value }))
  ];
}

function currentReadingAnchor(): { key: string; offset: number } | null {
  if (!main || main.scrollTop < 20) return null;
  const top = main.getBoundingClientRect().top;
  const card = [...list.querySelectorAll<HTMLElement>('.notif-card')].find(
    (item) => item.getBoundingClientRect().bottom > top + 4
  );
  return card?.dataset.key
    ? { key: card.dataset.key, offset: card.getBoundingClientRect().top - top }
    : null;
}

function restoreAnchor(anchor: { key: string; offset: number } | null): void {
  if (!main || !anchor) return;
  const card = [...list.querySelectorAll<HTMLElement>('.notif-card')].find(
    (item) => item.dataset.key === anchor.key
  );
  if (card) main.scrollTop += card.getBoundingClientRect().top - main.getBoundingClientRect().top - anchor.offset;
}

type ReadingContext = {
  account: string; url: string; at: number; view: View; query: string;
  savedOnly: boolean; unreadOnly: boolean; readingListOnly: boolean;
  sort: InboxSort; grouped: boolean; selections: string[]; moreOpen: boolean;
  expanded: string[]; anchor: { key: string; offset: number } | null; scrollTop: number;
  prefill: { route?: string; bus?: string } | null;
};
let pendingReading: ReadingContext | null = null;
const readingSelects = [routeSelect, severitySelect, windowSelect, topicSelect];

function saveReadingContext(): void {
  const account = inboxAccount();
  if (!account) return;
  const state: ReadingContext = {
    account, url: location.pathname + location.search, at: Date.now(), view,
    query: searchInput.value.slice(0, 300), savedOnly, unreadOnly, readingListOnly,
    sort, grouped, selections: readingSelects.map((select) => select?.value ?? ''),
    moreOpen: Boolean(document.querySelector<HTMLDetailsElement>('#notif-more-options')?.open),
    expanded: [...list.querySelectorAll('details[open]')].slice(0, 50).map((details) =>
      `${details.closest<HTMLElement>('[data-key]')?.dataset.key}:${details.querySelector<HTMLElement>('summary')?.dataset.action}`),
    anchor: currentReadingAnchor(), scrollTop: main?.scrollTop ?? 0, prefill: prefillContext
  };
  try { history.replaceState({ ...history.state, scottygoInbox: state }, ''); } catch { /* Reading still works when history storage is unavailable. */ }
}

function loadReadingContext(): void {
  const state = history.state?.scottygoInbox as ReadingContext | undefined;
  if (!state || state.account !== inboxAccount() || state.url !== location.pathname + location.search ||
      !Number.isFinite(state.at) || Date.now() - state.at < 0 || Date.now() - state.at > 30 * 60_000 ||
      !['all', 'service', 'live'].includes(state.view) || typeof state.query !== 'string' ||
      state.query.length > 300 || !Array.isArray(state.selections) || state.selections.length !== 4 ||
      !state.selections.every((value) => typeof value === 'string' && value.length < 200) ||
      !Array.isArray(state.expanded) || state.expanded.length > 50 || !state.expanded.every((value) => typeof value === 'string') ||
      !Number.isFinite(state.scrollTop) || state.scrollTop < 0 || state.scrollTop > 2_000_000) return;
  pendingReading = state;
  view = state.view;
  searchInput.value = state.query;
  savedOnly = state.savedOnly === true;
  unreadOnly = state.unreadOnly === true;
  readingListOnly = state.readingListOnly === true;
  sort = state.sort === 'newest' ? 'newest' : 'priority';
  grouped = state.grouped === true;
  prefillContext = state.prefill &&
    (!state.prefill.route || typeof state.prefill.route === 'string') &&
    (!state.prefill.bus || typeof state.prefill.bus === 'string') ? state.prefill : null;
  if (sortSelect) sortSelect.value = sort;
  if (groupSelect) groupSelect.value = grouped ? 'route' : 'flat';
  readingSelects.forEach((select, index) => {
    if (!select) return;
    const value = state.selections[index];
    if (value && ![...select.options].some((option) => option.value === value)) select.append(new Option(value, value));
    select.value = value;
  });
  const more = document.querySelector<HTMLDetailsElement>('#notif-more-options');
  if (more) more.open = state.moreOpen === true;
}

function restoreReadingContext(): void {
  const state = pendingReading;
  if (!state || loading || (savedOnly && savedLoading)) return;
  pendingReading = null;
  for (const details of list.querySelectorAll<HTMLDetailsElement>('details')) {
    const key = `${details.closest<HTMLElement>('[data-key]')?.dataset.key}:${details.querySelector<HTMLElement>('summary')?.dataset.action}`;
    details.open = state.expanded.includes(key);
  }
  if (main) {
    main.scrollTop = state.scrollTop;
    if (state.anchor && typeof state.anchor.key === 'string' && Number.isFinite(state.anchor.offset)) restoreAnchor(state.anchor);
  }
}

function renderCards(entries: InboxEntry[]): void {
  const signature = JSON.stringify([
    entries,
    [...routeDisplayById],
    entries.map((entry) => readStore.isRead(entry)),
    savedUpdates.list(),
    entries.map((entry) =>
      entry.kind === 'service'
        ? agencyWindowState(entry.value.activePeriods)
        : ''
    ),
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
  const anchor = currentReadingAnchor();
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
      saved: savedUpdates.has(entry),
      savedCopy: (() => {
        if (!readingListOnly) return undefined;
        const record = savedUpdates.list().find((item) => item.key === inboxKey(entry));
        return record?.current === false
          ? 'Saved copy · No longer in the current feed. Check the agency for current service.'
          : record?.current === null
            ? 'Saved copy · Current availability has not been verified.'
            : undefined;
      })(),
      onSaveChange: () => {
        const result = savedUpdates.toggle(entry);
        savedUpdates.reconcile(feedEntries(), new Set([
          ...(alerts.loaded && !alerts.failed ? ['service' as const] : []),
          ...(notifications.loaded && !notifications.failed ? ['live' as const] : [])
        ]));
        render();
        if (inboxAnnouncement) inboxAnnouncement.textContent = result.message;
      },
      onReadChange: (read) => {
        lastBatch = lastBatch.filter(
          (item) => inboxKey(item) !== inboxKey(entry)
        );
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
      (readingListOnly ? readingListBtn : unreadOnlyBtn) ??
      searchInput
    )?.focus({ preventScroll: true });
  }
  restoreAnchor(anchor);
}

function syncRouteChoices(): void {
  if (!routeSelect) return;
  const selection = routeSelect.value;
  const ids = new Set(alerts.items.flatMap((item) => item.routeIds || []));
  notifications.items.forEach((item) => ids.add(item.routeId));
  if (readingListOnly) savedUpdates.list().forEach(({ entry }) => inboxRoutes(entry).forEach((id) => ids.add(id)));
  if (selection) ids.add(selection);
  const rows = [...ids]
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    .map((id) => [id, resolveRouteDisplay(id).title]);
  const key = JSON.stringify(rows);
  if (key === routeOptionsKey) return;
  routeOptionsKey = key;
  routeSelect.replaceChildren(
    new Option('Any route', ''),
    ...rows.map(([id, title]) => new Option(title, id))
  );
  routeSelect.value = selection;
}

function syncTopicChoices(): void {
  const group = topicSelect?.querySelector<HTMLOptGroupElement>(
    '[data-agency-effects]'
  );
  if (!group || !topicSelect) return;
  const chosen = topicSelect.value;
  const effects = new Set(
    [...alerts.items, ...(readingListOnly ? savedUpdates.list().flatMap(({ entry }) => entry.kind === 'service' ? [entry.value] : []) : [])]
      .map((alert) => alert.effect)
      .filter((value): value is string =>
        Boolean(value && formatAlertMetadata(value))
      )
  );
  if (chosen.startsWith('effect:')) effects.add(chosen.slice(7));
  const sorted = [...effects].sort();
  const key = sorted.join(',');
  if (group.dataset.effects === key) return;
  group.dataset.effects = key;
  group.replaceChildren(
    ...sorted.map(
      (effect) =>
        new Option(formatAlertMetadata(effect) ?? effect, 'effect:' + effect)
    )
  );
  group.hidden = !sorted.length;
  topicSelect.value = chosen;
}

function render(): void {
  syncRouteChoices();
  syncTopicChoices();
  const query = searchInput.value.trim();
  clearBtn.classList.toggle('is-visible', query.length > 0);
  clearBtn.setAttribute('aria-hidden', String(query.length === 0));
  const sourceEntries = readingListOnly ? savedUpdates.list().map((record) => record.entry) : feedEntries();
  const visibleAlerts = sourceEntries.flatMap((entry) => entry.kind === 'service' ? [entry.value] : []).filter((alert) => {
    if (prefillContext?.route)
      return alert.routeIds.some(
        (id) => id.toLowerCase() === prefillContext!.route!.toLowerCase()
      );
    if (prefillContext?.bus) return false;
    return matchesAlertQuery(alert, query, resolveRouteDisplay);
  });
  const visibleNotifications = sourceEntries.flatMap((entry) => entry.kind === 'live' ? [entry.value] : [])
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
      windowSelect?.value &&
      (entry.kind !== 'service' ||
        agencyWindowState(entry.value.activePeriods) !== windowSelect.value)
    )
      continue;
    const topic = topicSelect?.value;
    if (
      topic &&
      (entry.kind === 'live'
        ? !entry.value.changedFields?.includes(topic)
        : topic !== 'effect:' + entry.value.effect)
    )
      continue;
    if (
      severitySelect?.value === 'elevated' &&
      (entry.kind !== 'service' ||
        !['WARNING', 'SEVERE'].includes(entry.value.severityLevel ?? ''))
    )
      continue;
    if (
      routeSelect?.value &&
      !inboxRoutes(entry).some(
        (id) => id.toLowerCase() === routeSelect.value.toLowerCase()
      )
    )
      continue;
    if (
      savedOnly &&
      !inboxRoutes(entry).some((route) => saved.has(route.toLowerCase()))
    )
      continue;
    if (unreadOnly && readStore.isRead(entry)) continue;
    unique.set(inboxKey(entry), entry);
  }
  const scoped = [...unique.values()];
  const entries = sortInbox(
    scoped.filter((item) => view === 'all' || item.kind === view),
    sort
  );
  const counts = {
    all: scoped.length,
    service: scoped.filter((item) => item.kind === 'service').length,
    live: scoped.filter((item) => item.kind === 'live').length
  };
  for (const button of filters) {
    const type = button.dataset.notifView as View;
    const known =
      type === 'all'
        ? alerts.loaded && notifications.loaded
        : type === 'live'
          ? notifications.loaded
          : alerts.loaded;
    let badge = button.querySelector('.notif-type-count');
    if (!badge) {
      badge = document.createElement('span');
      badge.className = 'notif-type-count';
      button.append(badge);
    }
    badge.textContent = known ? ' ' + counts[type] : '';
  }
  if (resetFilters)
    resetFilters.hidden = !(
      query ||
      view !== 'all' ||
      savedOnly ||
      readingListOnly ||
      unreadOnly ||
      routeSelect?.value ||
      severitySelect?.value === 'elevated' ||
      windowSelect?.value ||
      topicSelect?.value
    );
  if (undoRead) undoRead.hidden = !lastBatch.length;
  renderCards(entries);

  const count = entries.length;
  shownUnread = entries.filter((entry) => !readStore.isRead(entry));
  const unread = shownUnread.length;
  if (markShownRead) {
    const restoreFocus = document.activeElement === markShownRead && !unread;
    markShownRead.hidden = unread === 0;
    markShownRead.disabled = entries.length > INBOX_READ_LIMIT;
    markShownRead.textContent = markShownRead.disabled
      ? 'Narrow filters to mark shown updates as read'
      : 'Mark shown as read';
    if (restoreFocus) unreadOnlyBtn?.focus({ preventScroll: true });
  }
  countEl.textContent = `${count} ${count === 1 ? 'update' : 'updates'}${query ? ' found' : ''} · ${unread} unread`;
  savedOnlyBtn?.setAttribute('aria-pressed', String(savedOnly));
  unreadOnlyBtn?.setAttribute('aria-pressed', String(unreadOnly));
  readingListBtn?.setAttribute('aria-pressed', String(readingListOnly));
  if (readingListBtn) readingListBtn.textContent = `Reading list${savedUpdates.list().length ? ` (${savedUpdates.list().length})` : ''}`;
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
  if (readingListOnly) {
    emptyEl.textContent = savedUpdates.list().length
      ? 'No saved updates match these filters. Clear filters to see all updates.'
      : 'Your reading list is empty. Use Save update on a notice to keep a copy here.';
  } else if (loading && relevant.every((source) => !source.loaded)) {
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
  } else if (windowSelect?.value || topicSelect?.value) {
    emptyEl.textContent =
      'No updates match these filters. Try another window or topic, or clear the filters.';
  } else if (severitySelect?.value === 'elevated' || routeSelect?.value) {
    emptyEl.textContent = 'No updates match these route and severity filters.';
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
    statusEl.textContent = `Updated ${new Date(lastSuccessfulRefresh).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })} · Auto-refresh on`;
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
      restoreReadingContext();
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
  savedUpdates.reconcile(feedEntries(), new Set([
    ...(alertResult.status === 'fulfilled' ? ['service' as const] : []),
    ...(notificationResult.status === 'fulfilled' ? ['live' as const] : [])
  ]));
  loading = false;
  render();
  restoreReadingContext();
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
  loadReadingContext();
  // A fresh interaction wins over a slow returning page's saved scroll/focus.
  const cancelPendingReading = () => { pendingReading = null; };
  let departing = false;
  const rememberReading = () => {
    if (!disposed && !departing && isSameSession(token) && !pendingReading) saveReadingContext();
  };
  const rememberBeforeLink = (event: Event) => {
    const link = (event.target as Element | null)?.closest<HTMLAnchorElement>('a[href]');
    const click = event as MouseEvent;
    if (!link || click.button || click.metaKey || click.ctrlKey || click.shiftKey || click.altKey || link.target === '_blank') return;
    if (isSameSession(token)) saveReadingContext();
    departing = true;
    if (readingScrollTimer) clearTimeout(readingScrollTimer);
    readingScrollTimer = null;
  };
  let readingScrollTimer: ReturnType<typeof setTimeout> | null = null;
  const rememberScroll = () => {
    if (readingScrollTimer) clearTimeout(readingScrollTimer);
    readingScrollTimer = setTimeout(() => { readingScrollTimer = null; rememberReading(); }, 500);
  };
  main?.addEventListener('input', cancelPendingReading, true);
  main?.addEventListener('click', cancelPendingReading, true);
  main?.addEventListener('change', cancelPendingReading, true);
  main?.addEventListener('click', rememberBeforeLink, true);
  for (const type of ['input', 'change', 'click', 'toggle']) main?.addEventListener(type, rememberReading, type === 'toggle');
  main?.addEventListener('scroll', rememberScroll);
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
  routeSelect?.addEventListener('change', render);
  severitySelect?.addEventListener('change', render);
  windowSelect?.addEventListener('change', render);
  topicSelect?.addEventListener('change', render);
  resetFilters?.addEventListener('click', () => {
    savedOnly = unreadOnly = readingListOnly = false;
    view = 'all';
    prefillContext = null;
    searchInput.value = '';
    if (routeSelect) routeSelect.value = '';
    if (severitySelect) severitySelect.value = 'all';
    if (windowSelect) windowSelect.value = '';
    if (topicSelect) topicSelect.value = '';
    history.replaceState(null, '', window.location.pathname);
    render();
    filters[0]?.focus({ preventScroll: true });
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
  markShownRead?.addEventListener('click', () => {
    if (reloadChangedSession() || !shownUnread.length || markShownRead.disabled)
      return;
    const count = shownUnread.length;
    lastBatch = [...shownUnread];
    readStore.setEntriesRead(shownUnread, true);
    render();
    if (inboxAnnouncement)
      inboxAnnouncement.textContent = `Marked ${count} shown ${count === 1 ? 'update' : 'updates'} as read.`;
  });
  undoRead?.addEventListener('click', () => {
    if (reloadChangedSession() || !lastBatch.length) return;
    readStore.setEntriesRead(
      lastBatch.filter((entry) => readStore.isRead(entry)),
      false
    );
    lastBatch = [];
    render();
    if (inboxAnnouncement)
      inboxAnnouncement.textContent = 'Undid the last mark as read.';
    (markShownRead && !markShownRead.hidden
      ? markShownRead
      : unreadOnlyBtn
    )?.focus({ preventScroll: true });
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
  readingListBtn?.addEventListener('click', () => {
    readingListOnly = !readingListOnly;
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
      event.key?.startsWith('scottygo:saved-updates:') ||
      event.key === null
    ) {
      readStore.reload();
      savedUpdates.reload();
      lastBatch = [];
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
    departing = false;
    if (event.persisted && !disposed) {
      if (reloadChangedSession()) return;
      socket.connect();
      scheduleRefresh();
      void loadSavedRoutes();
    }
  };
  const hidePage = (event: PageTransitionEvent) => {
    cleanup(!event.persisted);
  };
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
    if (readingScrollTimer) clearTimeout(readingScrollTimer);
    readingScrollTimer = null;
    // BFCache freezes timers; retain one set of listeners for restoration.
    if (!permanent) return;
    disposed = true;
    main?.removeEventListener('input', cancelPendingReading, true);
    main?.removeEventListener('click', cancelPendingReading, true);
    main?.removeEventListener('change', cancelPendingReading, true);
    main?.removeEventListener('click', rememberBeforeLink, true);
    for (const type of ['input', 'change', 'click', 'toggle']) main?.removeEventListener(type, rememberReading, type === 'toggle');
    main?.removeEventListener('scroll', rememberScroll);
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

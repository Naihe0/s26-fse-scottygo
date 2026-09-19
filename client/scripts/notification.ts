// Export empty object to treat as module
export {};

import './components/app-header';
import './components/live-notifications';
import { escapeHtml } from './utils/html';
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

// ── Auth ───────────────────────────────────────────────────────────────────────

function getToken(): string {
  return localStorage.getItem('token') ?? '';
}

function authHeaders(): Record<string, string> {
  return { Authorization: `Bearer ${getToken()}` };
}

// ── DOM refs ───────────────────────────────────────────────────────────────────

const list = document.getElementById('notif-list')!;
const emptyEl = document.getElementById('notif-empty')!;
const searchInput = document.getElementById(
  'notif-search-input'
) as HTMLInputElement;
const clearBtn = document.getElementById('notif-search-clear')!;

// ── State ──────────────────────────────────────────────────────────────────────

/** true while showing live notification search results (not alerts) */
let showingNotifications = false;
let routeDisplayById = new Map<string, IRouteDisplayMeta>();
let requestVersion = 0;

function resolveRouteDisplay(routeId: string): {
  title: string;
  subtitle: string;
} {
  return getRouteDisplay(routeId, routeDisplayById);
}

function formatMessage(message: string): string {
  return formatNotificationMessage(message, routeDisplayById);
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function formatTime(isoTimestamp: string): string {
  const mins = Math.round(
    (Date.now() - new Date(isoTimestamp).getTime()) / 60_000
  );
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  return `${Math.floor(mins / 60)}h ago`;
}

function updateEmptyState(query?: string): void {
  const hasItems = list.children.length > 0;
  emptyEl.classList.toggle('is-visible', !hasItems);
  if (!hasItems && query) {
    emptyEl.textContent = `No notifications found for '${query}'.`;
  } else if (!hasItems) {
    emptyEl.textContent = 'No notifications found.';
  }
}

// ── Notification cards ─────────────────────────────────────────────────────────

const NOTIF_ICON = `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
  <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path>
  <line x1="12" y1="9" x2="12" y2="13"></line>
  <line x1="12" y1="17" x2="12.01" y2="17"></line>
</svg>`;

function createNotifCard(notif: INotification): HTMLLIElement {
  const li = document.createElement('li');
  li.className = 'notif-card';
  const display = resolveRouteDisplay(notif.routeId);
  const secondaryText = notif.vid ? `Bus #${notif.vid}` : display.subtitle;

  li.innerHTML = `
    <button class="notif-dismiss" aria-label="Dismiss notification">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
        <line x1="18" y1="6" x2="6" y2="18"></line>
        <line x1="6" y1="6" x2="18" y2="18"></line>
      </svg>
    </button>
    <div class="notif-card-header">
      <span class="notif-icon">${NOTIF_ICON}</span>
      <div class="notif-header-text">
        <span class="notif-title">${escapeHtml(display.title)}</span>
          <span class="notif-subtitle">${escapeHtml(secondaryText)}</span>
      </div>
    </div>
    <p class="notif-body">${escapeHtml(formatMessage(notif.message))}</p>
    <div class="notif-card-footer">
      <span class="notif-tag">Live Update</span>
      <span class="notif-time">${formatTime(notif.createdAt)}</span>
    </div>
  `;

  li.querySelector<HTMLButtonElement>('.notif-dismiss')!.addEventListener(
    'click',
    () => {
      li.remove();
      updateEmptyState(searchInput.value.trim() || undefined);
    }
  );

  return li;
}

async function fetchRoutesForDisplay(): Promise<void> {
  routeDisplayById = await fetchRouteDisplayMap(authHeaders());
}

// ── Alert cards ────────────────────────────────────────────────────────────────

const ALERT_ICON = `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
  <circle cx="12" cy="12" r="10"></circle>
  <line x1="12" y1="8" x2="12" y2="12"></line>
  <line x1="12" y1="16" x2="12.01" y2="16"></line>
</svg>`;

function createAlertCard(alert: IServiceAlert): HTMLLIElement {
  const li = document.createElement('li');
  li.className = 'notif-card';
  const routes = alert.routeIds.join(', ');

  li.innerHTML = `
    <div class="notif-card-header">
      <span class="notif-icon">${ALERT_ICON}</span>
      <span class="notif-title">${escapeHtml(alert.headerText)}</span>
    </div>
    <p class="notif-body">${escapeHtml(alert.descriptionText)}</p>
    <div class="notif-card-footer">
      <span class="notif-tag">Service Alert${routes ? ` · ${escapeHtml(routes)}` : ''}</span>
    </div>
  `;

  return li;
}

// ── Data fetching ──────────────────────────────────────────────────────────────

async function loadAlerts(): Promise<void> {
  const version = ++requestVersion;
  showingNotifications = false;
  list.innerHTML = '';

  try {
    const res = await fetch('/notifications/alerts', {
      headers: authHeaders()
    });
    if (version !== requestVersion) return;
    if (res.status === 503) {
      emptyEl.textContent = 'Service alerts are temporarily unavailable.';
      emptyEl.classList.add('is-visible');
      return;
    }
    if (!res.ok) {
      emptyEl.textContent = 'Failed to load service alerts.';
      emptyEl.classList.add('is-visible');
      return;
    }
    const data = await res.json();
    if (version !== requestVersion) return;
    const alerts: IServiceAlert[] = data.payload ?? [];
    alerts.forEach((a) => list.appendChild(createAlertCard(a)));
    updateEmptyState();
  } catch {
    if (version !== requestVersion) return;
    emptyEl.textContent = 'Service alerts are temporarily unavailable.';
    emptyEl.classList.add('is-visible');
  }
}

async function searchNotifications(params: {
  route?: string;
  bus?: string;
  q?: string;
}): Promise<void> {
  const version = ++requestVersion;
  showingNotifications = true;
  list.innerHTML = '';

  const qs = new URLSearchParams();
  if (params.route) qs.set('route', params.route);
  if (params.bus) qs.set('bus', params.bus);

  const query = [params.route, params.bus, params.q].filter(Boolean).join(' ');

  try {
    // Fetch both notifications and service alerts in parallel
    const [notifRes, alertRes] = await Promise.all([
      fetch(`/notifications/notifications?${qs}`, { headers: authHeaders() }),
      fetch('/notifications/alerts', { headers: authHeaders() })
    ]);
    if (version !== requestVersion) return;

    if (notifRes.ok) {
      const notifData = await notifRes.json();
      if (version !== requestVersion) return;
      let notifs: INotification[] = notifData.payload ?? [];
      if (params.q) {
        notifs = notifs.filter((n) =>
          matchesNotificationQuery(
            n,
            params.q!,
            resolveRouteDisplay,
            formatMessage
          )
        );
      }
      notifs.forEach((n) => list.appendChild(createNotifCard(n)));
    }

    // Filter service alerts client-side by query text
    if (alertRes.ok) {
      const alertData = await alertRes.json();
      if (version !== requestVersion) return;
      const alerts: IServiceAlert[] = alertData.payload ?? [];
      const matched = query
        ? alerts.filter((a) => matchesAlertQuery(a, query, resolveRouteDisplay))
        : [];
      matched.forEach((a) => list.appendChild(createAlertCard(a)));
    }

    updateEmptyState(query || undefined);
  } catch {
    if (version !== requestVersion) return;
    emptyEl.textContent = 'Failed to load notifications.';
    emptyEl.classList.add('is-visible');
  }
}

// ── URL pre-fill (A14) ─────────────────────────────────────────────────────────

function getPreFill(): { route?: string; bus?: string } {
  const params = new URLSearchParams(window.location.search);
  const route = params.get('route') ?? undefined;
  const bus = params.get('bus') ?? undefined;
  return { route, bus };
}

// ── Socket.io — live alertUpdate refresh ───────────────────────────────────────

function connectForAlerts(): void {
  const token = getToken();
  if (!token) return;

  const socket = io({ query: { token } });
  socket.on('alertUpdate', () => {
    // Refresh alert display only if we're not showing a search result
    if (!showingNotifications) {
      loadAlerts();
    }
  });
}

// ── Search bar ─────────────────────────────────────────────────────────────────

let debounceTimer: ReturnType<typeof setTimeout> | null = null;

function handleSearchInput(): void {
  requestVersion++;
  const query = searchInput.value.trim();
  clearBtn.classList.toggle('is-visible', query.length > 0);

  if (debounceTimer) clearTimeout(debounceTimer);

  if (!query) {
    loadAlerts();
    return;
  }

  debounceTimer = setTimeout(() => {
    // Decide search strategy based on pre-fill context or detected pattern
    const preFill = getPreFill();
    if (preFill.route && query === preFill.route) {
      searchNotifications({ route: query });
    } else if (preFill.bus && query === preFill.bus) {
      searchNotifications({ bus: query });
    } else {
      // General text search — server picks strategy based on content
      searchNotifications({ q: query });
    }
  }, 300);
}

// ── Init ───────────────────────────────────────────────────────────────────────

async function init(): Promise<void> {
  const token = getToken();
  if (!token) {
    window.location.replace('/auth');
    return;
  }

  connectForAlerts();

  await fetchRoutesForDisplay();

  const { route, bus } = getPreFill();

  if (route || bus) {
    // A14: pre-filled from external navigation
    const displayValue = route ?? bus ?? '';
    searchInput.value = displayValue;
    clearBtn.classList.add('is-visible');
    await searchNotifications({ route, bus });
  } else {
    // Default: show GTFS-RT alerts
    await loadAlerts();
  }

  searchInput.addEventListener('input', handleSearchInput);

  clearBtn.addEventListener('click', () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    searchInput.value = '';
    clearBtn.classList.remove('is-visible');
    // Clear URL params without reload
    history.replaceState(null, '', window.location.pathname);
    loadAlerts();
    searchInput.focus();
  });
}

init();

export {};

import './components/app-header';
import './components/live-notifications';
import { escapeHtml } from './utils/html';
import {
  buildRouteDisplayMap,
  getRouteDisplay,
  normalizeRouteId,
  type IRouteDisplayMeta
} from './utils/route-display';

const MAX_SUBSCRIPTIONS = 10;
const MUTED_ROUTES_KEY = 'scottygo_muted_routes';

function routeIdsEqual(a: string, b: string): boolean {
  return normalizeRouteId(a) === normalizeRouteId(b);
}

interface Subscription {
  _id?: string;
  routeId: string;
  createdAt: string;
}

// ── Mute helpers (mirrors live-notifications.ts) ───────────────────────────────

function getMutedRoutes(): Set<string> {
  try {
    const arr = JSON.parse(localStorage.getItem(MUTED_ROUTES_KEY) ?? '[]');
    return new Set(Array.isArray(arr) ? arr : []);
  } catch {
    return new Set();
  }
}

function saveMutedRoutes(routes: Set<string>): void {
  localStorage.setItem(MUTED_ROUTES_KEY, JSON.stringify([...routes]));
}

// ── Auth ───────────────────────────────────────────────────────────────────────

function getToken(): string {
  return localStorage.getItem('token') ?? '';
}

function authHeaders(): Record<string, string> {
  return { Authorization: `Bearer ${getToken()}` };
}

// ── Toast ──────────────────────────────────────────────────────────────────────

function showToast(message: string): void {
  const toast = document.createElement('div');
  toast.className = 'toast-notification';
  toast.textContent = message;
  toast.style.cssText = `
    position:fixed;bottom:20px;left:50%;transform:translateX(-50%);
    background:rgba(0,0,0,0.8);color:#fff;padding:12px 24px;
    border-radius:8px;z-index:10000;font-size:14px;
    box-shadow:0 4px 12px rgba(0,0,0,0.3);
  `;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 4000);
}

// ── State ──────────────────────────────────────────────────────────────────────

let subscriptions: Subscription[] = [];
let allRoutes: IRouteDisplayMeta[] = [];
let routeDisplayById = new Map<string, IRouteDisplayMeta>();
let mutationPending = false;
/** Most recent notification createdAt per routeId (from last 30 min). */
const latestNotifTime = new Map<string, string>();

// ── API helpers ────────────────────────────────────────────────────────────────

async function fetchSubscriptions(): Promise<void> {
  const res = await fetch('/notifications/subscriptions', {
    headers: authHeaders()
  });
  if (!res.ok)
    throw new Error(
      'Could not load subscriptions. Please reload to try again.'
    );
  const data = await res.json();
  subscriptions = data.payload ?? [];
}

async function fetchRecentNotifications(): Promise<void> {
  const res = await fetch('/notifications/notifications', {
    headers: authHeaders()
  });
  if (!res.ok) return;
  const data = await res.json();
  const notifs: { routeId: string; createdAt: string }[] = data.payload ?? [];
  latestNotifTime.clear();
  // Notifications are sorted newest-first, so first hit per route is the latest
  for (const n of notifs) {
    if (!latestNotifTime.has(n.routeId)) {
      latestNotifTime.set(n.routeId, n.createdAt);
    }
  }
}

async function fetchRoutes(): Promise<void> {
  const res = await fetch('/transit/routes', { headers: authHeaders() });
  if (!res.ok) return;
  const data = await res.json();
  // Payload is IRoute[] — extract id and name
  allRoutes = (data.payload ?? []).map(
    (r: { id: string; name: string; system?: 'PRT' | 'CMU' }) => ({
      id: r.id,
      name: r.name ?? `Route ${r.id}`,
      system: r.system
    })
  );
  routeDisplayById = buildRouteDisplayMap(allRoutes);
}

async function apiSubscribe(
  routeId: string
): Promise<{ ok: boolean; error?: string }> {
  const res = await fetch('/notifications/subscriptions', {
    method: 'POST',
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ routeId })
  });
  const data = await res.json();
  if (res.status === 201) return { ok: true };
  return { ok: false, error: data.message ?? 'Failed to subscribe.' };
}

async function apiUnsubscribe(routeId: string): Promise<{ ok: boolean }> {
  const res = await fetch(
    `/notifications/subscriptions/${encodeURIComponent(routeId)}`,
    {
      method: 'DELETE',
      headers: authHeaders()
    }
  );
  return { ok: res.ok || res.status === 404 };
}

// ── SVG icons ──────────────────────────────────────────────────────────────────

const busIconSVG = `
  <svg xmlns="http://www.w3.org/2000/svg" height="24px" viewBox="0 -960 960 960" width="24px" fill="currentColor">
    <path d="M240-120q-17 0-28.5-11.5T200-160v-82q-18-20-29-44.5T160-340v-380q0-83 77-121.5T480-880q172 0 246 37t74 123v380q0 29-11 53.5T760-242v82q0 17-11.5 28.5T720-120h-40q-17 0-28.5-11.5T640-160v-40H320v40q0 17-11.5 28.5T280-120h-40Zm242-640h224-448 224Zm158 280H240h480-80Zm-400-80h480v-120H240v120Zm142.5 222.5Q400-355 400-380t-17.5-42.5Q365-440 340-440t-42.5 17.5Q280-405 280-380t17.5 42.5Q315-320 340-320t42.5-17.5Zm280 0Q680-355 680-380t-17.5-42.5Q645-440 620-440t-42.5 17.5Q560-405 560-380t17.5 42.5Q595-320 620-320t42.5-17.5ZM258-760h448q-15-17-64.5-28.5T482-800q-107 0-156.5 12.5T258-760Zm62 480h320q33 0 56.5-23.5T720-360v-120H240v120q0 33 23.5 56.5T320-280Z"/>
  </svg>`;

const bellOnSVG = `
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"></path>
    <path d="M13.73 21a2 2 0 0 1-3.46 0"></path>
  </svg>`;

const bellOffSVG = `
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"></path>
    <path d="M13.73 21a2 2 0 0 1-3.46 0"></path>
    <line x1="1" y1="1" x2="23" y2="23"></line>
  </svg>`;

const chevronSVG = `
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
    <polyline points="9 18 15 12 9 6"></polyline>
  </svg>`;

const xSVG = `
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
    <line x1="18" y1="6" x2="6" y2="18"></line>
    <line x1="6" y1="6" x2="18" y2="18"></line>
  </svg>`;

// ── Render ─────────────────────────────────────────────────────────────────────

function updateCount(): void {
  const btn = document.getElementById('add-route-btn') as HTMLButtonElement;
  const labelEl = btn.querySelector('span:first-child')!;
  const countEl = document.getElementById('route-count')!;
  const dividerEl = btn.querySelector('.add-route-divider') as HTMLElement;
  const atLimit = subscriptions.length >= MAX_SUBSCRIPTIONS;

  countEl.textContent = `${subscriptions.length}/${MAX_SUBSCRIPTIONS}`;
  labelEl.textContent = atLimit ? 'Limit reached' : '+ Add route';
  dividerEl.style.display = atLimit ? 'none' : '';
  btn.classList.toggle('is-disabled', atLimit);
  btn.disabled = atLimit;
}

function formatAgo(isoTimestamp: string): string {
  const mins = Math.round(
    (Date.now() - new Date(isoTimestamp).getTime()) / 60_000
  );
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  return `${Math.floor(mins / 60)}h ago`;
}

function createCard(sub: Subscription): HTMLLIElement {
  const normalizedRouteId = normalizeRouteId(sub.routeId);
  const muted = getMutedRoutes().has(normalizedRouteId);
  const display = getRouteDisplay(sub.routeId, routeDisplayById);
  const li = document.createElement('li');
  li.classList.add('subscription-card');
  li.dataset.routeId = sub.routeId;

  const notifTime = latestNotifTime.get(sub.routeId);
  const updatedText = notifTime
    ? `Updated ${formatAgo(notifTime)}`
    : sub.createdAt
      ? `Subscribed ${formatAgo(sub.createdAt)}`
      : '';

  li.innerHTML = `
    <div class="card-icon-circle">${busIconSVG}</div>
    <div class="card-info">
      <a class="card-route-link" href="/notifications?route=${encodeURIComponent(sub.routeId)}">
        ${escapeHtml(display.title)} ${chevronSVG}
      </a>
      <div class="card-last-updated">${escapeHtml(display.subtitle)}</div>
      ${updatedText ? `<div class="card-last-updated">${updatedText}</div>` : ''}
    </div>
    <div class="card-actions">
      <button class="card-bell ${muted ? 'muted' : ''}" aria-label="${muted ? 'Unmute' : 'Mute'} notifications">
        ${muted ? bellOffSVG : bellOnSVG}
      </button>
      <button class="card-remove" aria-label="Remove subscription">${xSVG}</button>
    </div>
  `;

  // Remove subscription (A7)
  li.querySelector<HTMLButtonElement>('.card-remove')!.addEventListener(
    'click',
    async () => {
      if (mutationPending) return;
      mutationPending = true;
      const button = li.querySelector<HTMLButtonElement>('.card-remove')!;
      button.disabled = true;
      try {
        const { ok } = await apiUnsubscribe(sub.routeId);
        await fetchSubscriptions();
        const stillSubscribed = subscriptions.some((s) =>
          routeIdsEqual(s.routeId, sub.routeId)
        );
        if (!ok || stillSubscribed) throw new Error('Unsubscribe failed');
        document.dispatchEvent(
          new CustomEvent('notifRouteLeave', {
            detail: { routeId: sub.routeId }
          })
        );
      } catch {
        showToast('Failed to remove subscription. Please try again.');
      } finally {
        mutationPending = false;
        renderList();
        renderSheetResults(
          (document.getElementById('route-search-input') as HTMLInputElement)
            .value
        );
      }
    }
  );

  // Bell toggle — mute/unmute popups (A6), no server call
  const bellBtn = li.querySelector<HTMLButtonElement>('.card-bell')!;
  bellBtn.addEventListener('click', () => {
    const mutedRoutes = getMutedRoutes();
    const nowMuted = !mutedRoutes.has(normalizedRouteId);
    if (nowMuted) {
      mutedRoutes.add(normalizedRouteId);
      document.dispatchEvent(
        new CustomEvent('notifRouteMute', { detail: { routeId: sub.routeId } })
      );
    } else {
      mutedRoutes.delete(normalizedRouteId);
      document.dispatchEvent(
        new CustomEvent('notifRouteUnmute', {
          detail: { routeId: sub.routeId }
        })
      );
    }
    saveMutedRoutes(mutedRoutes);
    bellBtn.classList.toggle('muted', nowMuted);
    bellBtn.innerHTML = nowMuted ? bellOffSVG : bellOnSVG;
    bellBtn.setAttribute(
      'aria-label',
      `${nowMuted ? 'Unmute' : 'Mute'} notifications`
    );
  });

  return li;
}

function renderEmptyState(): void {
  const list = document.getElementById('subscription-list')!;
  let empty = document.getElementById('subscription-empty');
  if (subscriptions.length === 0) {
    if (!empty) {
      empty = document.createElement('p');
      empty.id = 'subscription-empty';
      empty.className = 'subscription-empty';
      empty.textContent =
        'No subscriptions yet. Use the map to subscribe to routes, or tap + to add one.';
      list.insertAdjacentElement('afterend', empty);
    }
  } else {
    empty?.remove();
  }
}

function renderList(): void {
  const list = document.getElementById('subscription-list')!;
  list.innerHTML = '';
  subscriptions.forEach((sub) => list.appendChild(createCard(sub)));
  updateCount();
  renderEmptyState();
}

function getFilteredRoutes(query: string): IRouteDisplayMeta[] {
  const lowerQ = query.toLowerCase();
  if (!query) return allRoutes;

  return allRoutes.filter(
    (route) =>
      route.id.toLowerCase().includes(lowerQ) ||
      route.name.toLowerCase().includes(lowerQ)
  );
}

async function toggleSubscriptionFromSheet(routeId: string): Promise<void> {
  const alreadySubscribed = subscriptions.some((s) => s.routeId === routeId);
  if (alreadySubscribed) {
    const { ok } = await apiUnsubscribe(routeId);
    if (ok) {
      subscriptions = subscriptions.filter((s) => s.routeId !== routeId);
      document.dispatchEvent(
        new CustomEvent('notifRouteLeave', {
          detail: { routeId }
        })
      );
    } else {
      showToast('Failed to remove subscription. Please try again.');
    }
    return;
  }

  if (subscriptions.length >= MAX_SUBSCRIPTIONS) return;

  const { ok, error } = await apiSubscribe(routeId);
  if (ok) {
    await fetchSubscriptions();
    document.dispatchEvent(
      new CustomEvent('notifRouteJoin', { detail: { routeId } })
    );
    return;
  }

  if (error?.includes('already subscribed')) {
    showToast(`You are already subscribed to Route ${routeId}.`);
    await fetchSubscriptions();
    return;
  }

  showToast(error ?? 'Failed to subscribe.');
}

function renderSheetResults(query: string): void {
  const results = document.getElementById('sheet-results')!;
  const filteredRoutes = getFilteredRoutes(query);

  results.innerHTML = '';
  filteredRoutes.forEach((route) => {
    const isSubscribed = subscriptions.some((s) => s.routeId === route.id);
    const display = getRouteDisplay(route.id, routeDisplayById);
    const li = document.createElement('li');
    li.classList.add('sheet-result-item');
    li.innerHTML = `
      <div class="result-icon-circle">${busIconSVG}</div>
      <div class="result-info">
        <div class="result-name">${escapeHtml(display.title)}</div>
        <div class="result-destination">${escapeHtml(display.subtitle)}</div>
      </div>
      <button class="result-add-btn ${isSubscribed ? 'subscribed' : ''}" aria-label="${isSubscribed ? 'Remove' : 'Add'} Route ${escapeHtml(route.id)}">
        +
      </button>
    `;

    const addBtn = li.querySelector<HTMLButtonElement>('.result-add-btn')!;
    addBtn.addEventListener('click', async () => {
      if (mutationPending) return;
      mutationPending = true;
      addBtn.disabled = true;
      try {
        await toggleSubscriptionFromSheet(route.id);
      } catch {
        showToast('Could not update subscription. Please try again.');
      } finally {
        mutationPending = false;
        renderList();
        renderSheetResults(
          (document.getElementById('route-search-input') as HTMLInputElement)
            .value
        );
      }
    });

    results.appendChild(li);
  });
}

// ── Bottom sheet ───────────────────────────────────────────────────────────────

function initSheet(): void {
  const addBtn = document.getElementById('add-route-btn')!;
  const overlay = document.getElementById('sheet-overlay')!;
  const sheet = document.getElementById('bottom-sheet')!;
  const input = document.getElementById(
    'route-search-input'
  ) as HTMLInputElement;

  function openSheet(): void {
    overlay.classList.add('is-active');
    sheet.classList.add('is-active');
    sheet.removeAttribute('inert');
    renderSheetResults('');
    input.focus();
  }

  function closeSheet(): void {
    overlay.classList.remove('is-active');
    sheet.classList.remove('is-active');
    sheet.setAttribute('inert', '');
    input.value = '';
    addBtn.focus();
  }

  addBtn.addEventListener('click', () => {
    if (subscriptions.length >= MAX_SUBSCRIPTIONS) return;
    openSheet();
  });
  overlay.addEventListener('click', closeSheet);
  document.getElementById('sheet-close')?.addEventListener('click', closeSheet);
  sheet.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      closeSheet();
    } else if (event.key === 'Tab') {
      const focusable = Array.from(
        sheet.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]), a[href]'
        )
      );
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    }
  });
  input.addEventListener('input', () => renderSheetResults(input.value.trim()));
}

// ── Init ───────────────────────────────────────────────────────────────────────

async function init(): Promise<void> {
  const token = localStorage.getItem('token');
  if (!token) {
    window.location.replace('/auth');
    return;
  }

  const results = await Promise.allSettled([
    fetchSubscriptions(),
    fetchRoutes(),
    fetchRecentNotifications()
  ]);
  if (results.some((result) => result.status === 'rejected')) {
    showToast(
      'Some subscription data could not be loaded. Please reload to try again.'
    );
  }
  renderList();
  initSheet();
}

init();

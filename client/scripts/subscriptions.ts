// Subscriptions page: saved routes, per-route popup muting, and the
// add-route sheet.

import './components/app-header';
import './components/live-notifications';
import { escapeHtml } from './utils/html';
import { showToast } from './utils/toast';
import { isRouteMuted } from './utils/muted-routes';
import {
  buildRouteDisplayMap,
  getRouteDisplay,
  normalizeRouteId,
  type IRouteDisplayMeta
} from './utils/route-display';
import { authHeaders, getToken } from './services/session';
import { MAX_SUBSCRIPTIONS_PER_USER } from '../../common/limits';

function routeIdsEqual(a: string, b: string): boolean {
  return normalizeRouteId(a) === normalizeRouteId(b);
}

interface Subscription {
  _id?: string;
  routeId: string;
  createdAt: string;
}

// ── State ──────────────────────────────────────────────────────────────────────

let subscriptions: Subscription[] = [];
let allRoutes: IRouteDisplayMeta[] = [];
let routeDisplayById = new Map<string, IRouteDisplayMeta>();
let mutationPending = false;
type LoadState = 'loading' | 'ready' | 'error';
let subscriptionsState: LoadState = 'loading';
let routesState: LoadState = 'loading';
let pendingRouteId: string | null = null;
/** Most recent notification createdAt per routeId (from last 30 min). */
const latestNotifTime = new Map<string, string>();

// ── API helpers ────────────────────────────────────────────────────────────────

async function fetchSubscriptions(): Promise<void> {
  const res = await fetch('/notifications/subscriptions', {
    headers: authHeaders()
  });
  if (!res.ok) throw new Error('Could not load saved routes.');
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
  if (!res.ok) throw new Error('Could not load routes.');
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
): Promise<{ ok: boolean; subscription?: Subscription; error?: string }> {
  const res = await fetch('/notifications/subscriptions', {
    method: 'POST',
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ routeId })
  }).catch(() => {
    throw new Error('Could not save this route. Please try again.');
  });
  const data = await res.json();
  if (res.status === 201) return { ok: true, subscription: data.payload };
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

const removeSVG = `
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M3 6h18M9 6V4h6v2M5 6l1 14h12l1-14M10 10v6M14 10v6"></path>
  </svg>`;

// ── Render ─────────────────────────────────────────────────────────────────────

function updateCount(): void {
  const btn = document.getElementById('add-route-btn') as HTMLButtonElement;
  const labelEl = btn.querySelector('span:first-child')!;
  const countEl = document.getElementById('route-count')!;
  const dividerEl = btn.querySelector('.add-route-divider') as HTMLElement;
  const atLimit = subscriptions.length >= MAX_SUBSCRIPTIONS_PER_USER;

  countEl.textContent =
    subscriptionsState === 'ready'
      ? `${subscriptions.length}/${MAX_SUBSCRIPTIONS_PER_USER}`
      : '—';
  labelEl.textContent = atLimit ? 'Limit reached' : '+ Add route';
  dividerEl.style.display = atLimit ? 'none' : '';
  btn.disabled = atLimit || subscriptionsState !== 'ready';
  btn.classList.toggle('is-disabled', btn.disabled);
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
  const muted = isRouteMuted(sub.routeId);
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
      <button class="card-bell ${muted ? 'muted' : ''}" aria-label="${muted ? 'Unmute' : 'Mute'} notifications for ${escapeHtml(display.title)}" aria-pressed="${muted}">
        ${muted ? bellOffSVG : bellOnSVG}
      </button>
      <button class="card-remove" title="Remove saved route" aria-label="Remove ${escapeHtml(display.title)} from saved routes">${removeSVG}</button>
    </div>
  `;

  // Remove subscription (A7)
  li.querySelector<HTMLButtonElement>('.card-remove')!.addEventListener(
    'click',
    async () => {
      if (mutationPending) return;
      mutationPending = true;
      const button = li.querySelector<HTMLButtonElement>('.card-remove')!;
      const cardIndex = subscriptions.findIndex((s) =>
        routeIdsEqual(s.routeId, sub.routeId)
      );
      updateMutationControls();
      let removed = false;
      try {
        const { ok } = await apiUnsubscribe(sub.routeId);
        if (!ok) throw new Error('Unsubscribe failed');
        subscriptions = subscriptions.filter(
          (s) => !routeIdsEqual(s.routeId, sub.routeId)
        );
        removed = true;
        document.dispatchEvent(
          new CustomEvent('notifRouteLeave', {
            detail: { routeId: sub.routeId }
          })
        );
        showToast(`${display.title} removed.`);
      } catch {
        showToast('Failed to remove subscription. Please try again.');
      } finally {
        mutationPending = false;
        const restoreFocus =
          document.activeElement === button ||
          document.activeElement === document.body;
        if (removed) {
          renderList();
          if (restoreFocus) {
            const buttons =
              document.querySelectorAll<HTMLButtonElement>('.card-remove');
            (
              buttons[Math.min(cardIndex, buttons.length - 1)] ??
              document.getElementById('add-route-btn')
            )?.focus({ preventScroll: true });
          }
        }
        updateMutationControls();
      }
    }
  );

  // Bell toggle — mute/unmute popups (A6), no server call
  const bellBtn = li.querySelector<HTMLButtonElement>('.card-bell')!;
  bellBtn.addEventListener('click', () => {
    // The live-notifications module persists the choice and updates rooms.
    const nowMuted = !isRouteMuted(sub.routeId);
    document.dispatchEvent(
      new CustomEvent(nowMuted ? 'notifRouteMute' : 'notifRouteUnmute', {
        detail: { routeId: sub.routeId }
      })
    );
    bellBtn.classList.toggle('muted', nowMuted);
    bellBtn.innerHTML = nowMuted ? bellOffSVG : bellOnSVG;
    bellBtn.setAttribute(
      'aria-label',
      `${nowMuted ? 'Unmute' : 'Mute'} notifications for ${display.title}`
    );
    bellBtn.setAttribute('aria-pressed', String(nowMuted));
    showToast(`${display.title} alerts ${nowMuted ? 'muted' : 'unmuted'}.`);
  });

  return li;
}

function renderEmptyState(): void {
  const list = document.getElementById('subscription-list')!;
  let empty = document.getElementById('subscription-empty');
  if (subscriptionsState === 'ready' && subscriptions.length === 0) {
    if (!empty) {
      empty = document.createElement('p');
      empty.id = 'subscription-empty';
      empty.className = 'subscription-empty';
      empty.textContent =
        'Save your everyday routes to keep their alerts together. Tap Add route to get started.';
      list.insertAdjacentElement('afterend', empty);
    }
  } else {
    empty?.remove();
  }
}

function renderList(): void {
  const list = document.getElementById('subscription-list')!;
  const active = document.activeElement as HTMLElement | null;
  const focusedRoute = list.contains(active)
    ? active?.closest<HTMLElement>('.subscription-card')?.dataset.routeId
    : undefined;
  const focusedClass = active?.classList.contains('card-remove')
    ? 'card-remove'
    : active?.classList.contains('card-bell')
      ? 'card-bell'
      : 'card-route-link';
  const content = document.querySelector<HTMLElement>('main')!;
  const scrollTop = content.scrollTop;
  list.innerHTML = '';
  subscriptions.forEach((sub) => list.appendChild(createCard(sub)));
  updateCount();
  renderEmptyState();
  const status = document.getElementById('subscription-status')!;
  status.textContent =
    subscriptionsState === 'loading'
      ? 'Loading your saved routes…'
      : subscriptionsState === 'error'
        ? 'Your saved routes could not be loaded.'
        : '';
  list.setAttribute('aria-busy', String(subscriptionsState === 'loading'));
  document.getElementById('subscriptions-retry')!.hidden =
    subscriptionsState !== 'error';
  if (focusedRoute) {
    Array.from(list.querySelectorAll<HTMLElement>('.subscription-card'))
      .find((card) => card.dataset.routeId === focusedRoute)
      ?.querySelector<HTMLElement>(`.${focusedClass}`)
      ?.focus({ preventScroll: true });
  }
  content.scrollTop = scrollTop;
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

async function saveRoute(routeId: string): Promise<void> {
  const { ok, subscription, error } = await apiSubscribe(routeId);
  if (ok) {
    subscriptions.push(
      subscription ?? { routeId, createdAt: new Date().toISOString() }
    );
    document.dispatchEvent(
      new CustomEvent('notifRouteJoin', { detail: { routeId } })
    );
    setSheetFeedback(
      `${getRouteDisplay(routeId, routeDisplayById).title} saved.`
    );
    return;
  }

  if (error?.includes('already subscribed')) {
    await fetchSubscriptions();
    setSheetFeedback('This route is already saved.');
    return;
  }

  throw new Error(error ?? 'Could not save this route. Please try again.');
}

function setSheetFeedback(message: string, error = false): void {
  const feedback = document.getElementById('sheet-feedback')!;
  feedback.textContent = message;
  feedback.classList.toggle('is-error', error);
}

/** Update controls in place so saving never resets the list or its focus. */
function updateMutationControls(): void {
  document
    .querySelectorAll<HTMLButtonElement>('.card-remove')
    .forEach((button) => {
      button.disabled = mutationPending;
    });
  const atLimit = subscriptions.length >= MAX_SUBSCRIPTIONS_PER_USER;
  document
    .querySelectorAll<HTMLLIElement>('.sheet-result-item')
    .forEach((item) => {
      const routeId = item.dataset.routeId!;
      const saved = subscriptions.some((s) =>
        routeIdsEqual(s.routeId, routeId)
      );
      const pending = mutationPending && pendingRouteId === routeId;
      const button = item.querySelector<HTMLButtonElement>('.result-add-btn')!;
      button.classList.toggle('subscribed', saved);
      button.textContent = pending ? 'Saving…' : saved ? '✓ Saved' : '+ Save';
      // Native disabling blurs the active button in browsers. Keep the saving
      // control in place and use aria-disabled plus the mutation guard.
      button.disabled = mutationPending && !pending;
      // Keep a newly saved control focusable; repeated activation is a no-op.
      button.setAttribute(
        'aria-disabled',
        String(saved || atLimit || mutationPending)
      );
      button.setAttribute('aria-busy', String(pending));
      const title = getRouteDisplay(routeId, routeDisplayById).title;
      button.setAttribute(
        'aria-label',
        saved
          ? `${title} saved`
          : atLimit
            ? `Save ${title}, limit reached`
            : `Save ${title}`
      );
    });
  updateCount();
  updateSheetStatus();
}

function currentQuery(): string {
  return (
    document.getElementById('route-search-input') as HTMLInputElement
  ).value.trim();
}

function updateSheetStatus(): void {
  const status = document.getElementById('sheet-status')!;
  const query = currentQuery();
  const count = getFilteredRoutes(query).length;
  status.textContent =
    routesState === 'loading'
      ? 'Loading routes…'
      : routesState === 'error'
        ? 'Routes could not be loaded. Try again.'
        : count === 0
          ? query
            ? `No routes match “${query}”. Try a route number or name.`
            : 'No routes are available yet. Try again shortly.'
          : subscriptions.length >= MAX_SUBSCRIPTIONS_PER_USER
            ? '10 routes saved. Remove a route from your saved list to add another.'
            : `${count} ${count === 1 ? 'route' : 'routes'} · ${subscriptions.length} of ${MAX_SUBSCRIPTIONS_PER_USER} saved`;
  document.getElementById('routes-retry')!.hidden =
    routesState !== 'error' &&
    !(routesState === 'ready' && allRoutes.length === 0);
  document
    .getElementById('sheet-results')!
    .setAttribute('aria-busy', String(routesState === 'loading'));
}

function renderSheetResults(query: string): void {
  const results = document.getElementById('sheet-results')!;
  const filteredRoutes =
    routesState === 'ready' ? getFilteredRoutes(query) : [];

  results.innerHTML = '';
  filteredRoutes.forEach((route) => {
    const display = getRouteDisplay(route.id, routeDisplayById);
    const li = document.createElement('li');
    li.classList.add('sheet-result-item');
    li.dataset.routeId = route.id;
    li.innerHTML = `
      <div class="result-icon-circle">${busIconSVG}</div>
      <div class="result-info">
        <div class="result-name">${escapeHtml(display.title)}</div>
        <div class="result-destination">${escapeHtml(display.subtitle)}</div>
      </div>
      <button class="result-add-btn" type="button"></button>
    `;

    const addBtn = li.querySelector<HTMLButtonElement>('.result-add-btn')!;
    addBtn.addEventListener('click', async () => {
      if (
        mutationPending ||
        subscriptionsState !== 'ready' ||
        subscriptions.some((s) => routeIdsEqual(s.routeId, route.id)) ||
        subscriptions.length >= MAX_SUBSCRIPTIONS_PER_USER
      )
        return;
      mutationPending = true;
      pendingRouteId = route.id;
      setSheetFeedback('');
      updateMutationControls();
      try {
        await saveRoute(route.id);
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : 'Could not save this route. Please try again.';
        setSheetFeedback(message, true);
      } finally {
        mutationPending = false;
        pendingRouteId = null;
        renderList();
        updateMutationControls();
      }
    });

    results.appendChild(li);
  });
  updateMutationControls();
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
    setSheetFeedback('');
    input.focus();
  }

  function closeSheet(): void {
    overlay.classList.remove('is-active');
    sheet.classList.remove('is-active');
    sheet.setAttribute('inert', '');
    input.value = '';
    // Reaching the limit while this dialog is open disables its opener.
    const target = (addBtn as HTMLButtonElement).disabled
      ? document.querySelector<HTMLElement>('.card-route-link')
      : addBtn;
    target?.focus();
  }

  addBtn.addEventListener('click', () => {
    if (subscriptions.length >= MAX_SUBSCRIPTIONS_PER_USER) return;
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
      ).filter((element) => !element.closest('[hidden], [inert]'));
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
  input.addEventListener('input', () => {
    setSheetFeedback('');
    renderSheetResults(input.value.trim());
  });
}

// ── Init ───────────────────────────────────────────────────────────────────────

async function loadSubscriptions(): Promise<void> {
  const retry = document.getElementById('subscriptions-retry')!;
  const restoreFocus = document.activeElement === retry;
  subscriptionsState = 'loading';
  renderList();
  try {
    await fetchSubscriptions();
    subscriptionsState = 'ready';
  } catch {
    subscriptionsState = 'error';
  }
  renderList();
  if (
    restoreFocus &&
    (document.activeElement === retry ||
      document.activeElement === document.body)
  ) {
    (subscriptionsState === 'ready'
      ? (document.querySelector<HTMLElement>('.card-route-link') ??
        document.getElementById('add-route-btn'))
      : retry
    )?.focus();
  }
}

async function loadRoutes(): Promise<void> {
  const retry = document.getElementById('routes-retry')!;
  const restoreFocus = document.activeElement === retry;
  routesState = 'loading';
  renderSheetResults(currentQuery());
  try {
    await fetchRoutes();
    routesState = 'ready';
  } catch {
    routesState = 'error';
  }
  renderList();
  renderSheetResults(currentQuery());
  if (
    restoreFocus &&
    (document.activeElement === retry ||
      document.activeElement === document.body)
  ) {
    (routesState === 'ready'
      ? document.getElementById('route-search-input')
      : retry
    )?.focus();
  }
}

async function init(): Promise<void> {
  if (!getToken()) {
    window.location.replace('/auth');
    return;
  }

  initSheet();
  document
    .getElementById('subscriptions-retry')!
    .addEventListener('click', () => {
      void loadSubscriptions();
    });
  document.getElementById('routes-retry')!.addEventListener('click', () => {
    void loadRoutes();
  });
  await Promise.allSettled([
    loadSubscriptions(),
    loadRoutes(),
    fetchRecentNotifications().then(() => renderList())
  ]);
}

init();

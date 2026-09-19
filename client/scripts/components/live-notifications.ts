/**
 * Live Notification Popups Component
 * Connects to Socket.io, joins route rooms for active subscriptions, and shows
 * toast-style popup cards when a liveNotification event arrives.
 *
 * Mute state is stored in localStorage under MUTED_ROUTES_KEY. When a route is
 * muted the socket room is left and popups are suppressed; unmuting rejoins.
 *
 * Other scripts interact via custom DOM events:
 *   notifRouteJoin   { routeId } — subscribe + unmute
 *   notifRouteLeave  { routeId } — unsubscribe (full delete)
 *   notifRouteMute   { routeId } — leave room but keep subscription card
 *   notifRouteUnmute { routeId } — rejoin room
 *
 * Usage: import this file on any page — it self-initialises on DOMContentLoaded.
 */

import { io, Socket } from 'socket.io-client';
import { escapeHtml } from '../utils/html';
import type {
  ServerToClientEvents,
  ClientToServerEvents
} from '../../../common/socket.interface';
import type { INotification } from '../../../common/transit.interface';
import {
  fetchRouteDisplayMap,
  formatNotificationMessage,
  getRouteTitle,
  normalizeRouteId,
  type IRouteDisplayMeta
} from '../utils/route-display';

const MUTED_ROUTES_KEY = 'scottygo_muted_routes';

// ── Mute helpers ──────────────────────────────────────────────────────────────

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

export function muteRoute(routeId: string): void {
  const muted = getMutedRoutes();
  muted.add(normalizeRouteId(routeId));
  saveMutedRoutes(muted);
}

export function unmuteRoute(routeId: string): void {
  const muted = getMutedRoutes();
  muted.delete(normalizeRouteId(routeId));
  saveMutedRoutes(muted);
}

export function isRouteMuted(routeId: string): boolean {
  return getMutedRoutes().has(normalizeRouteId(routeId));
}

// ── Socket management ─────────────────────────────────────────────────────────

let socket: Socket<ServerToClientEvents, ClientToServerEvents> | null = null;
let routeDisplayById = new Map<string, IRouteDisplayMeta>();

// Routes we want to be in — joined when socket connects (and on reconnect).
const activeRoutes = new Set<string>();

function joinRoute(routeId: string): void {
  activeRoutes.add(routeId);
  socket?.emit('subscribeRoute', { routeId });
}

function leaveRoute(routeId: string): void {
  activeRoutes.delete(routeId);
  socket?.emit('unsubscribeRoute', { routeId });
}

function connect(): void {
  const token = localStorage.getItem('token');
  if (!token || socket) return;

  socket = io({ query: { token } });

  socket.on('connect', () => {
    // Rejoin all tracked rooms on (re)connect
    activeRoutes.forEach((routeId) => {
      socket!.emit('subscribeRoute', { routeId });
    });
  });

  socket.on('liveNotification', (notif: INotification) => {
    if (!isRouteMuted(notif.routeId)) {
      showPopup(notif);
    }
  });
}

// ── DOM events from other scripts ─────────────────────────────────────────────

document.addEventListener('notifRouteJoin', (e: Event) => {
  const { routeId } = (e as CustomEvent<{ routeId: string }>).detail;
  unmuteRoute(routeId);
  joinRoute(routeId);
});

document.addEventListener('notifRouteLeave', (e: Event) => {
  const { routeId } = (e as CustomEvent<{ routeId: string }>).detail;
  leaveRoute(routeId);
});

document.addEventListener('notifRouteMute', (e: Event) => {
  const { routeId } = (e as CustomEvent<{ routeId: string }>).detail;
  muteRoute(routeId);
  leaveRoute(routeId);
});

document.addEventListener('notifRouteUnmute', (e: Event) => {
  const { routeId } = (e as CustomEvent<{ routeId: string }>).detail;
  unmuteRoute(routeId);
  joinRoute(routeId);
});

// ── Popup rendering ───────────────────────────────────────────────────────────

const NOTIF_ICON = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path><line x1="12" y1="9" x2="12" y2="13"></line><line x1="12" y1="17" x2="12.01" y2="17"></line></svg>`;

function getContainer(): HTMLElement {
  let container = document.querySelector<HTMLElement>('.live-notif-container');
  if (!container) {
    container = document.createElement('div');
    container.className = 'live-notif-container';
    document.body.appendChild(container);
  }
  return container;
}

function formatElapsed(isoTimestamp: string): string {
  const mins = Math.round(
    (Date.now() - new Date(isoTimestamp).getTime()) / 60_000
  );
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  return `${Math.floor(mins / 60)}h ago`;
}

function showPopup(notif: INotification): void {
  const container = getContainer();
  const routeTitle = getRouteTitle(notif.routeId, routeDisplayById);

  const card = document.createElement('div');
  card.className = 'live-notif-card';
  card.innerHTML = `
    <button class="live-notif-dismiss" aria-label="Dismiss notification">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
        <line x1="18" y1="6" x2="6" y2="18"></line>
        <line x1="6" y1="6" x2="18" y2="18"></line>
      </svg>
    </button>
    <div class="live-notif-header">
      <span class="live-notif-icon">${NOTIF_ICON}</span>
      <span class="live-notif-title">${escapeHtml(routeTitle)} · Bus #${escapeHtml(notif.vid ?? '')}</span>
    </div>
    <p class="live-notif-body">${escapeHtml(formatNotificationMessage(notif.message, routeDisplayById))}</p>
    <div class="live-notif-footer">
      <span class="live-notif-tag">Live Update</span>
      <span class="live-notif-time">${formatElapsed(notif.createdAt)}</span>
    </div>
  `;

  const dismiss = card.querySelector<HTMLButtonElement>('.live-notif-dismiss')!;
  dismiss.addEventListener('click', () => {
    card.classList.add('is-dismissing');
    card.addEventListener('animationend', () => card.remove(), { once: true });
  });

  container.appendChild(card);

  // Auto-dismiss after 30 seconds
  setTimeout(() => {
    if (card.isConnected) {
      card.classList.add('is-dismissing');
      card.addEventListener('animationend', () => card.remove(), {
        once: true
      });
    }
  }, 30_000);
}

// ── Initialisation ────────────────────────────────────────────────────────────

async function init(): Promise<void> {
  connect();

  const token = localStorage.getItem('token');
  if (!token) return;

  // Fetch active subscriptions and join their socket rooms (skipping muted ones)
  try {
    routeDisplayById = await fetchRouteDisplayMap({
      Authorization: `Bearer ${token}`
    });

    const res = await fetch('/notifications/subscriptions', {
      headers: { Authorization: `Bearer ${token}` }
    });
    if (!res.ok) return;
    const data = await res.json();
    const subs: { routeId: string }[] = data.payload ?? [];
    subs.forEach(({ routeId }) => {
      if (!isRouteMuted(routeId)) {
        joinRoute(routeId);
      }
    });
  } catch {
    // Best-effort: socket joins will be retried on reconnect
  }
}

document.addEventListener('DOMContentLoaded', init);

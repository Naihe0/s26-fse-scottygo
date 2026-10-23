/**
 * Live Notification Popups Component
 * Connects to Socket.io, joins route rooms for active subscriptions, and shows
 * toast-style popup cards when a liveNotification event arrives.
 *
 * Muted routes (utils/muted-routes) leave their socket room and show no
 * popups; unmuting rejoins.
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
import { LiveNotificationStack } from './live-notification-stack';
import type {
  ServerToClientEvents,
  ClientToServerEvents
} from '../../../common/socket.interface';
import type { INotification } from '../../../common/transit.interface';
import {
  fetchRouteDisplayMap,
  formatNotificationMessage,
  getRouteTitle,
  type IRouteDisplayMeta
} from '../utils/route-display';
import { isRouteMuted, setRouteMuted } from '../utils/muted-routes';
import { authHeaders, getToken } from '../services/session';

// ── Socket management ─────────────────────────────────────────────────────────

let socket: Socket<ServerToClientEvents, ClientToServerEvents> | null = null;
let routeDisplayById = new Map<string, IRouteDisplayMeta>();
let suspended = false;
let initializationVersion = 0;

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
  const token = getToken();
  if (!token || socket) return;

  socket = io({ auth: { token } });

  socket.on('connect', () => {
    // Rejoin all tracked rooms on (re)connect
    activeRoutes.forEach((routeId) => {
      socket!.emit('subscribeRoute', { routeId });
    });
  });

  socket.on('liveNotification', (notif: INotification) => {
    if (suspended) return;
    document.dispatchEvent(
      new CustomEvent('scottygo:notification', { detail: notif })
    );
    if (!isRouteMuted(notif.routeId)) {
      showPopup(notif);
    }
  });
}

// ── DOM events from other scripts ─────────────────────────────────────────────

document.addEventListener('notifRouteJoin', (e: Event) => {
  const { routeId } = (e as CustomEvent<{ routeId: string }>).detail;
  setRouteMuted(routeId, false);
  joinRoute(routeId);
});

document.addEventListener('notifRouteLeave', (e: Event) => {
  const { routeId } = (e as CustomEvent<{ routeId: string }>).detail;
  leaveRoute(routeId);
});

document.addEventListener('notifRouteMute', (e: Event) => {
  const { routeId } = (e as CustomEvent<{ routeId: string }>).detail;
  setRouteMuted(routeId, true);
  leaveRoute(routeId);
});

document.addEventListener('notifRouteUnmute', (e: Event) => {
  const { routeId } = (e as CustomEvent<{ routeId: string }>).detail;
  setRouteMuted(routeId, false);
  joinRoute(routeId);
});

// ── Popup rendering ───────────────────────────────────────────────────────────

let popupStack: LiveNotificationStack | null = null;

function showPopup(notif: INotification): void {
  popupStack ??= new LiveNotificationStack(
    (routeId) => getRouteTitle(routeId, routeDisplayById),
    (message) => formatNotificationMessage(message, routeDisplayById)
  );
  popupStack.show(notif);
}

window.addEventListener('pagehide', () => {
  suspended = true;
  initializationVersion++;
  socket?.disconnect();
  popupStack?.destroy();
  popupStack = null;
});

window.addEventListener('pageshow', (event) => {
  if (!event.persisted) return;
  suspended = false;
  socket?.connect();
  void init();
});
// ── Initialisation ────────────────────────────────────────────────────────────

async function init(): Promise<void> {
  if (suspended) return;
  const version = ++initializationVersion;
  connect();

  if (!getToken()) return;

  // Fetch active subscriptions and join their socket rooms (skipping muted ones)
  try {
    const routes = await fetchRouteDisplayMap(authHeaders());
    if (suspended || version !== initializationVersion) return;
    routeDisplayById = routes;

    const res = await fetch('/notifications/subscriptions', {
      headers: authHeaders()
    });
    if (!res.ok) return;
    const data = await res.json();
    if (suspended || version !== initializationVersion) return;
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

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
import {
  isRouteMuted,
  setRouteMuted,
  subscribeRoutePopupPreferences
} from '../utils/muted-routes';
import { authHeaders, getToken, isSameSession } from '../services/session';

// ── Socket management ─────────────────────────────────────────────────────────

let socket: Socket<ServerToClientEvents, ClientToServerEvents> | null = null;
let routeDisplayById = new Map<string, IRouteDisplayMeta>();
let suspended = false;
let initializationVersion = 0;
let socketToken: string | null = null;
let stopPreferenceWatch: (() => void) | undefined;
const subscribedRoutes = new Set<string>();

// Routes we want to be in — joined when socket connects (and on reconnect).
const activeRoutes = new Set<string>();

function joinRoute(routeId: string): void {
  subscribedRoutes.add(routeId);
  if (isRouteMuted(routeId) || activeRoutes.has(routeId)) return;
  activeRoutes.add(routeId);
  socket?.emit('subscribeRoute', { routeId });
}

function leaveRoute(routeId: string): void {
  subscribedRoutes.delete(routeId);
  activeRoutes.delete(routeId);
  socket?.emit('unsubscribeRoute', { routeId });
}

function synchronizePopupRooms(): void {
  if (suspended || !isSameSession(socketToken)) return;
  for (const routeId of subscribedRoutes) {
    if (isRouteMuted(routeId)) {
      if (activeRoutes.delete(routeId))
        socket?.emit('unsubscribeRoute', { routeId });
    } else if (!activeRoutes.has(routeId)) {
      activeRoutes.add(routeId);
      socket?.emit('subscribeRoute', { routeId });
    }
  }
}

function watchPopupPreferences(): void {
  stopPreferenceWatch?.();
  stopPreferenceWatch = subscribeRoutePopupPreferences((reason) => {
    if (suspended) return;
    if (reason === 'session' || !isSameSession(socketToken)) {
      initializationVersion++;
      socket?.disconnect();
      socket = null;
      socketToken = null;
      subscribedRoutes.clear();
      activeRoutes.clear();
      popupStack?.destroy();
      popupStack = null;
      void init();
    } else synchronizePopupRooms();
  });
}

function connect(): void {
  const token = getToken();
  if (!token || socket) return;

  socketToken = token;
  socket = io({ auth: { token } });

  socket.on('connect', () => {
    if (suspended || !isSameSession(token)) return;
    // Rejoin all tracked rooms on (re)connect
    activeRoutes.forEach((routeId) => {
      socket!.emit('subscribeRoute', { routeId });
    });
  });

  socket.on('liveNotification', (notif: INotification) => {
    if (suspended || !isSameSession(token)) return;
    document.dispatchEvent(
      new CustomEvent('scottygo:notification', { detail: notif })
    );
    if (!isRouteMuted(notif.routeId)) {
      showPopup(notif);
    }
  });
}

// ── DOM events from other scripts ─────────────────────────────────────────────

document.addEventListener('notifSubscriptionsRefresh', () => {
  if (!suspended && isSameSession(socketToken)) void init();
});

document.addEventListener('notifRouteJoin', (e: Event) => {
  if (suspended || !isSameSession(socketToken)) return;
  initializationVersion++;
  const { routeId } = (e as CustomEvent<{ routeId: string }>).detail;
  setRouteMuted(routeId, false);
  joinRoute(routeId);
  void init();
});

document.addEventListener('notifRouteLeave', (e: Event) => {
  if (suspended || !isSameSession(socketToken)) return;
  initializationVersion++;
  const { routeId } = (e as CustomEvent<{ routeId: string }>).detail;
  leaveRoute(routeId);
  void init();
});

document.addEventListener('notifRouteMute', (e: Event) => {
  if (suspended || !isSameSession(socketToken)) return;
  const { routeId } = (e as CustomEvent<{ routeId: string }>).detail;
  setRouteMuted(routeId, true);
  synchronizePopupRooms();
});

document.addEventListener('notifRouteUnmute', (e: Event) => {
  if (suspended || !isSameSession(socketToken)) return;
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
  stopPreferenceWatch?.();
  stopPreferenceWatch = undefined;
  socket?.disconnect();
  popupStack?.destroy();
  popupStack = null;
});

window.addEventListener('pageshow', (event) => {
  if (!event.persisted) return;
  suspended = false;
  watchPopupPreferences();
  if (!isSameSession(socketToken)) {
    socket?.disconnect();
    socket = null;
    activeRoutes.clear();
    subscribedRoutes.clear();
  }
  socket?.connect();
  void init();
});
// ── Initialisation ────────────────────────────────────────────────────────────

async function init(): Promise<void> {
  if (suspended) return;
  if (!stopPreferenceWatch) watchPopupPreferences();
  const version = ++initializationVersion;
  const token = getToken();
  connect();

  if (!token) return;

  // Fetch active subscriptions and join their socket rooms (skipping muted ones)
  try {
    const routes = await fetchRouteDisplayMap(authHeaders());
    if (suspended || version !== initializationVersion || !isSameSession(token))
      return;
    routeDisplayById = routes;

    const res = await fetch('/notifications/subscriptions', {
      headers: authHeaders()
    });
    if (!res.ok) return;
    const data = await res.json();
    if (suspended || version !== initializationVersion || !isSameSession(token))
      return;
    const subs: { routeId: string }[] = data.payload ?? [];
    const updated = new Set(subs.map((s) => s.routeId));
    for (const routeId of subscribedRoutes)
      if (!updated.has(routeId)) leaveRoute(routeId);
    subs.forEach(({ routeId }) => {
      subscribedRoutes.add(routeId);
    });
    synchronizePopupRooms();
  } catch {
    // Best-effort: socket joins will be retried on reconnect
  }
}

document.addEventListener('DOMContentLoaded', init);

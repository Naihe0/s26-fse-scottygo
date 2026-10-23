// Socket.IO session authentication, account-room permissions, and expiry.

import type { Server, Socket } from 'socket.io';
import type { IUserAccount, ITokenPayload } from '../../common/user.interface';
import { MAX_IDENTIFIER_LENGTH } from '../../common/limits';
import { authenticateSession } from './authentication.service';

type AuthenticatedSocket = Socket & { user?: ITokenPayload };

/** Largest delay setTimeout accepts (about 24.8 days). */
const MAX_TIMER_DELAY_MS = 2_147_483_647;

export const accountRoom = (username: string) =>
  `account:${username.toLowerCase()}`;
export const routeRoom = (routeId: string) => `route:${routeId}`;
export const ADMIN_USERNAMES_ROOM = 'admin:usernames';

export function isValidRoomId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_IDENTIFIER_LENGTH
  );
}

/** Run `action` for every connected socket authenticated as `userId`. */
export function forEachUserSocket(
  io: Server,
  userId: string | undefined,
  action: (socket: Socket) => void
): void {
  io.sockets.sockets.forEach((socket) => {
    if ((socket as AuthenticatedSocket).user?.userId === userId) action(socket);
  });
}

/** Leave rooms the account may no longer watch; admins join admin rooms. */
export function updateSocketAccountPermissions(
  socket: Socket,
  account: IUserAccount
): void {
  const isAdmin = account.privilegeLevel === 'Administrator';
  const ownRoom = accountRoom(account.credentials.username);
  for (const room of socket.rooms) {
    if (
      !isAdmin &&
      (room === ADMIN_USERNAMES_ROOM ||
        (room.startsWith('account:') && room !== ownRoom))
    ) {
      socket.leave(room);
    }
  }
  if (isAdmin) socket.join(ADMIN_USERNAMES_ROOM);
}

export async function authenticateSocket(
  socket: Socket,
  next: (err?: Error) => void
): Promise<void> {
  try {
    // Tokens travel in the handshake body only; URLs end up in proxy logs.
    const { account, payload } = await authenticateSession(
      socket.handshake.auth?.token
    );
    (socket as AuthenticatedSocket).user = payload;
    socket.data.account = account;
    next();
  } catch {
    next(new Error('Authentication error: Invalid or inactive session'));
  }
}

function forceLogout(socket: Socket, reason: string): void {
  socket.emit('forceLogout', reason);
  socket.disconnect(true);
}

/**
 * Recheck the account on every inbound event, and end passive sessions when
 * their JWT expires.
 */
export function configureSocketSession(socket: Socket): void {
  updateSocketAccountPermissions(socket, socket.data.account as IUserAccount);
  socket.use((_packet, next) => {
    void authenticateSocket(socket, (error) => {
      if (error) {
        forceLogout(socket, 'Your session has ended. Please log in again.');
        next(error);
        return;
      }
      updateSocketAccountPermissions(
        socket,
        socket.data.account as IUserAccount
      );
      next();
    });
  });

  const expiresAt = (socket as AuthenticatedSocket).user?.exp;
  if (!expiresAt) return;
  let timer: ReturnType<typeof setTimeout>;
  const checkExpiry = () => {
    const remaining = expiresAt * 1000 - Date.now();
    if (remaining <= 0) {
      forceLogout(socket, 'Your session has expired. Please log in again.');
      return;
    }
    timer = setTimeout(checkExpiry, Math.min(remaining, MAX_TIMER_DELAY_MS));
    timer.unref?.();
  };
  checkExpiry();
  socket.once('disconnect', () => clearTimeout(timer));
}

/** Join an account room: one's own, or any account's for administrators. */
export function subscribeSocketToAccount(
  socket: Socket,
  username: unknown
): void {
  if (!isValidRoomId(username)) return;
  const account = socket.data.account as IUserAccount | undefined;
  if (!account || account.status !== 'Active') return;
  if (
    account.privilegeLevel !== 'Administrator' &&
    account.credentials.username.toLowerCase() !== username.toLowerCase()
  )
    return;
  socket.join(accountRoom(username));
}

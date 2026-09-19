import type { Socket } from 'socket.io';
import type { IUserAccount, ITokenPayload } from '../../common/user.interface';
import { authenticateSession } from './authentication.service';

type AuthenticatedSocket = Socket & { user?: ITokenPayload };

export function updateSocketAccountPermissions(
  socket: Socket,
  account: IUserAccount
): void {
  const isAdmin = account.privilegeLevel === 'Administrator';
  const ownRoom = `account:${account.credentials.username.toLowerCase()}`;
  for (const room of socket.rooms) {
    if (
      !isAdmin &&
      (room === 'admin:usernames' ||
        (room.startsWith('account:') && room !== ownRoom))
    ) {
      socket.leave(room);
    }
  }
  if (isAdmin) socket.join('admin:usernames');
}

export async function authenticateSocket(
  socket: Socket,
  next: (err?: Error) => void
): Promise<void> {
  try {
    const token = socket.handshake.auth?.token ?? socket.handshake.query.token;
    const { account, payload } = await authenticateSession(token);
    (socket as AuthenticatedSocket).user = payload;
    socket.data.account = account;
    next();
  } catch {
    next(new Error('Authentication error: Invalid or inactive session'));
  }
}

/** Recheck existing sockets, and end passive subscriptions when their JWT expires. */
export function configureSocketSession(socket: Socket): void {
  updateSocketAccountPermissions(socket, socket.data.account as IUserAccount);
  socket.use((_packet, next) => {
    void authenticateSocket(socket, (error) => {
      if (error) {
        socket.emit(
          'forceLogout',
          'Your session has ended. Please log in again.'
        );
        socket.disconnect(true);
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
      socket.emit(
        'forceLogout',
        'Your session has expired. Please log in again.'
      );
      socket.disconnect(true);
      return;
    }
    timer = setTimeout(checkExpiry, Math.min(remaining, 2_147_483_647));
    timer.unref?.();
  };
  checkExpiry();
  socket.once('disconnect', () => clearTimeout(timer));
}

export function subscribeSocketToAccount(
  socket: Socket,
  username: unknown
): void {
  if (typeof username !== 'string' || !username || username.length > 128)
    return;
  const account = socket.data.account as IUserAccount | undefined;
  if (!account || account.status !== 'Active') return;
  if (
    account.privilegeLevel !== 'Administrator' &&
    account.credentials.username.toLowerCase() !== username.toLowerCase()
  )
    return;
  socket.join(`account:${username.toLowerCase()}`);
}

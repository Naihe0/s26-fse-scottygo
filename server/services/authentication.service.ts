import jwt from 'jsonwebtoken';
import type { IUserAccount, ITokenPayload } from '../../common/user.interface';
import { JWT_KEY } from '../env';
import { User } from '../models/user.model';

/** Resolve identity from the immutable ID and recheck account state on each request. */
export async function authenticateSession(token: unknown): Promise<{
  account: IUserAccount;
  payload: ITokenPayload;
}> {
  if (typeof token !== 'string' || !token) throw new Error('Invalid token');
  const decoded = jwt.verify(token, JWT_KEY, { algorithms: ['HS256'] });
  if (
    typeof decoded === 'string' ||
    typeof decoded.userId !== 'string' ||
    !decoded.userId ||
    typeof decoded.username !== 'string' ||
    !decoded.username ||
    (decoded.tokenVersion !== undefined &&
      (!Number.isSafeInteger(decoded.tokenVersion) || decoded.tokenVersion < 0))
  ) {
    throw new Error('Invalid token claims');
  }
  const account = await User.getUserAccountById(decoded.userId);
  if (
    account.status !== 'Active' ||
    !account.agreed ||
    (decoded.tokenVersion ?? 0) !== (account.tokenVersion ?? 0)
  ) {
    throw new Error('Session is no longer authorized');
  }
  return {
    account,
    payload: {
      ...(decoded as ITokenPayload),
      username: account.credentials.username
    }
  };
}

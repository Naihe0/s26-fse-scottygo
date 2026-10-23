// At-least-one-administrator rule for account status and privilege changes.

import DAC from '../db/dac';
import { clientError } from '../errors';

/**
 * Throw LastAdministrator if the change would leave no active administrator.
 * @param action 'inactivate' (status change) or 'demote' (privilege change)
 */
export async function ensureNotLastAdmin(
  username: string,
  action: 'inactivate' | 'demote'
): Promise<void> {
  const account = await DAC.db.findUserAccountByUsername(
    username.toLowerCase()
  );
  if (account?.privilegeLevel !== 'Administrator') return;
  // An inactive administrator does not count toward the active total.
  if (action === 'demote' && account.status !== 'Active') return;

  if ((await DAC.db.countAdministrators()) <= 1) {
    throw clientError(
      'LastAdministrator',
      action === 'inactivate'
        ? 'Cannot inactivate the last Administrator'
        : 'Cannot demote the last active Administrator'
    );
  }
}

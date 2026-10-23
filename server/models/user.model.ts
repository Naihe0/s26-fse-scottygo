// User registration, credential checks, and account management rules.

import {
  ILogin,
  IUser,
  IUserAccount,
  IAccountStatus,
  IPrivilegeLevel
} from '../../common/user.interface';
import { randomUUID as uuidV4 } from 'node:crypto';
import bcrypt from 'bcrypt';
import DAC from '../db/dac';
import { clientError, serverError } from '../errors';
import {
  BCRYPT_ROUNDS,
  validateUsernameFormat,
  validateEmailFormat,
  validatePasswordStrength
} from './user.validation';
import { ensureNotLastAdmin } from './user.admin-rules';

/** Throw PatchRequestFailure when an update matched no account. */
function requireUpdated(
  account: IUserAccount | null,
  message: string
): IUserAccount {
  if (!account) throw serverError('PatchRequestFailure', message);
  return account;
}

async function findAccount(username: string): Promise<IUserAccount | null> {
  return DAC.db.findUserAccountByUsername(username.toLowerCase());
}

export class User implements IUser {
  credentials: ILogin;
  email: string;
  agreed: boolean; // whether the user accepted the Terms of Service
  _id?: string;

  constructor(credentials: ILogin, email: string, agreed: boolean) {
    this.credentials = credentials;
    this.email = email;
    this.agreed = agreed;
    this._id = uuidV4();
  }

  /** Register this user; usernames are stored lowercase. */
  async join(): Promise<IUser> {
    validateEmailFormat(this.email);
    validateUsernameFormat(this.credentials.username);

    const existingUser = await findAccount(this.credentials.username);
    if (existingUser) {
      const passwordMatches = await bcrypt.compare(
        this.credentials.password,
        existingUser.credentials.password
      );
      if (passwordMatches) {
        throw clientError(
          'UserExists',
          'User with this username and password already exists - please log in'
        );
      }
      // Same email suggests the owner mistyped their password; otherwise the
      // username belongs to someone else.
      throw this.email === existingUser.email
        ? clientError('IncorrectPassword', 'Re-enter username and/or password')
        : clientError('InvalidUsername', 'Please provide a different username');
    }

    validatePasswordStrength(this.credentials.password);

    return DAC.db.saveUser({
      credentials: {
        username: this.credentials.username.toLowerCase(),
        password: await bcrypt.hash(this.credentials.password, BCRYPT_ROUNDS)
      },
      email: this.email,
      agreed: this.agreed,
      _id: this._id
    });
  }

  /** Return the user when the credentials match; throw otherwise. */
  static async validateUser(credentials: ILogin): Promise<IUser> {
    const user = await findAccount(credentials.username);
    if (!user) throw clientError('UserNotFound', 'User not found');

    const passwordMatches = await bcrypt.compare(
      credentials.password,
      user.credentials.password
    );
    if (!passwordMatches) {
      throw clientError('IncorrectPassword', 'Incorrect password');
    }
    return user;
  }

  static async getUserForUsername(username: string): Promise<IUser> {
    const user = await findAccount(username);
    if (!user) {
      throw clientError('UserNotFound', 'User not found - user does not exist');
    }
    return user;
  }

  static async setUserAgreedToTrue(user: IUser): Promise<IUser> {
    user.agreed = true;
    const agreedUser = await DAC.db.setUserAgreedToTrue(user);
    if (!agreedUser) {
      throw serverError(
        'PatchRequestFailure',
        'Update of user agreed status failed'
      );
    }
    return agreedUser;
  }

  // ── Account management ─────────────────────────────────────────────

  static async getAllUsernames(): Promise<string[]> {
    return DAC.db.getAllUsernames();
  }

  /** Look up an account by its immutable ID. */
  static async getUserAccountById(userId: string): Promise<IUserAccount> {
    const account = await DAC.db.findUserAccountById(userId);
    if (!account) throw clientError('UserNotFound', 'User not found');
    return account;
  }

  static async getUserAccount(username: string): Promise<IUserAccount> {
    const account = await findAccount(username);
    if (!account) throw clientError('UserNotFound', 'User not found');
    return account;
  }

  /** Change Active/Inactive status; the last administrator stays active. */
  static async updateStatus(
    username: string,
    status: IAccountStatus
  ): Promise<IUserAccount> {
    if (status === 'Inactive') await ensureNotLastAdmin(username, 'inactivate');
    return requireUpdated(
      await DAC.db.updateUserStatus(username.toLowerCase(), status),
      'Failed to update user status'
    );
  }

  /** Change privilege level; the last active administrator cannot be demoted. */
  static async updatePrivilege(
    username: string,
    privilegeLevel: IPrivilegeLevel
  ): Promise<IUserAccount> {
    if (privilegeLevel !== 'Administrator') {
      await ensureNotLastAdmin(username, 'demote');
    }
    return requireUpdated(
      await DAC.db.updateUserPrivilege(username.toLowerCase(), privilegeLevel),
      'Failed to update user privilege level'
    );
  }

  static async updateUsername(
    oldUsername: string,
    newUsername: string
  ): Promise<IUserAccount> {
    validateUsernameFormat(newUsername);
    if (await findAccount(newUsername)) {
      throw clientError('UsernameExists', 'Username already exists');
    }
    return requireUpdated(
      await DAC.db.updateUsername(
        oldUsername.toLowerCase(),
        newUsername.toLowerCase()
      ),
      'Failed to update username'
    );
  }

  static async updateEmail(
    username: string,
    email: string
  ): Promise<IUserAccount> {
    validateEmailFormat(email);
    return requireUpdated(
      await DAC.db.updateUserEmail(username.toLowerCase(), email),
      'Failed to update email'
    );
  }

  /** Hash and store a new password; this revokes earlier sessions. */
  static async updatePassword(
    username: string,
    newPassword: string
  ): Promise<IUserAccount> {
    validatePasswordStrength(newPassword);
    const hashedPassword = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
    return requireUpdated(
      await DAC.db.updateUserPassword(username.toLowerCase(), hashedPassword),
      'Failed to update password'
    );
  }

  static async markOnboardingComplete(userId: string): Promise<boolean> {
    return DAC.db.markOnboardingComplete(userId);
  }
}

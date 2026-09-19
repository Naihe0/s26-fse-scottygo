// This is the model for users
// It is used by the controllers to access functionality related users, including database access

import {
  ILogin,
  IUser,
  IUserAccount,
  IAccountStatus,
  IPrivilegeLevel
} from '../../common/user.interface';
import { randomUUID as uuidV4 } from 'node:crypto';
import DAC from '../db/dac';
import { IAppError } from '../../common/server.responses';
import bcrypt from 'bcrypt';
import {
  validateUsernameFormat,
  validateEmailFormat,
  validatePasswordStrength
} from './user.validation';
import { ensureNotLastAdmin, isLastAdministrator } from './user.admin-rules';

export class User implements IUser {
  credentials: ILogin;
  email: string; // this carries the email of the user
  agreed: boolean; // reflects if user agreed to Terms of Services
  _id?: string;

  constructor(credentials: ILogin, email: string, agreed: boolean) {
    this.credentials = credentials;
    this.email = email;
    this.agreed = agreed;
    this._id = uuidV4();
  }

  async join(): Promise<IUser> {
    // Validate email format
    validateEmailFormat(this.email);

    // Validate username format
    validateUsernameFormat(this.credentials.username);

    // Check if user already exists
    const existingUser = await DAC.db.findUserByUsername(
      this.credentials.username.toLowerCase()
    );
    if (existingUser) {
      // Compare provided password with stored hashed password
      const isValid = await bcrypt.compare(
        this.credentials.password,
        existingUser.credentials.password
      );

      if (!isValid) {
        // Wrong password - either existing user entered wrong password or new user
        // entered username that already exists

        // Handle case where existing user entered wrong password
        if (this.email === existingUser.email) {
          const error: IAppError = {
            type: 'ClientError',
            name: 'IncorrectPassword',
            message: 'Re-enter username and/or password'
          };
          throw error;
        }
        // Handle case where new user entered username that already exists
        const error: IAppError = {
          type: 'ClientError',
          name: 'InvalidUsername',
          message: 'Please provide a different username'
        };
        throw error;
      }

      const error: IAppError = {
        type: 'ClientError',
        name: 'UserExists',
        message:
          'User with this username and password already exists - please log in'
      };
      throw error;
    }

    // Validate password strength
    validatePasswordStrength(this.credentials.password);

    // Hash password before saving
    const passwordToStore = await bcrypt.hash(this.credentials.password, 10);

    const userToSave: IUser = {
      credentials: {
        username: this.credentials.username.toLowerCase(),
        password: passwordToStore
      },
      email: this.email,
      agreed: this.agreed,
      _id: this._id
    };

    // Save to database
    const savedUser = await DAC.db.saveUser(userToSave);
    return savedUser;
  }

  static async validateUser(credentials: ILogin): Promise<IUser> {
    // Validate user credentials by checking username and password
    // Returns user if valid
    // Throws IAppError for specific failure cases

    // Get user from database
    const user = await DAC.db.findUserByUsername(
      credentials.username.toLowerCase()
    );
    if (!user) {
      // User not found - throw specific error
      const error: IAppError = {
        type: 'ClientError',
        name: 'UserNotFound',
        message: 'User not found'
      };
      throw error;
    }

    // Compare provided password with stored hashed password
    const isValid = await bcrypt.compare(
      credentials.password,
      user.credentials.password
    );

    if (!isValid) {
      // Wrong password - throw specific error
      const error: IAppError = {
        type: 'ClientError',
        name: 'IncorrectPassword',
        message: 'Incorrect password'
      };
      throw error;
    }

    return user;
  }

  static async getUserForUsername(username: string): Promise<IUser | null> {
    // get user from database
    const user = await DAC.db.findUserByUsername(username.toLowerCase());
    if (!user) {
      // if user not found, throw error
      const error: IAppError = {
        type: 'ClientError',
        name: 'UserNotFound',
        message: 'User not found - user does not exist'
      };
      throw error;
    }
    return user;
  }

  static async setUserAgreedToTrue(user: IUser): Promise<IUser> {
    user.agreed = true;
    const userWhoAgreed: IUser | null = await DAC.db.setUserAgreedToTrue(user);
    if (!userWhoAgreed) {
      // If patch fails, tell User
      // ServerErrorName = 'PatchRequestFailure'
      const error: IAppError = {
        type: 'ServerError',
        name: 'PatchRequestFailure',
        message: 'Update of user agreed status failed'
      };
      throw error;
    }
    return userWhoAgreed;
  }

  // ==================== Account Management Methods ====================

  private static throwUserNotFound(): never {
    throw {
      type: 'ClientError',
      name: 'UserNotFound',
      message: 'User not found'
    } as IAppError;
  }

  /**
   * Get all usernames (for admin dropdown)
   */
  static async getAllUsernames(): Promise<string[]> {
    return DAC.db.getAllUsernames();
  }

  /**
   * Get a user account by userId (immutable _id)
   */
  static async getUserAccountById(userId: string): Promise<IUserAccount> {
    const userAccount = await DAC.db.findUserAccountById(userId);
    if (!userAccount) {
      User.throwUserNotFound();
    }
    return userAccount;
  }

  /**
   * Get a user account by username
   */
  static async getUserAccount(username: string): Promise<IUserAccount> {
    const userAccount = await DAC.db.findUserAccountByUsername(
      username.toLowerCase()
    );
    if (!userAccount) {
      User.throwUserNotFound();
    }
    return userAccount;
  }

  /**
   * Update user account status (Active/Inactive)
   */
  static async updateStatus(
    username: string,
    status: IAccountStatus
  ): Promise<IUserAccount> {
    // R1 At-Least-One-Administrator Rule
    if (status === 'Inactive') {
      await ensureNotLastAdmin(username, 'inactivate');
    }

    const updatedUser = await DAC.db.updateUserStatus(
      username.toLowerCase(),
      status
    );
    if (!updatedUser) {
      const error: IAppError = {
        type: 'ServerError',
        name: 'PatchRequestFailure',
        message: 'Failed to update user status'
      };
      throw error;
    }
    return updatedUser;
  }

  /**
   * Update user privilege level
   * Enforces R1 At-Least-One-Administrator Rule
   */
  static async updatePrivilege(
    username: string,
    privilegeLevel: IPrivilegeLevel
  ): Promise<IUserAccount> {
    // R1 At-Least-One-Administrator Rule: Check before demoting an admin
    if (privilegeLevel !== 'Administrator') {
      await ensureNotLastAdmin(username, 'demote');
    }

    const updatedUser = await DAC.db.updateUserPrivilege(
      username.toLowerCase(),
      privilegeLevel
    );
    if (!updatedUser) {
      const error: IAppError = {
        type: 'ServerError',
        name: 'PatchRequestFailure',
        message: 'Failed to update user privilege level'
      };
      throw error;
    }
    return updatedUser;
  }

  /**
   * Update username with validation
   */
  static async updateUsername(
    oldUsername: string,
    newUsername: string
  ): Promise<IUserAccount> {
    const normalizedNewUsername = newUsername.toLowerCase();

    // Validate username format (length and reserved list)
    validateUsernameFormat(newUsername);

    // Check if new username already exists
    const existingUser = await DAC.db.findUserByUsername(normalizedNewUsername);
    if (existingUser) {
      const error: IAppError = {
        type: 'ClientError',
        name: 'UsernameExists',
        message: 'Username already exists'
      };
      throw error;
    }

    const updatedUser = await DAC.db.updateUsername(
      oldUsername.toLowerCase(),
      normalizedNewUsername
    );
    if (!updatedUser) {
      const error: IAppError = {
        type: 'ServerError',
        name: 'PatchRequestFailure',
        message: 'Failed to update username'
      };
      throw error;
    }
    return updatedUser;
  }

  /**
   * Update user email with validation
   */
  static async updateEmail(
    username: string,
    email: string
  ): Promise<IUserAccount> {
    // Validate email format
    validateEmailFormat(email);

    const updatedUser = await DAC.db.updateUserEmail(
      username.toLowerCase(),
      email
    );
    if (!updatedUser) {
      const error: IAppError = {
        type: 'ServerError',
        name: 'PatchRequestFailure',
        message: 'Failed to update email'
      };
      throw error;
    }
    return updatedUser;
  }

  /**
   * Update user password with validation
   * @param username - The username of the user
   * @param newPassword - The new password (plain text, will be hashed)
   */
  static async updatePassword(
    username: string,
    newPassword: string
  ): Promise<IUserAccount> {
    // Validate new password strength
    validatePasswordStrength(newPassword);

    // Hash and update password
    const hashedPassword = await bcrypt.hash(newPassword, 10);
    const updatedUser = await DAC.db.updateUserPassword(
      username.toLowerCase(),
      hashedPassword
    );
    if (!updatedUser) {
      const error: IAppError = {
        type: 'ServerError',
        name: 'PatchRequestFailure',
        message: 'Failed to update password'
      };
      throw error;
    }
    return updatedUser;
  }

  /**
   * Validate a password against stored hash
   */
  static async validatePassword(
    username: string,
    password: string
  ): Promise<boolean> {
    const user = await DAC.db.findUserByUsername(username.toLowerCase());
    if (!user) {
      return false;
    }
    return bcrypt.compare(password, user.credentials.password);
  }

  /**
   * Check if a user is the last active administrator
   */
  static isLastAdministrator = isLastAdministrator;

  /**
   * Mark onboarding tutorial as complete for a user
   */
  static async markOnboardingComplete(userId: string): Promise<boolean> {
    return DAC.db.markOnboardingComplete(userId);
  }
}

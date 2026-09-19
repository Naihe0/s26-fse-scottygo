// Controller for account management operations
// Handles HTTP requests for account retrieval, updates, password changes,
// status changes, and privilege changes per REST_ManageAcct.md

import {
  IUserAccount,
  IAccountStatus,
  IPrivilegeLevel,
  ITokenPayload
} from '../../common/user.interface';
import { User } from '../models/user.model';
import Controller from './controller';
import { Request, Response } from 'express';
import * as responses from '../../common/server.responses';
import EmailService from '../services/email.service';
import { updateSocketAccountPermissions } from '../services/socket-session.service';
import { SearchContext, UserSearchStrategy } from '../search/search-strategy';

export default class AccountController extends Controller {
  private static instance: AccountController | null = null;

  private constructor(path: string) {
    super(path);
  }

  public static getInstance(path: string): AccountController {
    if (!AccountController.instance) {
      AccountController.instance = new AccountController(path);
    }
    return AccountController.instance;
  }

  public initializeRoutes(): void {
    // Page route (no auth required - client handles auth)
    this.router.get('/', this.accountPage.bind(this));

    // Apply auth middleware to API routes only
    this.router.use(this.authenticateToken.bind(this));

    // Account management routes
    this.router.get('/users', this.getAllUsers.bind(this)); // Must be before :username route
    this.router.get('/users/search', this.searchUsers.bind(this)); // Must be before :username route
    this.router.get('/users/:username', this.getUserAccount.bind(this));
    this.router.patch('/users/:username/status', this.updateStatus.bind(this));
    this.router.patch(
      '/users/:username/privilege',
      this.updatePrivilege.bind(this)
    );
    this.router.patch(
      '/users/:username/username',
      this.updateUsername.bind(this)
    );
    this.router.patch('/users/:username/email', this.updateEmail.bind(this));
    this.router.patch(
      '/users/:username/password',
      this.updatePassword.bind(this)
    );
    this.router.patch('/onboarding', this.completeOnboarding.bind(this));
  }

  /**
   * Get the requesting user's account info from token
   */
  private async getRequestingUserAccount(
    req: Request
  ): Promise<IUserAccount | null> {
    const tokenUser = (req as Request & { user: ITokenPayload }).user;
    if (!tokenUser || !tokenUser.userId) return null;

    try {
      // Use userId from token (immutable) instead of username to avoid issues after username change
      return await User.getUserAccountById(tokenUser.userId);
    } catch {
      return null;
    }
  }

  /**
   * Obfuscate password in user account for response
   */
  private obfuscatePassword(account: IUserAccount): IUserAccount {
    return {
      ...account,
      credentials: {
        ...account.credentials,
        password: '*******'
      }
    };
  }

  /**
   * Emit account updated event to subscribed clients
   */
  private emitAccountUpdated(account: IUserAccount): void {
    const roomName = `account:${account.credentials.username.toLowerCase()}`;
    Controller.io
      .to(roomName)
      .emit('accountUpdated', this.obfuscatePassword(account));
  }

  private sendAccountSuccess(
    res: Response,
    config: {
      status: number;
      name: responses.SuccessName;
      account: IUserAccount;
      authorizedUser: string;
    }
  ): void {
    const success = this.success(
      config.name,
      this.obfuscatePassword(config.account)
    );
    success.authorizedUser = config.authorizedUser;
    res.status(config.status).json(success);
  }

  private requireOwnAccount(
    requestingUser: IUserAccount,
    config: {
      targetUsername: string;
      res: Response;
      message: string;
    }
  ): boolean {
    if (!this.isOwnAccount(requestingUser, config.targetUsername)) {
      config.res
        .status(403)
        .json(this.clientError('UnauthorizedRequest', config.message));
      return false;
    }
    return true;
  }

  private isValidStatus(status: unknown): status is IAccountStatus {
    return status === 'Active' || status === 'Inactive';
  }

  private isValidPrivilegeLevel(value: unknown): value is IPrivilegeLevel {
    return (
      value === 'Administrator' || value === 'Coordinator' || value === 'Member'
    );
  }

  private getRequiredTextField(config: {
    value: unknown;
    res: Response;
    name: responses.ClientErrorName;
    message: string;
  }): string | null {
    if (typeof config.value !== 'string' || config.value.trim() === '') {
      config.res
        .status(400)
        .json(this.clientError(config.name, config.message));
      return null;
    }
    return config.value;
  }

  private async requireRequestingUser(
    req: Request,
    res: Response
  ): Promise<IUserAccount | null> {
    const requestingUser = await this.getRequestingUserAccount(req);
    if (!requestingUser) {
      res
        .status(401)
        .json(
          this.clientError(
            'UnauthorizedRequest',
            'Unable to verify requesting user'
          )
        );
      return null;
    }
    return requestingUser;
  }

  private async requireAdminUser(
    req: Request,
    res: Response,
    message: string
  ): Promise<IUserAccount | null> {
    const requestingUser = await this.requireRequestingUser(req, res);
    if (!requestingUser) return null;
    if (!this.requireAdmin(requestingUser, res, message)) return null;
    return requestingUser;
  }

  private async requireAdminOrOwnUser(
    req: Request,
    res: Response,
    targetUsername: string,
    message: string
  ): Promise<IUserAccount | null> {
    const requestingUser = await this.requireRequestingUser(req, res);
    if (!requestingUser) return null;
    if (!this.requireAdminOrOwn(requestingUser, targetUsername, res, message)) {
      return null;
    }
    return requestingUser;
  }

  private async requireOwnUser(
    req: Request,
    res: Response,
    targetUsername: string,
    message: string
  ): Promise<IUserAccount | null> {
    const requestingUser = await this.requireRequestingUser(req, res);
    if (!requestingUser) return null;
    if (
      !this.requireOwnAccount(requestingUser, { targetUsername, res, message })
    ) {
      return null;
    }
    return requestingUser;
  }

  private isOwnAccount(
    requestingUser: IUserAccount,
    targetUsername: string
  ): boolean {
    return (
      requestingUser.credentials.username.toLowerCase() ===
      targetUsername.toLowerCase()
    );
  }

  /**
   * Guard: respond 400 and return false when targetUsername is missing.
   */
  private requireTargetUsername(
    targetUsername: string,
    res: Response
  ): boolean {
    if (!targetUsername) {
      res
        .status(400)
        .json(this.clientError('MissingUsername', 'Username is required'));
      return false;
    }
    return true;
  }

  /**
   * Guard: respond 403 and return false when requestingUser is not an Administrator.
   */
  private requireAdmin(
    requestingUser: IUserAccount,
    res: Response,
    message: string
  ): boolean {
    if (requestingUser.privilegeLevel !== 'Administrator') {
      res.status(403).json(this.clientError('UnauthorizedRequest', message));
      return false;
    }
    return true;
  }

  /**
   * Guard: respond 403 and return false unless requestingUser is an admin or owns the target account.
   */
  private requireAdminOrOwn(
    requestingUser: IUserAccount,
    targetUsername: string,
    res: Response,
    message: string
  ): boolean {
    const isAdmin = requestingUser.privilegeLevel === 'Administrator';
    const isOwnAccount = this.isOwnAccount(requestingUser, targetUsername);
    if (!isAdmin && !isOwnAccount) {
      res.status(403).json(this.clientError('UnauthorizedRequest', message));
      return false;
    }
    return true;
  }

  private async applyStatusTransitionSideEffects(
    updatedUser: IUserAccount,
    previousStatus: IAccountStatus,
    nextStatus: IAccountStatus
  ): Promise<void> {
    if (nextStatus === 'Inactive' && previousStatus === 'Active') {
      this.forceLogoutUser(
        updatedUser._id!,
        'Your account has been deactivated by an administrator'
      );
      await EmailService.sendAccountInactivatedEmail(
        updatedUser.email,
        updatedUser.credentials.username
      );
      return;
    }

    if (nextStatus === 'Active' && previousStatus === 'Inactive') {
      await EmailService.sendAccountReactivatedEmail(
        updatedUser.email,
        updatedUser.credentials.username
      );
    }
  }

  private emitUsernameChanged(
    oldUsername: string,
    updatedUser: IUserAccount,
    targetUsername: string
  ): void {
    const oldRoomName = `account:${oldUsername}`;
    const newRoomName = `account:${updatedUser.credentials.username.toLowerCase()}`;

    Controller.io
      .to(oldRoomName)
      .emit('accountUpdated', this.obfuscatePassword(updatedUser));

    Controller.io
      .to('admin:usernames')
      .emit(
        'usernameChanged',
        targetUsername,
        updatedUser.credentials.username
      );

    this.moveSocketsToRoom(oldRoomName, newRoomName);
  }

  private moveSocketsToRoom(oldRoomName: string, newRoomName: string): void {
    const socketsInRoom = Controller.io.sockets.adapter.rooms.get(oldRoomName);
    if (!socketsInRoom) return;

    socketsInRoom.forEach((socketId) => {
      const socket = Controller.io.sockets.sockets.get(socketId);
      if (!socket) return;
      socket.leave(oldRoomName);
      socket.join(newRoomName);
    });
  }

  /**
   * GET /account/users
   * Get all usernames (Admin only)
   */
  public async getAllUsers(req: Request, res: Response): Promise<void> {
    try {
      const requestingUser = await this.requireAdminUser(
        req,
        res,
        'Only administrators can view all users'
      );
      if (!requestingUser) return;

      const usernames = await User.getAllUsernames();
      const success = this.success('UsersRetrieved', usernames);
      success.authorizedUser = requestingUser.credentials.username;
      res.status(200).json(success);
    } catch (error: unknown) {
      this.handleAppError(res, error);
    }
  }

  /**
   * GET /account/users/search?field=username|email&q=<keywords>
   * Search users with contextual strategy and deterministic ordering.
   * Only available to administrators.
   */
  public async searchUsers(req: Request, res: Response): Promise<void> {
    try {
      const requestingUser = await this.requireAdminUser(
        req,
        res,
        'Only administrators can search users'
      );
      if (!requestingUser) return;

      const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
      const context = new SearchContext<string[]>(new UserSearchStrategy());
      const usernames = await context.executeSearch(q);

      const success = this.success(
        'UsersSearchCompleted',
        usernames,
        usernames.length
          ? `Found ${usernames.length} matching user${usernames.length === 1 ? '' : 's'}`
          : 'No matching users found',
        { totalItems: usernames.length }
      );
      success.authorizedUser = requestingUser.credentials.username;
      res.status(200).json(success);
    } catch (error: unknown) {
      this.handleAppError(res, error);
    }
  }

  /**
   * GET /account/users/:username
   * Get user account details
   */
  public async getUserAccount(req: Request, res: Response): Promise<void> {
    const targetUsername = req.params.username;
    if (!this.requireTargetUsername(targetUsername, res)) return;

    try {
      const requestingUser = await this.requireAdminOrOwnUser(
        req,
        res,
        targetUsername,
        'You can only view your own account'
      );
      if (!requestingUser) return;

      const userAccount = await User.getUserAccount(targetUsername);
      this.sendAccountSuccess(res, {
        status: 200,
        name: 'AccountRetrieved',
        account: userAccount,
        authorizedUser: requestingUser.credentials.username
      });
    } catch (error: unknown) {
      this.handleAppError(res, error);
    }
  }

  /**
   * PATCH /account/users/:username/status
   * Update account status (Active/Inactive)
   */
  public async updateStatus(req: Request, res: Response): Promise<void> {
    const targetUsername = req.params.username;
    const { status } = req.body as { status: unknown };

    if (!this.requireTargetUsername(targetUsername, res)) return;

    if (!this.isValidStatus(status)) {
      res
        .status(400)
        .json(
          this.clientError(
            'UnauthorizedRequest',
            'Valid status (Active/Inactive) is required'
          )
        );
      return;
    }

    try {
      const requestingUser = await this.requireAdminOrOwnUser(
        req,
        res,
        targetUsername,
        'You can only change your own account status'
      );
      if (!requestingUser) return;

      // Get target user for email notification
      const targetUser = await User.getUserAccount(targetUsername);
      const previousStatus = targetUser.status;

      const updatedUser = await User.updateStatus(targetUsername, status);

      // Emit account updated event
      this.emitAccountUpdated(updatedUser);

      await this.applyStatusTransitionSideEffects(
        updatedUser,
        previousStatus,
        status
      );

      this.sendAccountSuccess(res, {
        status: 200,
        name: 'StatusUpdated',
        account: updatedUser,
        authorizedUser: requestingUser.credentials.username
      });
    } catch (error: unknown) {
      this.handleAppError(res, error);
    }
  }

  /**
   * Force logout a user by emitting forceLogout event to their sockets
   */
  private forceLogoutUser(userId: string, message: string): void {
    // Find all sockets for this user and emit forceLogout
    const io = Controller.io;
    const sockets = io.sockets.sockets;

    sockets.forEach((socket) => {
      // Get user from socket (stored during connection)
      const socketUser = (socket as unknown as { user?: ITokenPayload }).user;
      if (socketUser?.userId === userId) {
        socket.emit('forceLogout', message);
        socket.disconnect(true);
      }
    });
  }

  /**
   * PATCH /account/users/:username/privilege
   * Update privilege level (Administrator only)
   */
  public async updatePrivilege(req: Request, res: Response): Promise<void> {
    const targetUsername = req.params.username;
    const { privilegeLevel } = req.body as { privilegeLevel: unknown };

    if (!this.requireTargetUsername(targetUsername, res)) return;

    if (!this.isValidPrivilegeLevel(privilegeLevel)) {
      res
        .status(400)
        .json(
          this.clientError(
            'UnauthorizedRequest',
            'Valid privilege level (Administrator/Coordinator/Member) is required'
          )
        );
      return;
    }

    try {
      const requestingUser = await this.requireAdminUser(
        req,
        res,
        'Only administrators can change privilege levels'
      );
      if (!requestingUser) return;

      // R1 check is now in User.updatePrivilege (model layer)
      const updatedUser = await User.updatePrivilege(
        targetUsername,
        privilegeLevel
      );

      // A demoted administrator must immediately lose other-account subscriptions.
      Controller.io.sockets.sockets.forEach((socket) => {
        const session = (socket as unknown as { user?: ITokenPayload }).user;
        if (session?.userId === updatedUser._id) {
          updateSocketAccountPermissions(socket, updatedUser);
        }
      });

      // Emit account updated event
      this.emitAccountUpdated(updatedUser);

      this.sendAccountSuccess(res, {
        status: 200,
        name: 'PrivilegeUpdated',
        account: updatedUser,
        authorizedUser: requestingUser.credentials.username
      });
    } catch (error: unknown) {
      this.handleAppError(res, error);
    }
  }

  /**
   * PATCH /account/users/:username/username
   * Update username (Members only, own account)
   */
  public async updateUsername(req: Request, res: Response): Promise<void> {
    const targetUsername = req.params.username;
    const { newUsername: rawNewUsername } = req.body as {
      newUsername: unknown;
    };

    if (!this.requireTargetUsername(targetUsername, res)) return;

    const newUsername = this.getRequiredTextField({
      value: rawNewUsername,
      res,
      name: 'MissingUsername',
      message: 'New username is required'
    });
    if (!newUsername) return;

    try {
      const requestingUser = await this.requireOwnUser(
        req,
        res,
        targetUsername,
        'You can only change your own username'
      );
      if (!requestingUser) return;

      const oldUsername = targetUsername.toLowerCase();
      const updatedUser = await User.updateUsername(
        targetUsername,
        newUsername
      );

      this.emitUsernameChanged(oldUsername, updatedUser, targetUsername);

      this.sendAccountSuccess(res, {
        status: 200,
        name: 'UsernameUpdated',
        account: updatedUser,
        authorizedUser: updatedUser.credentials.username
      });
    } catch (error: unknown) {
      this.handleAppError(res, error);
    }
  }

  /**
   * PATCH /account/users/:username/email
   * Update email (Members only, own account)
   */
  public async updateEmail(req: Request, res: Response): Promise<void> {
    const targetUsername = req.params.username;
    const { email: rawEmail } = req.body as { email: unknown };

    if (!this.requireTargetUsername(targetUsername, res)) return;

    const email = this.getRequiredTextField({
      value: rawEmail,
      res,
      name: 'MissingEmail',
      message: 'Email is required'
    });
    if (!email) return;

    try {
      const requestingUser = await this.requireOwnUser(
        req,
        res,
        targetUsername,
        'You can only change your own email'
      );
      if (!requestingUser) return;

      const updatedUser = await User.updateEmail(targetUsername, email);

      // Emit account updated event
      this.emitAccountUpdated(updatedUser);

      this.sendAccountSuccess(res, {
        status: 200,
        name: 'EmailUpdated',
        account: updatedUser,
        authorizedUser: requestingUser.credentials.username
      });
    } catch (error: unknown) {
      this.handleAppError(res, error);
    }
  }

  /**
   * PATCH /account/users/:username/password
   * Update password
   */
  public async updatePassword(req: Request, res: Response): Promise<void> {
    const targetUsername = req.params.username;
    const { newPassword: rawNewPassword } = req.body as {
      newPassword: unknown;
    };

    if (!this.requireTargetUsername(targetUsername, res)) return;

    const newPassword = this.getRequiredTextField({
      value: rawNewPassword,
      res,
      name: 'MissingPassword',
      message: 'New password is required'
    });
    if (!newPassword) return;

    try {
      const requestingUser = await this.requireAdminOrOwnUser(
        req,
        res,
        targetUsername,
        'You can only change your own password'
      );
      if (!requestingUser) return;

      const updatedUser = await User.updatePassword(
        targetUsername,
        newPassword
      );

      this.forceLogoutUser(
        updatedUser._id!,
        'Your password changed. Please log in again.'
      );

      // Emit account updated event
      this.emitAccountUpdated(updatedUser);

      this.sendAccountSuccess(res, {
        status: 200,
        name: 'PasswordUpdated',
        account: updatedUser,
        authorizedUser: requestingUser.credentials.username
      });
    } catch (error: unknown) {
      this.handleAppError(res, error);
    }
  }

  /**
   * GET /account
   * Serve the account page
   */
  public accountPage(req: Request, res: Response): void {
    this.sendPage(res, 'account.html');
  }

  /**
   * PATCH /account/onboarding
   * Mark onboarding tutorial as complete for the authenticated user
   */
  public async completeOnboarding(req: Request, res: Response): Promise<void> {
    try {
      const tokenUser = (req as Request & { user: ITokenPayload }).user;
      if (!tokenUser || !tokenUser.userId) {
        res
          .status(401)
          .json(
            this.clientError(
              'UnauthorizedRequest',
              'Unable to verify requesting user'
            )
          );
        return;
      }

      await User.markOnboardingComplete(tokenUser.userId);

      const success = this.success('OnboardingCompleted', null);
      success.authorizedUser = tokenUser.username;
      res.status(200).json(success);
    } catch (error: unknown) {
      this.handleAppError(res, error);
    }
  }
}

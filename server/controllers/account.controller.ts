// Account management: lookup, profile edits, password, status, privilege,
// and onboarding. Base path: /account

import { Request, Response } from 'express';
import {
  IUserAccount,
  IAccountStatus,
  IPrivilegeLevel
} from '../../common/user.interface';
import type {
  ClientErrorName,
  SuccessName
} from '../../common/server.responses';
import { User } from '../models/user.model';
import Controller from './controller';
import EmailService from '../services/email.service';
import {
  ADMIN_USERNAMES_ROOM,
  accountRoom,
  forEachUserSocket,
  updateSocketAccountPermissions
} from '../services/socket-session.service';
import { SearchContext, UserSearchStrategy } from '../search/search-strategy';

const ACCOUNT_STATUSES: readonly IAccountStatus[] = ['Active', 'Inactive'];
const PRIVILEGE_LEVELS: readonly IPrivilegeLevel[] = [
  'Administrator',
  'Coordinator',
  'Member'
];

/** Who may perform an action on the account named in the URL. */
type Access = 'admin' | 'own' | 'adminOrOwn';

const isAdmin = (account: IUserAccount) =>
  account.privilegeLevel === 'Administrator';

const isOwnAccount = (account: IUserAccount, username: string) =>
  account.credentials.username.toLowerCase() === username.toLowerCase();

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
    // The page itself is public; the browser handles sign-in.
    this.router.get('/', (_req, res) => this.sendPage(res, 'account.html'));

    this.router.use(this.authenticateToken.bind(this));
    // Fixed paths must be registered before /users/:username.
    this.router.get('/users', this.getAllUsers.bind(this));
    this.router.get('/users/search', this.searchUsers.bind(this));
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

  // ── Authorization ──────────────────────────────────────────────────

  /**
   * Load the requesting account (401 when it cannot be resolved) and check
   * that it may act on `targetUsername` (403 otherwise).
   */
  private async requireAccess(
    req: Request,
    res: Response,
    access: Access,
    deniedMessage: string,
    targetUsername = ''
  ): Promise<IUserAccount | null> {
    const userId = this.getTokenPayload(req)?.userId;
    const requester = userId
      ? await User.getUserAccountById(userId).catch(() => null)
      : null;
    if (!requester) {
      this.sendClientError(
        res,
        401,
        'UnauthorizedRequest',
        'Unable to verify requesting user'
      );
      return null;
    }
    const allowed =
      (access !== 'own' && isAdmin(requester)) ||
      (access !== 'admin' && isOwnAccount(requester, targetUsername));
    if (!allowed) {
      this.sendClientError(res, 403, 'UnauthorizedRequest', deniedMessage);
      return null;
    }
    return requester;
  }

  /** Send 400 and return null unless `value` is a non-blank string. */
  private requireText(
    res: Response,
    value: unknown,
    name: ClientErrorName,
    message: string
  ): string | null {
    if (typeof value !== 'string' || value.trim() === '') {
      this.sendClientError(res, 400, name, message);
      return null;
    }
    return value;
  }

  // ── Responses and events ───────────────────────────────────────────

  private sendAccount(
    res: Response,
    name: SuccessName,
    account: IUserAccount,
    authorizedUser: string
  ): void {
    const success = this.success(name, this.sanitizeUser(account));
    success.authorizedUser = authorizedUser;
    res.status(200).json(success);
  }

  /** Push the account's new state to views subscribed to it. */
  private emitAccountUpdated(account: IUserAccount, room?: string): void {
    Controller.io
      .to(room ?? accountRoom(account.credentials.username))
      .emit('accountUpdated', this.sanitizeUser(account));
  }

  /** End every session of a user, telling the client why. */
  private forceLogoutUser(userId: string | undefined, reason: string): void {
    forEachUserSocket(Controller.io, userId, (socket) => {
      socket.emit('forceLogout', reason);
      socket.disconnect(true);
    });
  }

  // ── Endpoints ──────────────────────────────────────────────────────

  // GET /account/users — all usernames (administrators only)
  public async getAllUsers(req: Request, res: Response): Promise<void> {
    try {
      const requester = await this.requireAccess(
        req,
        res,
        'admin',
        'Only administrators can view all users'
      );
      if (!requester) return;

      const success = this.success(
        'UsersRetrieved',
        await User.getAllUsernames()
      );
      success.authorizedUser = requester.credentials.username;
      res.status(200).json(success);
    } catch (error) {
      this.handleAppError(res, error);
    }
  }

  // GET /account/users/search?q= — usernames containing q (administrators only)
  public async searchUsers(req: Request, res: Response): Promise<void> {
    try {
      const requester = await this.requireAccess(
        req,
        res,
        'admin',
        'Only administrators can search users'
      );
      if (!requester) return;

      const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
      const usernames = await new SearchContext<string[]>(
        new UserSearchStrategy()
      ).executeSearch(q);
      const success = this.success(
        'UsersSearchCompleted',
        usernames,
        usernames.length
          ? `Found ${usernames.length} matching user${usernames.length === 1 ? '' : 's'}`
          : 'No matching users found',
        { totalItems: usernames.length }
      );
      success.authorizedUser = requester.credentials.username;
      res.status(200).json(success);
    } catch (error) {
      this.handleAppError(res, error);
    }
  }

  // GET /account/users/:username
  public async getUserAccount(req: Request, res: Response): Promise<void> {
    const { username } = req.params;
    try {
      const requester = await this.requireAccess(
        req,
        res,
        'adminOrOwn',
        'You can only view your own account',
        username
      );
      if (!requester) return;

      this.sendAccount(
        res,
        'AccountRetrieved',
        await User.getUserAccount(username),
        requester.credentials.username
      );
    } catch (error) {
      this.handleAppError(res, error);
    }
  }

  // PATCH /account/users/:username/status  { status }
  public async updateStatus(req: Request, res: Response): Promise<void> {
    const { username } = req.params;
    const { status } = req.body as { status: unknown };
    if (!ACCOUNT_STATUSES.includes(status as IAccountStatus)) {
      this.sendClientError(
        res,
        400,
        'UnauthorizedRequest',
        'Valid status (Active/Inactive) is required'
      );
      return;
    }
    const nextStatus = status as IAccountStatus;

    try {
      const requester = await this.requireAccess(
        req,
        res,
        'adminOrOwn',
        'You can only change your own account status',
        username
      );
      if (!requester) return;

      const previousStatus = (await User.getUserAccount(username)).status;
      const updated = await User.updateStatus(username, nextStatus);
      this.emitAccountUpdated(updated);

      if (previousStatus === 'Active' && nextStatus === 'Inactive') {
        this.forceLogoutUser(
          updated._id,
          'Your account has been deactivated by an administrator'
        );
        await EmailService.sendAccountInactivatedEmail(
          updated.email,
          updated.credentials.username
        );
      } else if (previousStatus === 'Inactive' && nextStatus === 'Active') {
        await EmailService.sendAccountReactivatedEmail(
          updated.email,
          updated.credentials.username
        );
      }

      this.sendAccount(
        res,
        'StatusUpdated',
        updated,
        requester.credentials.username
      );
    } catch (error) {
      this.handleAppError(res, error);
    }
  }

  // PATCH /account/users/:username/privilege  { privilegeLevel }
  public async updatePrivilege(req: Request, res: Response): Promise<void> {
    const { username } = req.params;
    const { privilegeLevel } = req.body as { privilegeLevel: unknown };
    if (!PRIVILEGE_LEVELS.includes(privilegeLevel as IPrivilegeLevel)) {
      this.sendClientError(
        res,
        400,
        'UnauthorizedRequest',
        'Valid privilege level (Administrator/Coordinator/Member) is required'
      );
      return;
    }

    try {
      const requester = await this.requireAccess(
        req,
        res,
        'admin',
        'Only administrators can change privilege levels'
      );
      if (!requester) return;

      const updated = await User.updatePrivilege(
        username,
        privilegeLevel as IPrivilegeLevel
      );
      // A demoted administrator must immediately lose other-account rooms.
      forEachUserSocket(Controller.io, updated._id, (socket) =>
        updateSocketAccountPermissions(socket, updated)
      );
      this.emitAccountUpdated(updated);
      this.sendAccount(
        res,
        'PrivilegeUpdated',
        updated,
        requester.credentials.username
      );
    } catch (error) {
      this.handleAppError(res, error);
    }
  }

  // PATCH /account/users/:username/username  { newUsername } — own account
  public async updateUsername(req: Request, res: Response): Promise<void> {
    const { username } = req.params;
    const newUsername = this.requireText(
      res,
      req.body?.newUsername,
      'MissingUsername',
      'New username is required'
    );
    if (!newUsername) return;

    try {
      const requester = await this.requireAccess(
        req,
        res,
        'own',
        'You can only change your own username',
        username
      );
      if (!requester) return;

      const updated = await User.updateUsername(username, newUsername);
      const oldRoom = accountRoom(username);
      this.emitAccountUpdated(updated, oldRoom);
      Controller.io
        .to(ADMIN_USERNAMES_ROOM)
        .emit('usernameChanged', username, updated.credentials.username);
      this.moveRoom(oldRoom, accountRoom(updated.credentials.username));

      this.sendAccount(
        res,
        'UsernameUpdated',
        updated,
        updated.credentials.username
      );
    } catch (error) {
      this.handleAppError(res, error);
    }
  }

  /** Keep listeners of a renamed account subscribed under its new name. */
  private moveRoom(oldRoom: string, newRoom: string): void {
    const socketIds = Controller.io.sockets.adapter.rooms.get(oldRoom);
    socketIds?.forEach((socketId) => {
      const socket = Controller.io.sockets.sockets.get(socketId);
      socket?.leave(oldRoom);
      socket?.join(newRoom);
    });
  }

  // PATCH /account/users/:username/email  { email } — own account
  public async updateEmail(req: Request, res: Response): Promise<void> {
    const { username } = req.params;
    const email = this.requireText(
      res,
      req.body?.email,
      'MissingEmail',
      'Email is required'
    );
    if (!email) return;

    try {
      const requester = await this.requireAccess(
        req,
        res,
        'own',
        'You can only change your own email',
        username
      );
      if (!requester) return;

      const updated = await User.updateEmail(username, email);
      this.emitAccountUpdated(updated);
      this.sendAccount(
        res,
        'EmailUpdated',
        updated,
        requester.credentials.username
      );
    } catch (error) {
      this.handleAppError(res, error);
    }
  }

  // PATCH /account/users/:username/password  { newPassword }
  public async updatePassword(req: Request, res: Response): Promise<void> {
    const { username } = req.params;
    const newPassword = this.requireText(
      res,
      req.body?.newPassword,
      'MissingPassword',
      'New password is required'
    );
    if (!newPassword) return;

    try {
      const requester = await this.requireAccess(
        req,
        res,
        'adminOrOwn',
        'You can only change your own password',
        username
      );
      if (!requester) return;

      const updated = await User.updatePassword(username, newPassword);
      this.forceLogoutUser(
        updated._id,
        'Your password changed. Please log in again.'
      );
      this.emitAccountUpdated(updated);
      this.sendAccount(
        res,
        'PasswordUpdated',
        updated,
        requester.credentials.username
      );
    } catch (error) {
      this.handleAppError(res, error);
    }
  }

  // PATCH /account/onboarding — mark the tutorial complete for the requester
  public async completeOnboarding(req: Request, res: Response): Promise<void> {
    const session = this.getTokenPayload(req);
    if (!session?.userId) {
      this.sendClientError(
        res,
        401,
        'UnauthorizedRequest',
        'Unable to verify requesting user'
      );
      return;
    }
    try {
      await User.markOnboardingComplete(session.userId);
      const success = this.success('OnboardingCompleted', null);
      success.authorizedUser = session.username;
      res.status(200).json(success);
    } catch (error) {
      this.handleAppError(res, error);
    }
  }
}

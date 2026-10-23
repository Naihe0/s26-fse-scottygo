// Authentication page, registration, login, and terms acceptance.
// Base path: /auth

import { Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { ILogin, ITokenPayload } from '../../common/user.interface';
import type { IAuthenticatedUser } from '../../common/server.responses';
import { User } from '../models/user.model';
import {
  validateUsernameFormat,
  validateEmailFormat,
  validatePasswordStrength
} from '../models/user.validation';
import Controller from './controller';
import { JWT_KEY, JWT_EXP } from '../env';
import { createIpRateLimiter } from '../services/auth-rate-limit.service';

const FIELD_VALIDATORS = new Map<unknown, (value: string) => void>([
  ['username', validateUsernameFormat],
  ['email', validateEmailFormat],
  ['password', validatePasswordStrength]
]);

function signSessionToken(payload: ITokenPayload): string {
  return JWT_EXP === 'never'
    ? jwt.sign(payload, JWT_KEY)
    : jwt.sign(payload, JWT_KEY, {
        expiresIn: JWT_EXP
      } as jwt.SignOptions);
}

export default class AuthController extends Controller {
  private static instance: AuthController | null = null;

  private constructor(path: string) {
    super(path);
  }

  public static getInstance(path: string): AuthController {
    if (!AuthController.instance) {
      AuthController.instance = new AuthController(path);
    }
    return AuthController.instance;
  }

  public initializeRoutes(): void {
    // Share the failure budget with password-backed terms acceptance so it
    // cannot be used as an unthrottled alternate password-check endpoint.
    const loginLimit = createIpRateLimiter({
      limit: 30,
      windowMs: 15 * 60_000,
      skipSuccessful: true
    }).middleware;
    const registerLimit = createIpRateLimiter({
      limit: 30,
      windowMs: 60 * 60_000
    }).middleware;
    this.router.get('/', (_req, res) => this.sendPage(res, 'auth.html'));
    this.router.post('/validate', this.validateField.bind(this));
    this.router.post('/users', registerLimit, this.register.bind(this));
    this.router.post('/tokens/:username?', loginLimit, this.login.bind(this));
    this.router.patch('/users/:username', loginLimit, this.agreed.bind(this));
  }

  /** Send 400 and return false unless both credentials are non-empty strings. */
  private requireCredentials(
    res: Response,
    username: unknown,
    password: unknown
  ): boolean {
    if (typeof username !== 'string' || !username) {
      this.sendClientError(res, 400, 'MissingUsername', 'Username is required');
      return false;
    }
    if (typeof password !== 'string' || !password) {
      this.sendClientError(res, 400, 'MissingPassword', 'Password is required');
      return false;
    }
    return true;
  }

  /** Credentials from the :username route parameter and body password. */
  private parseCredentials(req: Request, res: Response): ILogin | null {
    const { username } = req.params;
    const password = req.body?.password;
    return this.requireCredentials(res, username, password)
      ? { username, password }
      : null;
  }

  // POST /auth/users
  public async register(req: Request, res: Response): Promise<void> {
    const username = req.body?.credentials?.username;
    const password = req.body?.credentials?.password;
    const email = req.body?.email;
    const agreed = req.body?.agreed;

    if (!this.requireCredentials(res, username, password)) return;
    if (typeof email !== 'string' || !email) {
      this.sendClientError(res, 400, 'MissingEmail', 'Email address is required');
      return;
    }
    if (typeof agreed !== 'boolean') {
      this.sendClientError(
        res,
        400,
        'UnauthorizedRequest',
        'Agreement to Terms of Service is required'
      );
      return;
    }

    try {
      const savedUser = await new User(
        { username, password },
        email,
        agreed
      ).join();
      res
        .status(201)
        .location(`/auth/users/${savedUser.credentials.username}`)
        .json(this.success('UserRegistered', this.sanitizeUser(savedUser)));
    } catch (error) {
      this.handleAppError(
        res,
        error,
        'An unexpected error occurred during registration'
      );
    }
  }

  // POST /auth/tokens/:username
  public async login(req: Request, res: Response): Promise<void> {
    const credentials = this.parseCredentials(req, res);
    if (!credentials) return;

    try {
      // Check account status before revealing whether the password matches.
      const account = await User.getUserAccount(credentials.username);
      if (account.status === 'Inactive') {
        this.sendClientError(
          res,
          403,
          'InactiveAccount',
          'Your account is inactive. Please contact an administrator to reactivate your account.'
        );
        return;
      }

      const user = await User.validateUser(credentials);
      if (!user.agreed) {
        this.sendClientError(
          res,
          401,
          'UnauthorizedRequest',
          'User not authorized to log in and access app until agrees to Terms of Service'
        );
        return;
      }

      const payload: IAuthenticatedUser = {
        token: signSessionToken({
          tokenVersion: account.tokenVersion ?? 0,
          userId: user._id!,
          username: user.credentials.username
        }),
        user: this.sanitizeUser(user)
      };
      res
        .status(200)
        .json(
          this.success(
            'UserAuthenticated',
            payload,
            `User ${user.credentials.username} is authenticated`
          )
        );
    } catch (error) {
      this.handleAppError(
        res,
        error,
        'An unexpected error occurred during login'
      );
    }
  }

  // PATCH /auth/users/:username — password-backed terms acceptance
  public async agreed(req: Request, res: Response): Promise<void> {
    const credentials = this.parseCredentials(req, res);
    if (!credentials) return;

    try {
      const user = await User.validateUser(credentials);
      const agreedUser = await User.setUserAgreedToTrue(user);
      res
        .status(200)
        .json(
          this.success(
            'UserAgreed',
            this.sanitizeUser(agreedUser),
            'User agreed status successfully set to true'
          )
        );
    } catch (error) {
      this.handleAppError(
        res,
        error,
        'An unexpected error occurred in the database'
      );
    }
  }

  // POST /auth/validate — format checks only, not uniqueness
  public validateField(req: Request, res: Response): void {
    const { field, value } = req.body;
    if (!field || typeof value !== 'string') {
      this.sendClientError(
        res,
        400,
        'MissingUsername',
        'Field and value are required'
      );
      return;
    }
    const validate = FIELD_VALIDATORS.get(field);
    if (!validate) {
      this.sendClientError(res, 400, 'MissingUsername', `Unknown field: ${field}`);
      return;
    }

    try {
      validate(value);
      res.status(200).json({ name: 'ValidationPassed', message: 'Valid' });
    } catch (error) {
      this.handleAppError(res, error, 'Validation failed unexpectedly');
    }
  }
}

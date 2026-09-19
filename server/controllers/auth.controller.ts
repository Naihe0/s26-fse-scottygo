// Controller serving the authentication page and handling user registration and login
// Note that controllers don't access the DB directly, only through the models

import { ILogin, IUser, ITokenPayload } from '../../common/user.interface';
import { User } from '../models/user.model';
import {
  validateUsernameFormat,
  validateEmailFormat,
  validatePasswordStrength
} from '../models/user.validation';
import Controller from './controller';
import { Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import {
  JWT_KEY as secretKey,
  JWT_EXP as tokenExpiry,
  STAGE as appStage
} from '../env';
import * as responses from '../../common/server.responses';
import { createIpRateLimiter } from '../services/auth-rate-limit.service';

/**
 * Return a client-error response for a missing required field.
 */
function clientError(
  name: responses.ClientErrorName,
  message: string
): responses.IAppError {
  return { type: 'ClientError', name, message };
}

/**
 * Validate that username and password are present in the given values.
 * Returns an IAppError if validation fails, or null if valid.
 */
function validateCredentials(
  username: unknown,
  password: unknown
): responses.IAppError | null {
  if (typeof username !== 'string' || !username) {
    return clientError('MissingUsername', 'Username is required');
  }
  if (typeof password !== 'string' || !password) {
    return clientError('MissingPassword', 'Password is required');
  }
  return null;
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

  /**
   * Validate and extract credentials from route params + body.
   * Sends a 400 response and returns null on failure.
   */
  private parseCredentials(req: Request, res: Response): ILogin | null {
    const credentialError = validateCredentials(
      req.params.username,
      req.body?.password
    );
    if (credentialError) {
      res.status(400).json(credentialError);
      return null;
    }
    return { username: req.params.username, password: req.body.password };
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
    this.router.get('/', this.authPage.bind(this));
    this.router.post('/validate', this.validateField.bind(this));
    this.router.post('/users', registerLimit, this.register.bind(this));
    this.router.post('/tokens/:username?', loginLimit, this.login.bind(this));
    this.router.patch('/users/:username', loginLimit, this.agreed.bind(this));
  }

  public authPage(req: Request, res: Response): void {
    this.sendPage(res, 'auth.html');
  }

  public async register(req: Request, res: Response) {
    const reqUsername = req.body?.credentials?.username;
    const reqPassword = req.body?.credentials?.password;
    const reqEmail = req.body?.email;
    const reqAgreed = req.body?.agreed;

    const credentialError = validateCredentials(reqUsername, reqPassword);
    if (credentialError) {
      return res.status(400).json(credentialError);
    } else if (typeof reqEmail !== 'string' || !reqEmail) {
      return res
        .status(400)
        .json(clientError('MissingEmail', 'Email address is required'));
    } else if (typeof reqAgreed !== 'boolean') {
      return res
        .status(400)
        .json(
          clientError(
            'UnauthorizedRequest',
            'Agreement to Terms of Service is required'
          )
        );
    }

    try {
      const newUser = new User(
        { username: reqUsername, password: reqPassword },
        reqEmail,
        reqAgreed
      );

      const savedUser = await newUser.join();
      const sanitizedUser = this.sanitizeUser(savedUser);

      const userResourcePath = `/auth/users/${savedUser.credentials.username}`;
      return res.status(201).location(userResourcePath).json({
        name: 'UserRegistered',
        payload: sanitizedUser
      });
    } catch (error: unknown) {
      return this.handleAppError(
        res,
        error,
        'An unexpected error occurred during registration'
      );
    }
  }

  public async login(req: Request, res: Response) {
    const credentials = this.parseCredentials(req, res);
    if (!credentials) return;

    try {
      // R5: Check account status before validating password
      const userAccount = await User.getUserAccount(credentials.username);
      if (userAccount.status === 'Inactive') {
        return res
          .status(403)
          .json(
            clientError(
              'InactiveAccount',
              'Your account is inactive. Please contact an administrator to reactivate your account.'
            )
          );
      }

      const user: IUser = await User.validateUser(credentials);

      // Check whether user has agreed to Terms of Service
      if (user.agreed === false) {
        return res
          .status(401)
          .json(
            clientError(
              'UnauthorizedRequest',
              'User not authorized to log in and access app until agrees to Terms of Service'
            )
          );
      }

      // Create token payload with userId (immutable) and username (for convenience)
      const tokenPayload: ITokenPayload = {
        tokenVersion: userAccount.tokenVersion ?? 0,
        userId: user._id!,
        username: user.credentials.username
      };

      // Handle both token expiry modes: actual time period and 'never'
      let signedToken: string;
      if (tokenExpiry == 'never') {
        signedToken = jwt.sign(tokenPayload, secretKey);
      } else {
        signedToken = jwt.sign(tokenPayload, secretKey, {
          expiresIn: tokenExpiry
        } as jwt.SignOptions);
      }

      const sanitizedUser = this.sanitizeUser(user);

      const payload: responses.IAuthenticatedUser = {
        token: signedToken,
        user: sanitizedUser
      };
      const successRes: responses.ISuccess = {
        name: 'UserAuthenticated',
        message: `User ${user.credentials.username} is authenticated`,
        payload: payload
      };
      return res.status(200).json(successRes);
    } catch (error: unknown) {
      return this.handleAppError(
        res,
        error,
        'An unexpected error occurred during login'
      );
    }
  }

  public async agreed(req: Request, res: Response) {
    const credentials = this.parseCredentials(req, res);
    if (!credentials) return;

    try {
      const userToUpdate: IUser = await User.validateUser(credentials);
      const agreedUser: IUser = await User.setUserAgreedToTrue(userToUpdate);
      const sanitizedUser = this.sanitizeUser(agreedUser);

      const successRes: responses.ISuccess = {
        name: 'UserAgreed',
        message: 'User agreed status successfully set to true',
        payload: sanitizedUser
      };
      return res.status(200).json(successRes);
    } catch (error: unknown) {
      return this.handleAppError(
        res,
        error,
        'An unexpected error occurred in the database'
      );
    }
  }

  public validateField(req: Request, res: Response) {
    const { field, value } = req.body;

    if (!field || typeof value !== 'string') {
      return res
        .status(400)
        .json(clientError('MissingUsername', 'Field and value are required'));
    }

    try {
      switch (field) {
        case 'username':
          validateUsernameFormat(value);
          break;
        case 'email':
          validateEmailFormat(value);
          break;
        case 'password':
          validatePasswordStrength(value);
          break;
        default:
          return res
            .status(400)
            .json(clientError('MissingUsername', `Unknown field: ${field}`));
      }

      return res
        .status(200)
        .json({ name: 'ValidationPassed', message: 'Valid' });
    } catch (error: unknown) {
      if (
        error &&
        typeof error === 'object' &&
        'type' in error &&
        'name' in error
      ) {
        return res.status(400).json(error);
      }
      return res.status(500).json({
        type: 'ServerError',
        name: 'MongoDBError',
        message: 'Validation failed unexpectedly'
      });
    }
  }
}

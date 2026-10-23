// Base class for route controllers: response envelopes, authentication
// middleware, and mapping of application errors to HTTP status codes.

import { Router, Response, Request, NextFunction } from 'express';
import { Server as SocketServer } from 'socket.io';
import { authenticateSession } from '../services/authentication.service';
import type { ILogin, ITokenPayload } from '../../common/user.interface';
import type {
  ClientErrorName,
  IAppError,
  IPayload,
  ISuccess,
  ServerErrorName,
  SuccessName
} from '../../common/server.responses';
import { clientError, serverError, toAppError } from '../errors';
import { createLogger, type ILogger } from '../logger';

/** Status codes for client errors that are not plain 400 Bad Request. */
const CLIENT_ERROR_STATUS: Partial<Record<ClientErrorName, number>> = {
  MissingToken: 401,
  InvalidToken: 401,
  ProximityViolation: 403,
  RouteNotFound: 404,
  StopNotFound: 404,
  VehicleNotFound: 404,
  SubscriptionNotFound: 404,
  DuplicateSubscription: 409,
  SubscriptionLimitReached: 409
};

export type AuthenticatedRequest = Request & { user: ITokenPayload };

abstract class Controller {
  public static io: SocketServer;

  public static clientDir: string;

  public readonly router: Router = Router();

  protected readonly log: ILogger;

  constructor(public readonly path: string) {
    this.log = createLogger(this.constructor.name);
    this.initializeRoutes();
  }

  /** Register this controller's endpoints on its router. */
  public abstract initializeRoutes(): void;

  /** Serve an HTML page from the built client directory. */
  protected sendPage(res: Response, htmlFile: string): void {
    res.sendFile(htmlFile, { root: Controller.clientDir });
  }

  /** Copy of a user with the password hash replaced by a placeholder. */
  protected sanitizeUser<T extends { credentials: ILogin }>(user: T): T {
    return {
      ...user,
      credentials: {
        username: user.credentials.username,
        password: 'obfuscated'
      }
    };
  }

  protected success(
    name: SuccessName,
    payload: IPayload,
    message?: string,
    metadata?: Record<string, unknown>
  ): ISuccess {
    const response: ISuccess = { name, payload };
    if (message) response.message = message;
    if (metadata) response.metadata = metadata;
    return response;
  }

  protected sendClientError(
    res: Response,
    status: number,
    name: ClientErrorName,
    message: string
  ): void {
    res.status(status).json(clientError(name, message));
  }

  /**
   * Middleware that rejects requests without an active session and exposes
   * the token payload to later handlers as `req.user`.
   */
  public async authenticateToken(
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) {
      this.sendClientError(res, 401, 'MissingToken', 'Token is required');
      return;
    }
    try {
      const { payload } = await authenticateSession(token);
      (req as AuthenticatedRequest).user = payload;
      next();
    } catch {
      this.sendClientError(res, 401, 'InvalidToken', 'Invalid or expired token');
    }
  }

  protected getTokenPayload(req: Request): ITokenPayload | null {
    return (req as Partial<AuthenticatedRequest>).user ?? null;
  }

  /**
   * Send a caught error. Application errors keep their name with a mapped
   * status; anything else is logged and reported as a generic server error.
   */
  protected handleAppError(
    res: Response,
    error: unknown,
    fallbackMessage = 'An unexpected error occurred',
    fallbackName: ServerErrorName = 'MongoDBError'
  ): void {
    const appError = toAppError(error);
    if (appError) {
      res.status(Controller.statusFor(appError)).json(appError);
      return;
    }
    this.log.error('Unexpected error:', error);
    res.status(500).json(serverError(fallbackName, fallbackMessage));
  }

  private static statusFor(error: IAppError): number {
    if (error.type !== 'ClientError') return 500;
    return CLIENT_ERROR_STATUS[error.name as ClientErrorName] ?? 400;
  }
}

export default Controller;

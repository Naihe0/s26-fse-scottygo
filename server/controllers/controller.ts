// controller superclass for behavior common to all controllers

import { Router, Response, Request, NextFunction } from 'express';
import { Server as SocketServer } from 'socket.io';
import path from 'path';
import { authenticateSession } from '../services/authentication.service';
import type { ILogin, ITokenPayload } from '../../common/user.interface';
import * as responses from '../../common/server.responses';

abstract class Controller {
  // note the abstract keyword here
  // path or partial URL managed by this controller
  public path: string;

  public static io: SocketServer;

  public static clientDir: string;

  // each controller has a router
  public router: Router = Router();

  /**
   * Helper to serve an HTML file from the client directory
   */
  protected sendPage(res: Response, htmlFile: string): void {
    res.sendFile(path.join(Controller.clientDir, htmlFile));
  }

  /**
   * Return a copy of the given object with the password replaced by 'obfuscated'.
   * T must contain a `credentials` field typed as ILogin.
   */
  protected sanitizeUser<T extends { credentials: ILogin }>(user: T): T {
    return {
      ...user,
      credentials: {
        username: user.credentials.username,
        password: 'obfuscated'
      }
    };
  }

  constructor(path: string) {
    this.path = path;
    this.initializeRoutes();
  }

  // each controller must define this method to set up its endpoints
  public abstract initializeRoutes(): void;

  /**
   * Narrow an unknown caught value to IAppError, or return null.
   * Use this instead of repeating the inline type guard.
   */
  protected asAppError(error: unknown): responses.IAppError | null {
    if (
      error &&
      typeof error === 'object' &&
      'type' in error &&
      'name' in error
    ) {
      return error as responses.IAppError;
    }
    return null;
  }

  protected clientError(
    name: responses.ClientErrorName,
    message: string
  ): responses.IAppError {
    return { type: 'ClientError', name, message };
  }

  protected success(
    name: responses.SuccessName,
    payload: responses.IPayload,
    message?: string,
    metadata?: Record<string, unknown>
  ): responses.ISuccess {
    const response: responses.ISuccess = { name, payload };
    if (message) response.message = message;
    if (metadata) response.metadata = metadata;
    return response;
  }

  /**
   * Shared JWT middleware used by controllers that protect API routes.
   * Attaches decoded token payload to req.user for downstream handlers.
   */
  protected async authenticateToken(
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) {
      res
        .status(401)
        .json(this.clientError('MissingToken', 'Token is required'));
      return;
    }

    try {
      const { payload } = await authenticateSession(token);
      (req as Request & { user: ITokenPayload }).user = payload;
      next();
    } catch {
      res
        .status(401)
        .json(this.clientError('InvalidToken', 'Invalid or expired token'));
    }
  }

  protected getTokenPayload(req: Request): ITokenPayload | null {
    const tokenPayload = (req as Request & { user?: ITokenPayload }).user;
    return tokenPayload ?? null;
  }

  /**
   * Uniform error handler for caught exceptions.
   * Forwards known IAppError shapes directly; wraps unknown errors as ServerError.
   */
  protected handleAppError(
    res: Response,
    error: unknown,
    fallbackMessage: string = 'An unexpected error occurred'
  ): void {
    const appError = this.asAppError(error);
    if (appError) {
      const statusCode = appError.type === 'ClientError' ? 400 : 500;
      res.status(statusCode).json(appError);
      return;
    }
    const unexpectedError: responses.IAppError = {
      type: 'ServerError',
      name: 'MongoDBError',
      message: fallbackMessage
    };
    res.status(500).json(unexpectedError);
  }
}

export default Controller;

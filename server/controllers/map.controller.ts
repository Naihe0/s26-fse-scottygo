// Controller serving the map page where the user lands after login
// Note that controllers don't access the DB direcly, only through the models

import { IUser } from '../../common/user.interface';
import { User } from '../models/user.model';
import Controller from './controller';
import { Request, Response } from 'express';
import { GOOGLE_MAPS_KEY } from '../env';
import {
  RouteSearchStrategy,
  TransitSearchStrategy,
  SearchContext
} from '../search/search-strategy';
import type {
  IRoute,
  ITransitSearchResult
} from '../../common/transit.interface';

// Default map center (CMU campus) and zoom level
const DEFAULT_MAP_CENTER = { lat: 40.4433, lon: -79.9436 };
const DEFAULT_MAP_ZOOM = 14;

export default class MapController extends Controller {
  private static instance: MapController | null = null;

  private constructor(path: string) {
    super(path);
  }

  public static getInstance(path: string): MapController {
    if (!MapController.instance) {
      MapController.instance = new MapController(path);
    }
    return MapController.instance;
  }

  public initializeRoutes(): void {
    this.router.get('/', this.mapPage.bind(this));
    this.router.get(
      '/users/:username',
      this.authenticateToken.bind(this),
      this.getUser.bind(this)
    );
    this.router.get(
      '/config',
      this.authenticateToken.bind(this),
      this.getMapConfig.bind(this)
    );

    // Search endpoints (SearchInfo UC — R1 contextual search)
    // Auth middleware is applied inline so the page route above stays open.
    this.router.get(
      '/routes/search',
      this.authenticateToken.bind(this),
      this.searchRoutes.bind(this)
    );
    this.router.get(
      '/search',
      this.authenticateToken.bind(this),
      this.searchTransit.bind(this)
    );
  }

  public mapPage(req: Request, res: Response): void {
    this.sendPage(res, 'map.html');
  }

  // Backward-compatible alias used in existing unit tests.
  public async authorize(
    req: Request,
    res: Response,
    next: (error?: unknown) => void
  ): Promise<void> {
    await this.authenticateToken(req, res, next);
  }

  // Get a User by username
  public async getUser(req: Request, res: Response) {
    const username = req.params.username;
    if (!username) {
      return res
        .status(400)
        .json(this.clientError('MissingUsername', 'Username is required'));
    }

    try {
      const token = this.getTokenPayload(req);
      if (!token) {
        return res
          .status(401)
          .json(this.clientError('MissingToken', 'Token is required'));
      }
      const requester = await User.getUserAccountById(token.userId);
      if (
        requester.status !== 'Active' ||
        (requester.privilegeLevel !== 'Administrator' &&
          requester.credentials.username.toLowerCase() !==
            username.toLowerCase())
      ) {
        return res
          .status(403)
          .json(
            this.clientError(
              'UnauthorizedRequest',
              'You can only view your own account'
            )
          );
      }
      const user: IUser | null = await User.getUserForUsername(username);

      if (!user) {
        return res
          .status(404)
          .json(
            this.clientError('UserNotFound', `User '${username}' not found`)
          );
      }

      const sanitizedUser = this.sanitizeUser(user);
      return res
        .status(200)
        .json(
          this.success(
            'UserFound',
            sanitizedUser,
            'User retrieved successfully'
          )
        );
    } catch (error: unknown) {
      return this.handleAppError(
        res,
        error,
        'An unexpected error occurred in the database'
      );
    }
  }

  // ── Search endpoints (SearchInfo UC) ──────────────────────────────────

  /**
   * GET /map/routes/search?q=<keywords>
   * Route Search context — returns up to 5 matching routes.
   * Uses RouteSearchStrategy (Strategy Pattern, R1).
   * Applies stop word filtering (R2).
   */
  public async searchRoutes(req: Request, res: Response): Promise<void> {
    const q = this.requireSearchQuery(req, res);
    if (!q) return;

    try {
      const context = new SearchContext<IRoute[]>(new RouteSearchStrategy());
      const results = await context.executeSearch(q);
      const message = results.length
        ? `Found ${results.length} route${results.length === 1 ? '' : 's'} matching '${q}'`
        : `No routes found matching '${q}'`;
      res
        .status(200)
        .json(this.success('SearchTransitCompleted', results, message));
    } catch (error: unknown) {
      this.handleAppError(res, error, 'Unexpected error during route search');
    }
  }

  /**
   * GET /map/search?q=<keywords>
   * Stop and Route Search context — returns up to 5 matching routes and 5 stops.
   * Uses TransitSearchStrategy (Strategy Pattern, R1).
   * Applies stop word filtering (R2).
   */
  public async searchTransit(req: Request, res: Response): Promise<void> {
    const q = this.requireSearchQuery(req, res);
    if (!q) return;

    try {
      const context = new SearchContext<ITransitSearchResult>(
        new TransitSearchStrategy()
      );
      const results = await context.executeSearch(q);
      const total = results.routes.length + results.stops.length;
      const message = total
        ? `Found ${total} result${total === 1 ? '' : 's'} matching '${q}'`
        : `No results found matching '${q}'`;
      res.status(200).json(
        this.success('SearchTransitCompleted', results, message, {
          totalItems: total
        })
      );
    } catch (error: unknown) {
      this.handleAppError(res, error, 'Unexpected error during transit search');
    }
  }

  private requireSearchQuery(req: Request, res: Response): string | null {
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    if (!q) {
      res
        .status(400)
        .json(
          this.clientError(
            'MissingSearchQuery',
            'Query parameter "q" is required'
          )
        );
      return null;
    }
    return q;
  }

  // Return Google Maps config to the client (API key, default center, zoom)
  public getMapConfig(req: Request, res: Response): void {
    res.status(200).json(
      this.success(
        'ConfigFound',
        {
          apiKey: GOOGLE_MAPS_KEY || '',
          lat: DEFAULT_MAP_CENTER.lat,
          lon: DEFAULT_MAP_CENTER.lon,
          defaultZoom: DEFAULT_MAP_ZOOM
        },
        'Google Maps configuration'
      )
    );
  }
}

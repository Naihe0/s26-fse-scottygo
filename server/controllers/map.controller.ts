// Map page (the landing page after sign-in), map configuration, user lookup,
// and transit search. Base path: /

import { Request, Response } from 'express';
import { User } from '../models/user.model';
import Controller from './controller';
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

/** Default map center (CMU campus) and zoom level. */
const DEFAULT_MAP_CENTER = { lat: 40.4433, lon: -79.9436 };
const DEFAULT_MAP_ZOOM = 14;

const plural = (count: number, noun: string) =>
  `${count} ${noun}${count === 1 ? '' : 's'}`;

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
    const authenticate = this.authenticateToken.bind(this);
    this.router.get('/', (_req, res) => this.sendPage(res, 'map.html'));
    this.router.get('/users/:username', authenticate, this.getUser.bind(this));
    this.router.get('/config', authenticate, this.getMapConfig.bind(this));
    this.router.get(
      '/routes/search',
      authenticate,
      this.searchRoutes.bind(this)
    );
    this.router.get('/search', authenticate, this.searchTransit.bind(this));
  }

  // GET /users/:username — own account, or any account for administrators
  public async getUser(req: Request, res: Response): Promise<void> {
    const username = req.params.username;
    if (!username) {
      this.sendClientError(res, 400, 'MissingUsername', 'Username is required');
      return;
    }

    try {
      const token = this.getTokenPayload(req);
      if (!token) {
        this.sendClientError(res, 401, 'MissingToken', 'Token is required');
        return;
      }
      const requester = await User.getUserAccountById(token.userId);
      const isAllowed =
        requester.status === 'Active' &&
        (requester.privilegeLevel === 'Administrator' ||
          requester.credentials.username.toLowerCase() ===
            username.toLowerCase());
      if (!isAllowed) {
        this.sendClientError(
          res,
          403,
          'UnauthorizedRequest',
          'You can only view your own account'
        );
        return;
      }

      const user = await User.getUserForUsername(username);
      res
        .status(200)
        .json(
          this.success(
            'UserFound',
            this.sanitizeUser(user),
            'User retrieved successfully'
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

  // GET /routes/search?q= — up to five PRT routes
  public async searchRoutes(req: Request, res: Response): Promise<void> {
    const q = this.requireSearchQuery(req, res);
    if (!q) return;

    try {
      const results = await new SearchContext<IRoute[]>(
        new RouteSearchStrategy()
      ).executeSearch(q);
      const message = results.length
        ? `Found ${plural(results.length, 'route')} matching '${q}'`
        : `No routes found matching '${q}'`;
      res
        .status(200)
        .json(this.success('SearchTransitCompleted', results, message));
    } catch (error) {
      this.handleAppError(res, error, 'Unexpected error during route search');
    }
  }

  // GET /search?q= — up to five routes and five stops across PRT and CMU
  public async searchTransit(req: Request, res: Response): Promise<void> {
    const q = this.requireSearchQuery(req, res);
    if (!q) return;

    try {
      const results = await new SearchContext<ITransitSearchResult>(
        new TransitSearchStrategy()
      ).executeSearch(q);
      const total = results.routes.length + results.stops.length;
      const message = total
        ? `Found ${plural(total, 'result')} matching '${q}'`
        : `No results found matching '${q}'`;
      res.status(200).json(
        this.success('SearchTransitCompleted', results, message, {
          totalItems: total
        })
      );
    } catch (error) {
      this.handleAppError(res, error, 'Unexpected error during transit search');
    }
  }

  private requireSearchQuery(req: Request, res: Response): string | null {
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    if (!q) {
      this.sendClientError(
        res,
        400,
        'MissingSearchQuery',
        'Query parameter "q" is required'
      );
      return null;
    }
    return q;
  }

  // GET /config — browser Maps key and default view
  public getMapConfig(_req: Request, res: Response): void {
    res.status(200).json(
      this.success(
        'ConfigFound',
        {
          apiKey: GOOGLE_MAPS_KEY,
          lat: DEFAULT_MAP_CENTER.lat,
          lon: DEFAULT_MAP_CENTER.lon,
          defaultZoom: DEFAULT_MAP_ZOOM
        },
        'Google Maps configuration'
      )
    );
  }
}

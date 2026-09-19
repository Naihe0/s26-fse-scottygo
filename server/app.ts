import express, { Express, Request, Response, NextFunction } from 'express';
import { Server as HttpServer, createServer } from 'http';
import DAC, { IDatabase } from './db/dac';
import Controller from './controllers/controller';
import gtfsService from './services/gtfs.service';
import vehiclePositionsService from './services/vehicle-positions.service';
import tripUpdatesService from './services/trip-updates.service';
import tripshotLiveStatusService from './services/tripshot-livestatus.service';
import tripshotService from './services/tripshot.service';
import alertsService from './services/alerts.service';
import memoryMonitorService from './services/memory-monitor.service';
import { TransitModel } from './models/transit.model';
import { NotificationModel } from './models/notification.model';
import { STAGE, BIND_ADDRESS, ENV } from './env';
import { Server as SocketServer, Socket } from 'socket.io';
import {
  ClientToServerEvents,
  ServerToClientEvents,
  ISearchAutocompleteContext,
  ISearchSuggestion
} from '../common/socket.interface';
import { ExtendedError } from 'socket.io';
import {
  authenticateSocket,
  configureSocketSession,
  subscribeSocketToAccount
} from './services/socket-session.service';
import {
  NotificationAutocompleteStrategy,
  SearchContext,
  TransitSearchStrategy
} from './search/search-strategy';
import type { ITransitSearchResult } from '../common/transit.interface';

class App {
  public app: Express;

  public port: number;

  public db: IDatabase;

  public host: string;

  public clientDir: string; // pathname for the client folder

  public url: string;

  public server: HttpServer;

  public io: SocketServer;

  private dailyRefreshIntervalId: ReturnType<typeof setInterval> | null = null;
  private isShuttingDown = false;

  /** Resolves once the background init chain (DB, GTFS, caches, pollers) completes. */
  public initComplete!: Promise<void>;

  constructor(
    controllers: Controller[],
    params: {
      port: number;
      host: string;
      clientDir: string;
      db: IDatabase;
      url: string;
      initOnStart: boolean;
    }
  ) {
    this.app = express();
    this.server = createServer(this.app);
    this.io = new SocketServer<ClientToServerEvents, ServerToClientEvents>(
      this.server
    );
    this.port = params.port;
    this.db = params.db;
    this.host = params.host;
    this.clientDir = params.clientDir;
    this.url = params.url; // construct the URL from the host and port
    this.configureApp(params.initOnStart);
    this.configureMiddlewares();
    this.configureControllers(controllers);
  }

  private configureApp(initOnStart: boolean) {
    DAC.db = this.db;
    memoryMonitorService.start();
    memoryMonitorService.capture('configureApp.start');

    // Load GTFS static schedule data (needed before cache refresh)
    const gtfsReady = gtfsService.load().catch((err) => {
      console.error(
        `[GTFS ${new Date().toISOString()}] Failed to load feed:`,
        err
      );
    });

    this.initComplete = DAC.db.connect().then(async () => {
      if (this.isShuttingDown) {
        return;
      }
      memoryMonitorService.enablePersistence();
      memoryMonitorService.capture('db.connected');
      if (initOnStart) {
        await this.db.init();
        if (this.isShuttingDown) {
          return;
        }
        memoryMonitorService.capture('db.init.complete');
        // Resets require explicit opt-in and are forbidden in production.
      }
      // Seed default admin user if it doesn't exist
      // This runs in both PROD and non-PROD to ensure default admin exists
      await this.db.seedDefaultAdmin();
      if (this.isShuttingDown) {
        return;
      }
      memoryMonitorService.capture('seedDefaultAdmin.complete');

      // Wait for GTFS to finish loading before populating the cache
      await gtfsReady;
      if (this.isShuttingDown) {
        return;
      }
      memoryMonitorService.capture('gtfs.load.complete');

      // Populate the transit cache from GTFS data + one TrueTime call for colors.
      // Await completion so GTFS parsing temporaries can be GC'd before
      // GTFS-RT polling adds more allocations — prevents startup peak OOM.
      try {
        await TransitModel.refreshAllCaches();
        if (this.isShuttingDown) {
          return;
        }
        memoryMonitorService.capture('transit.refreshAllCaches.complete');
      } catch (err) {
        console.error(
          `[TransitModel ${new Date().toISOString()}] Initial cache refresh failed:`,
          err
        );
      }

      // Force GC to reclaim GTFS parsing temporaries (~250 MB) before
      // GTFS-RT polling allocates more — keeps peak RSS under 512 MB.
      if (global.gc) {
        global.gc();
        memoryMonitorService.capture('post-startup-gc');
        console.log(
          `[Server ${new Date().toISOString()}] Forced GC after cache refresh`
        );
      }

      // Start polling GTFS-RT feeds every 30 s (in-memory)
      // Delayed until after cache refresh so V8 can GC startup temporaries first.
      const isTestEnv = process.env.NODE_ENV === 'test';
      vehiclePositionsService.start();
      tripUpdatesService.start();
      if (!isTestEnv) {
        // Wire up pattern cache warm-up before starting the poller so the
        // callback is set before the first successful fetch can fire.
        tripshotLiveStatusService.onFirstSuccess = () => {
          if (typeof tripshotService.warmPatternCache !== 'function') {
            return;
          }

          tripshotService
            .warmPatternCache()
            .catch((err) =>
              console.error(
                `[Server ${new Date().toISOString()}] Pattern warm-up failed:`,
                err
              )
            );
        };
        tripshotLiveStatusService.start();
      }
      if (this.isShuttingDown) {
        vehiclePositionsService.stop();
        tripUpdatesService.stop();
        if (!isTestEnv) {
          tripshotLiveStatusService.stop();
        }
        return;
      }
      memoryMonitorService.capture('realtime-pollers.started');

      // Start GTFS-RT alerts polling and wire up Socket.io push (TUC3)
      alertsService.onAlertsChanged = (alerts) => {
        this.io.emit('alertUpdate', alerts);
      };
      alertsService.start();

      // Initialize last-known bus status map from DB (TUC3 R12)
      await NotificationModel.initialize();

      // Schedule a daily cache refresh (every 24 h).
      const TWENTY_FOUR_HOURS = 24 * 60 * 60 * 1000;
      this.dailyRefreshIntervalId = setInterval(async () => {
        memoryMonitorService.capture(
          'transit.refreshAllCaches.scheduled.start'
        );
        try {
          await TransitModel.refreshAllCaches();
          memoryMonitorService.capture(
            'transit.refreshAllCaches.scheduled.complete'
          );
          if (global.gc) {
            global.gc();
            memoryMonitorService.capture(
              'transit.refreshAllCaches.scheduled.post-gc'
            );
          }
        } catch (err) {
          console.error(
            `[TransitModel ${new Date().toISOString()}] Scheduled cache refresh failed:`,
            err
          );
          memoryMonitorService.capture(
            'transit.refreshAllCaches.scheduled.failed'
          );
        }
      }, TWENTY_FOUR_HOURS);

      // Do not keep the Node.js event loop alive solely for this long timer.
      this.dailyRefreshIntervalId.unref?.();
    });
  }

  private configureMiddlewares() {
    // Render terminates requests at its ingress proxy. Trust that one hop,
    // not arbitrary client-supplied entries on the left of X-Forwarded-For.
    this.app.set(
      'trust proxy',
      ENV === 'RENDER' || ENV === 'CODESPACE' ? 1 : false
    );

    // Avoid noisy 404s in browser dev tools for favicon requests.
    this.app.get('/favicon.ico', (_req: Request, res: Response) => {
      res.status(204).end();
    });

    // SECURITY: Enforce HTTPS in production - throw hard error, never redirect non-SSL to SSL
    // This prevents poorly configured clients from leaking data over unencrypted connections
    this.app.use(this.enforceHttps);
    this.app.use(express.static(this.clientDir)); // serve the static assets from the client folder
    this.app.use('/assets', express.static('assets')); // serve CSV and other assets
    this.app.use(express.json()); // for parsing request's json body
    this.app.use(express.urlencoded({ extended: true })); // for decoding the encoded url
    this.app.use(this.serverLogger); // add a logging middleware
    this.io.use(this.validateToken);
  }

  private configureControllers(controllers: Controller[]) {
    Controller.io = this.io;
    Controller.clientDir = this.clientDir;
    controllers.forEach((controller) => {
      this.app.use(controller.path, controller.router);
    });
  }

  /**
   * Middleware to enforce HTTPS in production environments.
   * Following security best practices: throws a hard error instead of redirecting
   * to ensure misconfigured clients are caught early.
   *
   * In production environments (like Render), TLS termination happens at the
   * load balancer/reverse proxy level. The proxy sets X-Forwarded-Proto header
   * to indicate the original protocol used by the client.
   *
   * Reference: https://www.vinaysahni.com/best-practices-for-a-pragmatic-restful-api
   * "Do not redirect non-SSL to SSL. Throw a hard error instead"
   */
  private enforceHttps(req: Request, res: Response, next: NextFunction) {
    // Only enforce in production
    if (STAGE !== 'PROD') {
      return next();
    }

    // Allow local loopback HTTP for local diagnostics even when STAGE=PROD.
    // This preserves strict HTTPS behavior for non-local traffic.
    const host = (req.headers.host ?? '').toLowerCase();
    const hostname = (req.hostname ?? '').toLowerCase();
    const ip = (req.ip ?? '').toLowerCase();
    const isLoopback =
      hostname === 'localhost' ||
      hostname === '127.0.0.1' ||
      hostname === '::1' ||
      host.startsWith('localhost:') ||
      host.startsWith('127.0.0.1:') ||
      host.startsWith('[::1]:') ||
      ip === '127.0.0.1' ||
      ip === '::1' ||
      ip === '::ffff:127.0.0.1';

    if (isLoopback) {
      return next();
    }

    // Check protocol safely behind proxies. Some providers send a comma-separated
    // chain like "https,http"; treat any HTTPS value as secure.
    const forwardedProtoHeader = req.headers['x-forwarded-proto'];
    const forwardedProtoRaw = Array.isArray(forwardedProtoHeader)
      ? forwardedProtoHeader.join(',')
      : (forwardedProtoHeader ?? '').toString();
    const forwardedProtoValues = forwardedProtoRaw
      .split(',')
      .map((p) => p.trim().toLowerCase())
      .filter(Boolean);
    const protocol = (req.protocol || 'http').toLowerCase();
    const isHttps =
      protocol === 'https' || forwardedProtoValues.includes('https');

    // If the original request was not HTTPS, throw a hard error
    if (!isHttps) {
      console.error(
        `[Security ${new Date().toISOString()}] Blocked non-HTTPS request to ${req.method} ${req.path} from ${req.ip}`
      );

      return res.status(403).json({
        error: 'HTTPS Required',
        message:
          'This API requires all requests to be made over HTTPS. Please update your configuration to use https:// instead of http://'
      });
    }

    next();
  }

  public serverLogger(req: Request, res: Response, next: NextFunction) {
    // TODO
    next();
  }

  public validateToken = authenticateSocket;

  // listen for incoming requests
  public async listen(): Promise<HttpServer> {
    return new Promise<HttpServer>((resolve, reject) => {
      this.server.once('close', () => {
        this.isShuttingDown = true;
        memoryMonitorService.stop();
        vehiclePositionsService.stop();
        tripUpdatesService.stop();
        tripshotLiveStatusService.stop();
        alertsService.stop();
        if (this.dailyRefreshIntervalId) {
          clearInterval(this.dailyRefreshIntervalId);
          this.dailyRefreshIntervalId = null;
        }
      });

      this.io.on('connection', (socket: Socket) => {
        console.log(
          `⚡️[Server ${new Date().toISOString()}] A client connected to the socket server with id ${socket.id}`
        );

        configureSocketSession(socket);

        // Handle subscribeAccount event
        socket.on('subscribeAccount', (username: string) => {
          subscribeSocketToAccount(socket, username);
        });

        // Handle unsubscribeAccount event
        socket.on('unsubscribeAccount', (username: string) => {
          if (typeof username !== 'string' || username.length > 128) return;
          const roomName = `account:${username.toLowerCase()}`;
          socket.leave(roomName);
          console.log(
            `[Socket ${new Date().toISOString()}] Client ${socket.id} unsubscribed from ${roomName}`
          );
        });

        // Handle subscribeRoute event (TUC3 — Observer Pattern R4)
        socket.on('subscribeRoute', (data: { routeId: string }) => {
          if (
            typeof data?.routeId !== 'string' ||
            !data.routeId ||
            data.routeId.length > 128
          )
            return;
          const roomName = `route:${data.routeId}`;
          socket.join(roomName);
          console.log(
            `[Socket ${new Date().toISOString()}] Client ${socket.id} subscribed to ${roomName}`
          );
        });

        // Handle unsubscribeRoute event (TUC3)
        socket.on('unsubscribeRoute', (data: { routeId: string }) => {
          if (
            typeof data?.routeId !== 'string' ||
            !data.routeId ||
            data.routeId.length > 128
          )
            return;
          const roomName = `route:${data.routeId}`;
          socket.leave(roomName);
          console.log(
            `[Socket ${new Date().toISOString()}] Client ${socket.id} unsubscribed from ${roomName}`
          );
        });

        // Handle contextual autocomplete for SearchInfo (transit, notifications)
        socket.on(
          'searchAutocomplete',
          async (query: string, context: ISearchAutocompleteContext) => {
            const trimmed =
              typeof query === 'string' && query.length <= 500
                ? query.trim()
                : '';
            if (!trimmed) {
              socket.emit('searchSuggestions', []);
              return;
            }

            try {
              if (context === 'transit') {
                const searchContext = new SearchContext<ITransitSearchResult>(
                  new TransitSearchStrategy()
                );
                const results = await searchContext.executeSearch(trimmed);
                const suggestions = this.buildTransitSuggestions(results);
                socket.emit('searchSuggestions', suggestions);
                return;
              }

              if (context === 'notifications') {
                const searchContext = new SearchContext<ISearchSuggestion[]>(
                  new NotificationAutocompleteStrategy()
                );
                const suggestions = await searchContext.executeSearch(trimmed);
                socket.emit('searchSuggestions', suggestions);
                return;
              }

              socket.emit('searchSuggestions', []);
            } catch (error) {
              console.error(
                `[Socket ${new Date().toISOString()}] Error in searchAutocomplete: ${error}`
              );
              socket.emit('searchSuggestions', []);
            }
          }
        );
      });

      try {
        this.server.listen(this.port, BIND_ADDRESS, () => {
          // must listen on http server, not express app, for socket.io to work
          console.log(
            `⚡️[Server ${new Date().toISOString()}] Running at ${this.url} ...`
          );
          resolve(this.server);
        });
      } catch (err) {
        reject(err);
      }
    });
  }

  private buildTransitSuggestions(results: ITransitSearchResult): string[] {
    const suggestions: string[] = [];

    for (const route of results.routes) {
      suggestions.push(route.id);
      if (route.name && route.name.toLowerCase() !== route.id.toLowerCase()) {
        suggestions.push(route.name);
      }
    }

    for (const stop of results.stops) {
      suggestions.push(stop.stopName);
      suggestions.push(stop.stopId);
    }

    return this.uniqueSuggestions(suggestions, 5);
  }

  private uniqueSuggestions(values: string[], limit: number): string[] {
    const deduped: string[] = [];
    const seen = new Set<string>();

    for (const value of values) {
      const trimmed = value.trim();
      if (!trimmed) continue;
      const key = trimmed.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      deduped.push(trimmed);
      if (deduped.length >= limit) break;
    }

    return deduped;
  }
}

export default App;

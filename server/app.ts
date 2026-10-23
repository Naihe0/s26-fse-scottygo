// Express + Socket.IO application: middleware, controllers, socket events,
// and the startup sequence for the database, GTFS data, and live feeds.

import express, { Express, Request, Response, NextFunction } from 'express';
import { Server as HttpServer, createServer } from 'http';
import { Server as SocketServer, Socket } from 'socket.io';
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
import { STAGE, BIND_ADDRESS, ENV } from './env';
import {
  ClientToServerEvents,
  ServerToClientEvents,
  ISearchAutocompleteContext
} from '../common/socket.interface';
import {
  accountRoom,
  authenticateSocket,
  configureSocketSession,
  isValidRoomId,
  routeRoom,
  subscribeSocketToAccount
} from './services/socket-session.service';
import {
  ISearchStrategy,
  NotificationAutocompleteStrategy,
  TransitAutocompleteStrategy
} from './search/search-strategy';
import { createLogger } from './logger';

const DAILY_REFRESH_MS = 24 * 60 * 60 * 1000;
const MAX_AUTOCOMPLETE_QUERY_LENGTH = 500;

const log = createLogger('Server');
const socketLog = createLogger('Socket');

const AUTOCOMPLETE_STRATEGIES = new Map<
  ISearchAutocompleteContext,
  () => ISearchStrategy<unknown[]>
>([
  ['transit', () => new TransitAutocompleteStrategy()],
  ['notifications', () => new NotificationAutocompleteStrategy()]
]);

/** Loopback requests are allowed over HTTP for local diagnostics in PROD. */
function isLoopbackRequest(req: Request): boolean {
  const host = (req.headers.host ?? '').toLowerCase();
  const hostname = (req.hostname ?? '').toLowerCase();
  const ip = (req.ip ?? '').toLowerCase();
  return (
    ['localhost', '127.0.0.1', '::1'].includes(hostname) ||
    ['localhost:', '127.0.0.1:', '[::1]:'].some((p) => host.startsWith(p)) ||
    ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(ip)
  );
}

/** True when the client reached the proxy (or us) over HTTPS. */
function isHttpsRequest(req: Request): boolean {
  // Some proxies send a chain like "https,http"; any HTTPS hop counts.
  const forwarded = [req.headers['x-forwarded-proto'] ?? []]
    .flat()
    .join(',')
    .split(',')
    .map((value) => value.trim().toLowerCase());
  return (
    (req.protocol || 'http').toLowerCase() === 'https' ||
    forwarded.includes('https')
  );
}

/**
 * Reject plain-HTTP requests in production with a hard error instead of a
 * redirect, so misconfigured clients fail before leaking data. TLS ends at
 * the hosting proxy, which reports the original protocol in X-Forwarded-Proto.
 */
function enforceHttps(req: Request, res: Response, next: NextFunction): void {
  if (STAGE !== 'PROD' || isLoopbackRequest(req) || isHttpsRequest(req)) {
    next();
    return;
  }
  log.error(
    `Blocked non-HTTPS request to ${req.method} ${req.path} from ${req.ip}`
  );
  res.status(403).json({
    error: 'HTTPS Required',
    message:
      'This API requires all requests to be made over HTTPS. Please update your configuration to use https:// instead of http://'
  });
}

class App {
  public app: Express;

  public port: number;

  public db: IDatabase;

  public host: string;

  public clientDir: string;

  public url: string;

  public server: HttpServer;

  public io: SocketServer;

  /** Resolves once the background startup chain (DB, GTFS, caches, pollers) completes. */
  public initComplete!: Promise<void>;

  private dailyRefreshIntervalId: ReturnType<typeof setInterval> | null = null;

  private isShuttingDown = false;

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
    this.url = params.url;
    this.startBackgroundInitialization(params.initOnStart);
    this.configureMiddlewares();
    this.configureControllers(controllers);
  }

  private startBackgroundInitialization(initOnStart: boolean): void {
    DAC.db = this.db;
    memoryMonitorService.start();
    memoryMonitorService.capture('configureApp.start');

    // GTFS downloads while the database connects; caches need both.
    const gtfsReady = gtfsService
      .load()
      .catch((err) => createLogger('GTFS').error('Failed to load feed:', err));

    this.initComplete = DAC.db
      .connect()
      .then(() => this.initializeAfterConnect(initOnStart, gtfsReady));
  }

  /**
   * Startup after MongoDB connects. Each step checks for shutdown so a
   * closing server never starts pollers or timers.
   */
  private async initializeAfterConnect(
    initOnStart: boolean,
    gtfsReady: Promise<void>
  ): Promise<void> {
    const steps: [string, () => Promise<void>][] = [
      ['db.connected', async () => memoryMonitorService.enablePersistence()],
      // Resets require explicit opt-in and are forbidden in production.
      ...(initOnStart
        ? [['db.init.complete', () => this.db.init()] as [string, () => Promise<void>]]
        : []),
      ['seedDefaultAdmin.complete', () => this.db.seedDefaultAdmin()],
      ['gtfs.load.complete', () => gtfsReady],
      // Build caches before live polling so GTFS parsing memory can be
      // reclaimed first; this keeps peak memory within the small instance.
      [
        'transit.refreshAllCaches.complete',
        () => TransitModel.refreshAllCaches()
      ]
    ];
    for (const [phase, step] of steps) {
      if (this.isShuttingDown) return;
      await step();
      memoryMonitorService.capture(phase);
    }

    if (global.gc) {
      global.gc();
      memoryMonitorService.capture('post-startup-gc');
      log.info('Forced GC after cache refresh');
    }
    if (this.isShuttingDown) return;

    this.startLiveFeeds();
    memoryMonitorService.capture('realtime-pollers.started');
    this.scheduleDailyCacheRefresh();
  }

  private startLiveFeeds(): void {
    vehiclePositionsService.start();
    tripUpdatesService.start();
    // TripShot is an external public feed; tests never poll it.
    if (process.env.NODE_ENV !== 'test') {
      tripshotLiveStatusService.onFirstSuccess = () => {
        tripshotService
          .warmPatternCache()
          .catch((err) => log.error('Pattern warm-up failed:', err));
      };
      tripshotLiveStatusService.start();
    }
    alertsService.onAlertsChanged = (alerts) =>
      this.io.emit('alertUpdate', alerts);
    alertsService.start();
  }

  private scheduleDailyCacheRefresh(): void {
    this.dailyRefreshIntervalId = setInterval(async () => {
      memoryMonitorService.capture('transit.refreshAllCaches.scheduled.start');
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
    }, DAILY_REFRESH_MS);
    // Do not keep the event loop alive solely for this long timer.
    this.dailyRefreshIntervalId.unref?.();
  }

  private stopBackgroundWork(): void {
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
  }

  private configureMiddlewares(): void {
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
    this.app.use(enforceHttps);
    this.app.use(express.static(this.clientDir));
    this.app.use(express.json());
    this.app.use(express.urlencoded({ extended: true }));
    this.io.use(authenticateSocket);
  }

  private configureControllers(controllers: Controller[]): void {
    Controller.io = this.io;
    Controller.clientDir = this.clientDir;
    for (const controller of controllers) {
      this.app.use(controller.path, controller.router);
    }
  }

  private registerSocketHandlers(socket: Socket): void {
    socketLog.info(`Client connected: ${socket.id}`);
    configureSocketSession(socket);

    socket.on('subscribeAccount', (username: unknown) => {
      subscribeSocketToAccount(socket, username);
    });

    socket.on('unsubscribeAccount', (username: unknown) => {
      if (isValidRoomId(username)) socket.leave(accountRoom(username));
    });

    socket.on('subscribeRoute', (data: { routeId?: unknown }) => {
      if (isValidRoomId(data?.routeId)) socket.join(routeRoom(data.routeId));
    });

    socket.on('unsubscribeRoute', (data: { routeId?: unknown }) => {
      if (isValidRoomId(data?.routeId)) socket.leave(routeRoom(data.routeId));
    });

    socket.on(
      'searchAutocomplete',
      async (query: unknown, context: ISearchAutocompleteContext) => {
        const trimmed =
          typeof query === 'string' &&
          query.length <= MAX_AUTOCOMPLETE_QUERY_LENGTH
            ? query.trim()
            : '';
        const createStrategy = AUTOCOMPLETE_STRATEGIES.get(context);
        if (!trimmed || !createStrategy) {
          socket.emit('searchSuggestions', []);
          return;
        }
        try {
          socket.emit('searchSuggestions', await createStrategy().search(trimmed));
        } catch (error) {
          socketLog.error('Error in searchAutocomplete:', error);
          socket.emit('searchSuggestions', []);
        }
      }
    );
  }

  /** Start accepting HTTP and Socket.IO connections. */
  public listen(): Promise<HttpServer> {
    return new Promise<HttpServer>((resolve, reject) => {
      this.server.once('close', () => this.stopBackgroundWork());
      this.io.on('connection', (socket) => this.registerSocketHandlers(socket));
      // listen() reports failures such as EADDRINUSE as 'error' events.
      this.server.once('error', reject);
      this.server.listen(this.port, BIND_ADDRESS, () => {
        this.server.off('error', reject);
        log.info(`Running at ${this.url} ...`);
        resolve(this.server);
      });
    });
  }
}

export default App;

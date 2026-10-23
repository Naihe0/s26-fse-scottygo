// Service health and memory diagnostics. Base path: /transit

import { Request, Response } from 'express';
import Controller from './controller';
import DAC from '../db/dac';
import vehiclePositionsService from '../services/vehicle-positions.service';
import tripUpdatesService from '../services/trip-updates.service';
import tripshotLiveStatusService from '../services/tripshot-livestatus.service';
import memoryMonitorService, {
  summarizeMemorySamples
} from '../services/memory-monitor.service';
import type { PollingFeed } from '../services/polling-feed';
import { TransitModel } from '../models/transit.model';
import gtfsService from '../services/gtfs.service';

const SAMPLES_LIMIT = { default: 120, max: 2000 };
const SUMMARY_LIMIT = { default: 720, max: 5000 };

/** Parse a positive integer query value, clamped to [1, max]. */
export function parseLimit(
  rawLimit: unknown,
  limits: { default: number; max: number }
): number {
  const parsed =
    typeof rawLimit === 'string' && rawLimit
      ? Number.parseInt(rawLimit, 10)
      : limits.default;
  if (!Number.isFinite(parsed)) return limits.default;
  return Math.min(Math.max(parsed, 1), limits.max);
}

function feedStatus(feed: PollingFeed<unknown>) {
  return {
    healthy: feed.isHealthy(),
    lastFetched: feed.getLastFetched()?.toISOString() ?? null,
    consecutiveFailures: feed.getConsecutiveFailures(),
    error: feed.getLastError()
  };
}

export default class HealthController extends Controller {
  private static instance: HealthController | null = null;

  private constructor(path: string) {
    super(path);
  }

  public static getInstance(path: string): HealthController {
    if (!HealthController.instance) {
      HealthController.instance = new HealthController(path);
    }
    return HealthController.instance;
  }

  public initializeRoutes(): void {
    this.router.get('/health', this.getHealth.bind(this));
    this.router.get('/memory/samples', this.getMemorySamples.bind(this));
    this.router.get('/memory/summary', this.getMemorySummary.bind(this));
    this.router.get('/memory/dashboard', this.getMemoryDashboard.bind(this));
  }

  // GET /transit/health — always 200; `overall` reports transit readiness.
  private getHealth(_req: Request, res: Response): void {
    const status = {
      gtfs: { ready: gtfsService.isLoaded() },
      memory: memoryMonitorService.getSummary(),
      vehiclePositions: feedStatus(vehiclePositionsService),
      tripUpdates: feedStatus(tripUpdatesService),
      trueTimeColors: { available: TransitModel.colorsAvailable },
      tripshotLiveStatus: feedStatus(tripshotLiveStatusService)
    };
    res.status(200).json({
      ...status,
      overall:
        status.gtfs.ready &&
        status.vehiclePositions.healthy &&
        status.tripUpdates.healthy &&
        status.tripshotLiveStatus.healthy
    });
  }

  // GET /transit/memory/samples?limit=120 — newest first
  private async getMemorySamples(req: Request, res: Response): Promise<void> {
    try {
      const samples = await DAC.db.getRecentMemorySamples(
        parseLimit(req.query.limit, SAMPLES_LIMIT)
      );
      res.status(200).json({
        name: 'MemorySamplesRetrieved',
        message: `Found ${samples.length} memory samples`,
        payload: samples
      });
    } catch (error) {
      this.handleAppError(res, error);
    }
  }

  // GET /transit/memory/summary?limit=720
  private async getMemorySummary(req: Request, res: Response): Promise<void> {
    try {
      const samples = await DAC.db.getRecentMemorySamples(
        parseLimit(req.query.limit, SUMMARY_LIMIT)
      );
      const summary = summarizeMemorySamples([...samples].reverse());
      res.status(200).json({
        name: 'MemorySummaryRetrieved',
        message:
          summary.sampleCount === 0
            ? 'No memory samples available yet'
            : `Analyzed ${summary.sampleCount} memory samples`,
        payload: summary
      });
    } catch (error) {
      this.handleAppError(res, error);
    }
  }

  // GET /transit/memory/dashboard — built from client/pages/memory-dashboard.html
  private getMemoryDashboard(_req: Request, res: Response): void {
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; img-src 'self' data:; connect-src 'self'"
    );
    res.setHeader('Cache-Control', 'no-store');
    this.sendPage(res, 'memory-dashboard.html');
  }
}

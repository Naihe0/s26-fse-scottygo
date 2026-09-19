// Controller for service health and memory monitoring endpoints
// Base path: /transit  (routes: /health, /memory/*)

import { Request, Response } from 'express';
import { memoryDashboardHtml } from '../views/memory-dashboard';
import Controller from './controller';
import DAC from '../db/dac';
import vehiclePositionsService from '../services/vehicle-positions.service';
import tripUpdatesService from '../services/trip-updates.service';
import tripshotLiveStatusService from '../services/tripshot-livestatus.service';
import memoryMonitorService from '../services/memory-monitor.service';
import { TransitModel } from '../models/transit.model';
import gtfsService from '../services/gtfs.service';
import { parseLimit } from './transit.controller';
import * as responses from '../../common/server.responses';

export default class HealthController extends Controller {
  private static instance: HealthController | null = null;

  private static readonly MEMORY_LIMIT_DEFAULT = 120;

  private static readonly MEMORY_LIMIT_MAX = 2000;

  private static readonly MEMORY_SUMMARY_LIMIT_DEFAULT = 720;

  private static readonly MEMORY_SUMMARY_LIMIT_MAX = 5000;

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

  // GET /transit/health — service health status for the frontend
  private getHealth(_req: Request, res: Response): void {
    const vehiclesHealthy = vehiclePositionsService.isHealthy();
    const tripsHealthy = tripUpdatesService.isHealthy();
    const tripshotHealthy = tripshotLiveStatusService.isHealthy();
    const colorsAvailable = TransitModel.colorsAvailable;
    const gtfsReady = gtfsService.isLoaded();

    const status = {
      gtfs: { ready: gtfsReady },
      memory: memoryMonitorService.getSummary(),
      vehiclePositions: {
        healthy: vehiclesHealthy,
        lastFetched:
          vehiclePositionsService.getLastFetched()?.toISOString() ?? null,
        consecutiveFailures: vehiclePositionsService.getConsecutiveFailures(),
        error: vehiclePositionsService.getLastError()
      },
      tripUpdates: {
        healthy: tripsHealthy,
        lastFetched: tripUpdatesService.getLastFetched()?.toISOString() ?? null,
        consecutiveFailures: tripUpdatesService.getConsecutiveFailures(),
        error: tripUpdatesService.getLastError()
      },
      trueTimeColors: {
        available: colorsAvailable
      },
      tripshotLiveStatus: {
        healthy: tripshotHealthy,
        lastFetched:
          tripshotLiveStatusService.getLastFetched()?.toISOString() ?? null,
        consecutiveFailures: tripshotLiveStatusService.getConsecutiveFailures(),
        error: tripshotLiveStatusService.getLastError()
      },
      overall: gtfsReady && vehiclesHealthy && tripsHealthy && tripshotHealthy
    };

    res.status(200).json(status);
  }

  // GET /transit/memory/samples?limit=120
  private async getMemorySamples(req: Request, res: Response): Promise<void> {
    const limit = parseLimit(
      req.query.limit as string | undefined,
      HealthController.MEMORY_LIMIT_DEFAULT,
      HealthController.MEMORY_LIMIT_MAX
    );

    try {
      const samples = await DAC.db.getRecentMemorySamples(limit);
      res.status(200).json({
        name: 'MemorySamplesRetrieved',
        message: `Found ${samples.length} memory samples`,
        payload: samples
      });
    } catch (error: unknown) {
      this.handleError(error, res);
    }
  }

  // GET /transit/memory/summary?limit=720
  private async getMemorySummary(req: Request, res: Response): Promise<void> {
    const limit = parseLimit(
      req.query.limit as string | undefined,
      HealthController.MEMORY_SUMMARY_LIMIT_DEFAULT,
      HealthController.MEMORY_SUMMARY_LIMIT_MAX
    );

    try {
      const samplesDesc = await DAC.db.getRecentMemorySamples(limit);
      const samples = [...samplesDesc].reverse();

      if (samples.length === 0) {
        res.status(200).json({
          name: 'MemorySummaryRetrieved',
          message: 'No memory samples available yet',
          payload: {
            sampleCount: 0,
            likelyCause: 'No data yet',
            recommendation:
              'Wait for at least a few monitor samples, then re-check this endpoint.'
          }
        });
        return;
      }

      const oldest = samples[0];
      const latest = samples[samples.length - 1];
      const maxRssSample = samples.reduce((max, s) =>
        s.rssMb > max.rssMb ? s : max
      );
      const maxHeapSample = samples.reduce((max, s) =>
        s.heapUsedMb > max.heapUsedMb ? s : max
      );

      const rssAvgMb =
        Math.round(
          (samples.reduce((sum, s) => sum + s.rssMb, 0) / samples.length) * 10
        ) / 10;

      const warningCount = samples.filter((s) => s.warning).length;
      const criticalCount = samples.filter((s) => s.critical).length;

      const reasonStats = new Map<
        string,
        { count: number; maxRssMb: number }
      >();
      for (const sample of samples) {
        const existing = reasonStats.get(sample.reason);
        if (!existing) {
          reasonStats.set(sample.reason, { count: 1, maxRssMb: sample.rssMb });
        } else {
          existing.count += 1;
          if (sample.rssMb > existing.maxRssMb) {
            existing.maxRssMb = sample.rssMb;
          }
        }
      }

      const reasonsByPeak = [...reasonStats.entries()]
        .map(([reason, stats]) => ({ reason, ...stats }))
        .sort((a, b) => b.maxRssMb - a.maxRssMb)
        .slice(0, 5);

      const oldestMs = new Date(oldest.timestamp).getTime();
      const latestMs = new Date(latest.timestamp).getTime();
      const minutes = Math.max((latestMs - oldestMs) / 60000, 0.001);
      const rssSlopeMbPerMin =
        Math.round(((latest.rssMb - oldest.rssMb) / minutes) * 10) / 10;

      const likelyCause =
        maxRssSample.reason === 'transit.refreshAllCaches.complete' ||
        maxRssSample.reason === 'gtfs.load.complete'
          ? 'GTFS static feed load/refresh is the dominant memory spike phase.'
          : maxRssSample.reason === 'interval'
            ? 'Steady-state growth indicates retained runtime memory under load.'
            : `Peak usage aligns with phase: ${maxRssSample.reason}`;

      const recommendation =
        maxRssSample.rssMb >= 460
          ? 'Reduce startup and refresh peak memory (e.g., lower heap cap, split/cache refresh work, and verify poller overlap guards).'
          : 'Monitor trend slope and critical counts; overflow may be tied to short-lived spikes during refresh windows.';

      res.status(200).json({
        name: 'MemorySummaryRetrieved',
        message: `Analyzed ${samples.length} memory samples`,
        payload: {
          sampleCount: samples.length,
          timeRange: {
            from: oldest.timestamp,
            to: latest.timestamp
          },
          rss: {
            latestMb: latest.rssMb,
            avgMb: rssAvgMb,
            maxMb: maxRssSample.rssMb,
            maxAt: maxRssSample.timestamp,
            maxReason: maxRssSample.reason,
            slopeMbPerMin: rssSlopeMbPerMin
          },
          heap: {
            latestUsedMb: latest.heapUsedMb,
            maxUsedMb: maxHeapSample.heapUsedMb,
            maxAt: maxHeapSample.timestamp,
            maxReason: maxHeapSample.reason
          },
          flags: {
            warningCount,
            criticalCount
          },
          likelyCause,
          recommendation,
          topReasonsByPeakRss: reasonsByPeak
        }
      });
    } catch (error: unknown) {
      this.handleError(error, res);
    }
  }

  // GET /transit/memory/dashboard
  private getMemoryDashboard(_req: Request, res: Response): void {
    // This diagnostics page uses inline styles/scripts; set an explicit CSP so
    // hosted proxy defaults do not accidentally block rendering logic.
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:;"
    );
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).contentType('text/html').send(memoryDashboardHtml);
  }

  private handleError(error: unknown, res: Response): void {
    console.error(
      `[Health Controller ${new Date().toISOString()}] Error:`,
      error
    );
    if (error instanceof Error) {
      console.error(
        `[Health Controller ${new Date().toISOString()}] Unexpected Error:`,
        error.message,
        error.stack
      );
    }
    this.handleAppError(
      res,
      error,
      error instanceof Error ? error.message : 'An unexpected error occurred'
    );
  }
}

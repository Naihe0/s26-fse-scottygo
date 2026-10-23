// Samples process memory, logs notable changes, persists samples once the
// database is connected, and summarizes persisted history for diagnostics.

import DAC, { IMemorySampleRecord } from '../db/dac';
import { createLogger, errorMessage } from '../logger';

const log = createLogger('MemoryMonitor');

interface IMemorySample {
  timestamp: string;
  rssMb: number;
  heapUsedMb: number;
  heapTotalMb: number;
  externalMb: number;
  arrayBuffersMb: number;
  uptimeSec: number;
}

interface IMemorySummary {
  latest: IMemorySample;
  peakRssMb: number;
  peakHeapUsedMb: number;
  recentSamples: IMemorySample[];
  rssDelta5mMb: number | null;
  heapUsedDelta5mMb: number | null;
  rssSlopeMbPerMin: number | null;
  heapUsedSlopeMbPerMin: number | null;
  warning: boolean;
  critical: boolean;
}

const DEFAULT_SAMPLE_INTERVAL_MS = 5_000;
const DEFAULT_HISTORY_SIZE = 60;
const TREND_WINDOW_MS = 5 * 60 * 1000;
const CONSOLE_LOG_INTERVAL_MS = 30_000;
const WARNING_RSS_MB = 420;
const CRITICAL_RSS_MB = 460;

function roundOneDecimal(value: number): number {
  return Math.round(value * 10) / 10;
}

function toMb(bytes: number): number {
  return roundOneDecimal(bytes / 1048576);
}

function createSample(): IMemorySample {
  const mem = process.memoryUsage();
  return {
    timestamp: new Date().toISOString(),
    rssMb: toMb(mem.rss),
    heapUsedMb: toMb(mem.heapUsed),
    heapTotalMb: toMb(mem.heapTotal),
    externalMb: toMb(mem.external),
    arrayBuffersMb: toMb(mem.arrayBuffers),
    uptimeSec: Math.round(process.uptime())
  };
}

class MemoryMonitorService {
  private intervalId: ReturnType<typeof setInterval> | null = null;

  private latestSample: IMemorySample = createSample();

  private peakRssMb = this.latestSample.rssMb;

  private peakHeapUsedMb = this.latestSample.heapUsedMb;

  private readonly maxHistorySize = DEFAULT_HISTORY_SIZE;

  private sampleHistory: IMemorySample[] = [this.latestSample];

  private persistenceEnabled = false;

  private lastConsoleLogAtMs = 0;

  private lastWarningState = false;

  private lastCriticalState = false;

  start(intervalMs: number = DEFAULT_SAMPLE_INTERVAL_MS): void {
    if (this.intervalId) {
      return;
    }

    this.capture('startup');

    this.intervalId = setInterval(() => {
      this.capture('interval');
    }, intervalMs);
  }

  enablePersistence(): void {
    this.persistenceEnabled = true;
  }

  stop(): void {
    if (!this.intervalId) {
      return;
    }
    clearInterval(this.intervalId);
    this.intervalId = null;
  }

  capture(reason: string): IMemorySample {
    const sample = createSample();
    this.latestSample = sample;
    this.sampleHistory.push(sample);
    if (this.sampleHistory.length > this.maxHistorySize) {
      this.sampleHistory.splice(
        0,
        this.sampleHistory.length - this.maxHistorySize
      );
    }

    if (sample.rssMb > this.peakRssMb) {
      this.peakRssMb = sample.rssMb;
    }
    if (sample.heapUsedMb > this.peakHeapUsedMb) {
      this.peakHeapUsedMb = sample.heapUsedMb;
    }

    const summary = this.getSummary();
    this.logSummaryIfNeeded(reason, summary);
    this.persistSample(reason, summary).catch((err) => {
      log.warn(`Failed to persist sample: ${errorMessage(err)}`);
    });

    return sample;
  }

  getSummary(): IMemorySummary {
    const latest = this.latestSample;
    const trend = this.getTrendWindowMetrics();
    return {
      latest,
      peakRssMb: this.peakRssMb,
      peakHeapUsedMb: this.peakHeapUsedMb,
      recentSamples: [...this.sampleHistory],
      rssDelta5mMb: trend.rssDeltaMb,
      heapUsedDelta5mMb: trend.heapUsedDeltaMb,
      rssSlopeMbPerMin: trend.rssSlopeMbPerMin,
      heapUsedSlopeMbPerMin: trend.heapUsedSlopeMbPerMin,
      warning: latest.rssMb >= WARNING_RSS_MB,
      critical: latest.rssMb >= CRITICAL_RSS_MB
    };
  }

  private getTrendWindowMetrics(): {
    rssDeltaMb: number | null;
    heapUsedDeltaMb: number | null;
    rssSlopeMbPerMin: number | null;
    heapUsedSlopeMbPerMin: number | null;
  } {
    if (this.sampleHistory.length < 2) {
      return {
        rssDeltaMb: null,
        heapUsedDeltaMb: null,
        rssSlopeMbPerMin: null,
        heapUsedSlopeMbPerMin: null
      };
    }

    const latest = this.latestSample;
    const latestTimeMs = Date.parse(latest.timestamp);
    const thresholdMs = latestTimeMs - TREND_WINDOW_MS;

    let baseline = this.sampleHistory[0];
    for (const sample of this.sampleHistory) {
      if (Date.parse(sample.timestamp) >= thresholdMs) {
        baseline = sample;
        break;
      }
    }

    const baselineTimeMs = Date.parse(baseline.timestamp);
    const deltaMin = (latestTimeMs - baselineTimeMs) / 60000;
    if (deltaMin <= 0) {
      return {
        rssDeltaMb: null,
        heapUsedDeltaMb: null,
        rssSlopeMbPerMin: null,
        heapUsedSlopeMbPerMin: null
      };
    }

    const rssDeltaMb = roundOneDecimal(latest.rssMb - baseline.rssMb);
    const heapUsedDeltaMb = roundOneDecimal(
      latest.heapUsedMb - baseline.heapUsedMb
    );

    return {
      rssDeltaMb,
      heapUsedDeltaMb,
      rssSlopeMbPerMin: roundOneDecimal(rssDeltaMb / deltaMin),
      heapUsedSlopeMbPerMin: roundOneDecimal(heapUsedDeltaMb / deltaMin)
    };
  }

  private logSummaryIfNeeded(reason: string, summary: IMemorySummary): void {
    const nowMs = Date.now();
    const warningChanged = summary.warning !== this.lastWarningState;
    const criticalChanged = summary.critical !== this.lastCriticalState;
    const shouldLog =
      reason !== 'interval' ||
      warningChanged ||
      criticalChanged ||
      nowMs - this.lastConsoleLogAtMs >= CONSOLE_LOG_INTERVAL_MS;

    if (!shouldLog) {
      return;
    }

    const logPayload = {
      event: 'memory.sample',
      reason,
      latest: summary.latest,
      peakRssMb: summary.peakRssMb,
      peakHeapUsedMb: summary.peakHeapUsedMb,
      warning: summary.warning,
      critical: summary.critical,
      rssDelta5mMb: summary.rssDelta5mMb,
      heapUsedDelta5mMb: summary.heapUsedDelta5mMb,
      rssSlopeMbPerMin: summary.rssSlopeMbPerMin,
      heapUsedSlopeMbPerMin: summary.heapUsedSlopeMbPerMin
    };
    log.info(JSON.stringify(logPayload));

    this.lastConsoleLogAtMs = nowMs;
    this.lastWarningState = summary.warning;
    this.lastCriticalState = summary.critical;
  }

  private async persistSample(
    reason: string,
    summary: IMemorySummary
  ): Promise<void> {
    if (!this.persistenceEnabled) {
      return;
    }

    const sample = summary.latest;
    const record: IMemorySampleRecord = {
      timestamp: new Date(sample.timestamp),
      reason,
      rssMb: sample.rssMb,
      heapUsedMb: sample.heapUsedMb,
      heapTotalMb: sample.heapTotalMb,
      externalMb: sample.externalMb,
      arrayBuffersMb: sample.arrayBuffersMb,
      uptimeSec: sample.uptimeSec,
      peakRssMb: summary.peakRssMb,
      peakHeapUsedMb: summary.peakHeapUsedMb,
      warning: summary.warning,
      critical: summary.critical
    };

    await DAC.db.saveMemorySample(record);
  }
}

function maxBy<T>(items: T[], value: (item: T) => number): T {
  return items.reduce((max, item) => (value(item) > value(max) ? item : max));
}

/** Peak RSS and sample count for each capture reason, highest peaks first. */
function topReasonsByPeakRss(samples: IMemorySampleRecord[], limit: number) {
  const stats = new Map<string, { count: number; maxRssMb: number }>();
  for (const sample of samples) {
    const entry = stats.get(sample.reason) ?? { count: 0, maxRssMb: 0 };
    entry.count += 1;
    entry.maxRssMb = Math.max(entry.maxRssMb, sample.rssMb);
    stats.set(sample.reason, entry);
  }
  return [...stats.entries()]
    .map(([reason, entry]) => ({ reason, ...entry }))
    .sort((a, b) => b.maxRssMb - a.maxRssMb)
    .slice(0, limit);
}

function likelyCause(peakReason: string): string {
  if (
    peakReason === 'transit.refreshAllCaches.complete' ||
    peakReason === 'gtfs.load.complete'
  )
    return 'GTFS static feed load/refresh is the dominant memory spike phase.';
  if (peakReason === 'interval')
    return 'Steady-state growth indicates retained runtime memory under load.';
  return `Peak usage aligns with phase: ${peakReason}`;
}

/** Diagnostic summary of persisted samples, given oldest first. */
export function summarizeMemorySamples(samples: IMemorySampleRecord[]) {
  if (samples.length === 0) {
    return {
      sampleCount: 0,
      likelyCause: 'No data yet',
      recommendation:
        'Wait for at least a few monitor samples, then re-check this endpoint.'
    };
  }

  const oldest = samples[0];
  const latest = samples[samples.length - 1];
  const maxRss = maxBy(samples, (s) => s.rssMb);
  const maxHeap = maxBy(samples, (s) => s.heapUsedMb);
  const minutes = Math.max(
    (new Date(latest.timestamp).getTime() -
      new Date(oldest.timestamp).getTime()) /
      60_000,
    0.001
  );

  return {
    sampleCount: samples.length,
    timeRange: { from: oldest.timestamp, to: latest.timestamp },
    rss: {
      latestMb: latest.rssMb,
      avgMb: roundOneDecimal(
        samples.reduce((sum, s) => sum + s.rssMb, 0) / samples.length
      ),
      maxMb: maxRss.rssMb,
      maxAt: maxRss.timestamp,
      maxReason: maxRss.reason,
      slopeMbPerMin: roundOneDecimal((latest.rssMb - oldest.rssMb) / minutes)
    },
    heap: {
      latestUsedMb: latest.heapUsedMb,
      maxUsedMb: maxHeap.heapUsedMb,
      maxAt: maxHeap.timestamp,
      maxReason: maxHeap.reason
    },
    flags: {
      warningCount: samples.filter((s) => s.warning).length,
      criticalCount: samples.filter((s) => s.critical).length
    },
    likelyCause: likelyCause(maxRss.reason),
    recommendation:
      maxRss.rssMb >= CRITICAL_RSS_MB
        ? 'Reduce startup and refresh peak memory (e.g., lower heap cap, split/cache refresh work, and verify poller overlap guards).'
        : 'Monitor trend slope and critical counts; overflow may be tied to short-lived spikes during refresh windows.',
    topReasonsByPeakRss: topReasonsByPeakRss(samples, 5)
  };
}

const memoryMonitorService = new MemoryMonitorService();
export default memoryMonitorService;

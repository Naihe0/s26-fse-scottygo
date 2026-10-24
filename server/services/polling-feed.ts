// Shared lifecycle for upstream feeds that are polled into memory.
//
// Each poll runs with a deadline, never overlaps the previous poll, and
// cannot publish a response after stop() or after a newer session started.
// A tick that arrives while a poll is still running schedules one catch-up
// poll for when it finishes.

import { createLogger, errorMessage, type ILogger } from '../logger';

class FeedHttpError extends Error {
  constructor(
    status: number,
    readonly retryAt: number
  ) {
    super(`HTTP ${status}`);
  }
}

/** Retry-After may contain seconds or an HTTP date. Never retry before it. */
function retryAfterTime(value: string | null | undefined): number {
  if (!value?.trim()) return 0;
  const seconds = Number(value);
  const deadline = Number.isFinite(seconds)
    ? Date.now() + Math.max(0, seconds) * 1000
    : Date.parse(value);
  return Number.isFinite(deadline) ? deadline : 0;
}

export interface IPollingFeedOptions {
  /** Log tag, e.g. "VehiclePositions". */
  name: string;
  intervalMs: number;
  /** Deadline for one request, including reading its body. */
  timeoutMs: number;
  /** The feed is healthy only if its last success is at most this old. */
  maxAgeMs: number;
}

export abstract class PollingFeed<TSnapshot> {
  protected readonly log: ILogger;
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private activeRequest: AbortController | null = null;
  private catchUpPending = false;
  private stopped = true;
  private lastFetched: Date | null = null;
  private consecutiveFailures = 0;
  private lastError: string | null = null;
  private nextAllowedPoll = 0;

  /** Optional hook run once after the first successful poll. */
  onFirstSuccess: (() => void) | null = null;

  protected constructor(private readonly options: IPollingFeedOptions) {
    this.log = createLogger(options.name);
  }

  /** Download and decode one snapshot. Must honor the abort signal. */
  protected abstract fetchSnapshot(signal: AbortSignal): Promise<TSnapshot>;

  /** Atomically replace the in-memory data with a decoded snapshot. */
  protected abstract applySnapshot(snapshot: TSnapshot): void;

  start(): void {
    if (this.intervalId) return;
    this.stopped = false;
    this.nextAllowedPoll = 0;
    this.log.info(
      `Starting polling (every ${this.options.intervalMs / 1000}s)`
    );
    this.pollTick();
    this.intervalId = setInterval(
      () => this.pollTick(),
      this.options.intervalMs
    );
    this.intervalId.unref?.();
  }

  stop(): void {
    this.stopped = true;
    this.catchUpPending = false;
    this.activeRequest?.abort();
    this.activeRequest = null;
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      this.log.info('Polling stopped');
    }
  }

  getLastFetched(): Date | null {
    return this.lastFetched;
  }

  getConsecutiveFailures(): number {
    return this.consecutiveFailures;
  }

  /** Null when the most recent poll succeeded. */
  getLastError(): string | null {
    return this.lastError;
  }

  /** Healthy only after a recent successful poll and no failure since. */
  isHealthy(): boolean {
    return (
      this.consecutiveFailures === 0 &&
      this.lastFetched !== null &&
      Date.now() - this.lastFetched.getTime() <= this.options.maxAgeMs
    );
  }

  /** Fetch helper that rejects non-2xx responses and releases their body. */
  protected async fetchOk(
    url: string,
    signal: AbortSignal,
    init: RequestInit = {}
  ): Promise<Response> {
    const response = await fetch(url, { ...init, signal });
    if (!response.ok) {
      await response.body?.cancel();
      throw new FeedHttpError(
        response.status,
        retryAfterTime(response.headers?.get('Retry-After'))
      );
    }
    return response;
  }

  private pollTick(): void {
    if (this.stopped) return;
    if (Date.now() < this.nextAllowedPoll) return;
    if (this.activeRequest) {
      this.catchUpPending = true;
      this.log.warn('Skipping poll tick: previous fetch still in progress');
      return;
    }
    void this.poll();
  }

  private async poll(): Promise<void> {
    const startedAt = Date.now();
    const request = new AbortController();
    this.activeRequest = request;
    const deadline = setTimeout(() => request.abort(), this.options.timeoutMs);
    // A stopped or restarted session must not publish this request's outcome.
    const isCurrent = () => this.activeRequest === request && !this.stopped;
    try {
      const snapshot = await this.fetchSnapshot(request.signal);
      if (!isCurrent()) return;
      this.applySnapshot(snapshot);
      const isFirstSuccess = this.lastFetched === null;
      this.lastFetched = new Date();
      this.consecutiveFailures = 0;
      this.lastError = null;
      this.nextAllowedPoll = 0;
      if (isFirstSuccess) this.runFirstSuccessHook();
    } catch (error) {
      if (!isCurrent()) return;
      this.consecutiveFailures++;
      // The first failure gets one normal retry; repeated failures back off up
      // to five minutes. Respect a longer delay explicitly requested upstream.
      const delay = Math.min(
        5 * 60_000,
        this.options.intervalMs * 2 ** Math.min(this.consecutiveFailures - 1, 8)
      );
      this.nextAllowedPoll = Math.max(
        startedAt + delay,
        error instanceof FeedHttpError ? error.retryAt : 0
      );
      this.lastError = request.signal.aborted
        ? `Feed request timed out (>${this.options.timeoutMs / 1000} s)`
        : errorMessage(error);
      this.log.error(
        `Fetch failed (failures: ${this.consecutiveFailures}):`,
        this.lastError
      );
    } finally {
      clearTimeout(deadline);
      if (this.activeRequest === request) {
        this.activeRequest = null;
        if (this.catchUpPending && !this.stopped) {
          this.catchUpPending = false;
          this.pollTick();
        }
      }
    }
  }

  private runFirstSuccessHook(): void {
    try {
      this.onFirstSuccess?.();
    } catch (error) {
      this.log.error('onFirstSuccess callback failed:', error);
    }
  }
}

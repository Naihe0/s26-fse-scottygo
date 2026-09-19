export type LocationFailure =
  | 'denied'
  | 'unavailable'
  | 'timeout'
  | 'unsupported';

interface LocationCallbacks {
  onPosition: (position: GeolocationPosition) => void;
  onError: (kind: LocationFailure) => void;
}

interface WatchAttempt {
  active: boolean;
  watchId?: number;
  reportedFailures: Set<LocationFailure>;
}

/** Owns one location attempt; callers own permission messaging and page lifecycle. */
export class GeolocationController {
  private attempt: WatchAttempt | null = null;

  constructor(
    private readonly callbacks: LocationCallbacks,
    private readonly geolocation:
      | Geolocation
      | undefined = navigator.geolocation
  ) {}

  /** Repeated starts do not open another watch, including after a terminal error. */
  start(): void {
    if (this.attempt) return;
    const attempt: WatchAttempt = {
      active: true,
      reportedFailures: new Set()
    };
    this.attempt = attempt;

    if (!this.geolocation) {
      this.fail(attempt, 'unsupported', true);
      return;
    }

    try {
      const id = this.geolocation.watchPosition(
        (position) => {
          if (!this.isCurrent(attempt)) return;
          attempt.reportedFailures.clear();
          this.callbacks.onPosition(position);
        },
        (error) => {
          if (!this.isCurrent(attempt)) return;
          const kind = this.failureKind(error.code);
          this.fail(attempt, kind, kind === 'denied');
        },
        { enableHighAccuracy: true, maximumAge: 5_000, timeout: 20_000 }
      );
      attempt.watchId = id;
      // A synchronous callback may deny, stop, or retry before an ID is returned.
      if (!this.isCurrent(attempt)) this.clearWatch(attempt);
    } catch {
      if (this.isCurrent(attempt)) this.fail(attempt, 'unavailable', true);
    }
  }

  retry(): void {
    this.stop();
    this.start();
  }

  stop(): void {
    const attempt = this.attempt;
    this.attempt = null;
    if (!attempt) return;
    attempt.active = false;
    this.clearWatch(attempt);
  }

  private isCurrent(attempt: WatchAttempt): boolean {
    return this.attempt === attempt && attempt.active;
  }

  private failureKind(code: number): LocationFailure {
    if (code === 1) return 'denied';
    if (code === 3) return 'timeout';
    return 'unavailable';
  }

  private fail(
    attempt: WatchAttempt,
    kind: LocationFailure,
    terminal: boolean
  ): void {
    if (terminal) {
      attempt.active = false;
      this.clearWatch(attempt);
    }
    if (attempt.reportedFailures.has(kind)) return;
    attempt.reportedFailures.add(kind);
    this.callbacks.onError(kind);
  }

  private clearWatch(attempt: WatchAttempt): void {
    const id = attempt.watchId;
    attempt.watchId = undefined;
    if (id === undefined) return;
    try {
      this.geolocation?.clearWatch(id);
    } catch {
      // The attempt is already invalidated, so even late callbacks are ignored.
    }
  }
}

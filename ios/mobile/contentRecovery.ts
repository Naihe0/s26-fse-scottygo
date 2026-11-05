/** WebKit can discard a background tab under memory pressure. Restore on
 * foreground, allowing at most one automatic attempt per minute. */
export class ContentRecovery {
  private pending = false;
  private lastAttempt = -Infinity;

  terminated(active: boolean, now: number) {
    this.pending = true;
    return active ? this.resume(now) : 'wait';
  }

  resume(now: number): 'wait' | 'restore' | 'offer-retry' {
    if (!this.pending) return 'wait';
    this.pending = false;
    if (now - this.lastAttempt < 60_000) return 'offer-retry';
    this.lastAttempt = now;
    return 'restore';
  }
}

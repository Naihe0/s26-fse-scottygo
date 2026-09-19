export type TrackingState =
  | 'loading'
  | 'live'
  | 'empty'
  | 'delayed'
  | 'unavailable'
  | 'partial'
  | 'paused';

/** Persistent, quiet feedback for the currently tracked route(s). */
export class LiveTrackingStatus {
  private element: HTMLElement | null = null;

  show(state: TrackingState, message: string): void {
    if (!this.element?.isConnected) {
      const container = document.querySelector('.map-container');
      if (!container) return;
      this.element = document.createElement('div');
      this.element.className = 'live-tracking-status';
      this.element.setAttribute('role', 'status');
      this.element.setAttribute('aria-live', 'polite');
      this.element.setAttribute('aria-atomic', 'true');
      container.appendChild(this.element);
    }
    this.element.hidden = false;
    this.element.dataset.state = state;
    // Avoid repeatedly announcing an unchanged result on every poll.
    if (this.element.textContent !== message)
      this.element.textContent = message;
  }

  hide(): void {
    if (!this.element) return;
    this.element.hidden = true;
    this.element.textContent = '';
  }
}

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
  private element: HTMLDetailsElement | null = null;

  private conciseLabel(state: TrackingState, message: string): string {
    const labels: Record<TrackingState, string> = {
      loading: 'Finding buses',
      live: 'Buses tracked',
      empty: 'No active buses',
      delayed: 'Location updates delayed',
      unavailable: 'Tracking unavailable',
      partial: 'Some updates delayed',
      paused: 'Tracking paused'
    };
    if (state === 'live') {
      const count = message.match(/^(\d+ buses? tracked)/);
      if (count) return count[1];
    }
    return labels[state];
  }

  show(state: TrackingState, message: string): void {
    if (!this.element?.isConnected) {
      const container = document.querySelector('.map-container');
      if (!container) return;
      this.element = document.createElement('details');
      this.element.className = 'live-tracking-status';
      const summary = document.createElement('summary');
      summary.className = 'live-tracking-status__summary';
      summary.title = 'Tracking details';
      const label = document.createElement('span');
      label.className = 'live-tracking-status__label';
      label.setAttribute('role', 'status');
      label.setAttribute('aria-live', 'polite');
      label.setAttribute('aria-atomic', 'true');
      summary.append(label);
      const description = document.createElement('p');
      description.className = 'live-tracking-status__message';
      this.element.append(summary, description);
      this.element.addEventListener('keydown', (event) => {
        if (event.key !== 'Escape' || !this.element?.open) return;
        event.preventDefault();
        this.element.open = false;
        summary.focus();
      });
      container.appendChild(this.element);
    }
    this.element.hidden = false;
    this.element.dataset.state = state;
    const label = this.element.querySelector('.live-tracking-status__label')!;
    const description = this.element.querySelector(
      '.live-tracking-status__message'
    )!;
    const concise = this.conciseLabel(state, message);
    // Preserve an open disclosure and avoid repeat announcements on every poll.
    if (label.textContent !== concise) label.textContent = concise;
    if (description.textContent !== message) description.textContent = message;
  }

  hide(): void {
    if (!this.element) return;
    this.element.hidden = true;
    this.element.open = false;
  }
}

/**
 * Route Bell Component
 * A subscribe/unsubscribe toggle shown when a route is selected on the map.
 */

export interface IRouteBellElement extends HTMLElement {
  showBell(routeId: string, isSubscribed: boolean): void;
  hideBell(): void;
}

export class RouteBell extends HTMLElement implements IRouteBellElement {
  private currentRouteId: string | null = null;
  private subscribed = false;

  connectedCallback(): void {
    this.classList.add('is-disabled');
    this.innerHTML = `
      <button class="circle-btn bell-btn" id="bell-btn" title="Subscribe to route" aria-label="Subscribe to route" aria-pressed="false" disabled>
        <span class="material-icons-outlined">notifications_none</span>
      </button>
    `;

    this.querySelector('#bell-btn')?.addEventListener('click', () => {
      if (!this.currentRouteId) return;
      this.subscribed = !this.subscribed;
      this.updateIcon();
      this.dispatchEvent(
        new CustomEvent(this.subscribed ? 'bellSubscribe' : 'bellUnsubscribe', {
          detail: { routeId: this.currentRouteId },
          bubbles: true
        })
      );
    });
  }

  showBell(routeId: string, isSubscribed: boolean): void {
    this.currentRouteId = routeId;
    this.subscribed = isSubscribed;
    this.classList.remove('is-disabled');
    this.updateIcon();
  }

  hideBell(): void {
    this.currentRouteId = null;
    this.subscribed = false;
    this.classList.add('is-disabled');
    this.updateIcon();
  }

  private updateIcon(): void {
    const btn = this.querySelector('#bell-btn');
    const icon = btn?.querySelector('.material-icons-outlined');
    if (!btn || !icon) return;
    (btn as HTMLButtonElement).disabled = !this.currentRouteId;
    btn.setAttribute('aria-pressed', String(this.subscribed));
    btn.setAttribute(
      'aria-label',
      this.subscribed ? 'Unsubscribe from route' : 'Subscribe to route'
    );
    icon.textContent = this.subscribed ? 'notifications' : 'notifications_none';
    btn.classList.toggle('bell-subscribed', this.subscribed);
    btn.setAttribute(
      'title',
      this.subscribed ? 'Unsubscribe from route' : 'Subscribe to route'
    );
  }
}

customElements.define('route-bell', RouteBell);

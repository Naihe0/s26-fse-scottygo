/**
 * App Header Component
 * Renders the top navigation bar with optional back button and hamburger menu.
 *
 * Attributes:
 *   back  - Return to the previous ScottyGo page or offer a link to the map.
 */
import { getSessionUserId, getToken, signOut } from '../services/session';
import { sanitizeMapViewHash } from '../utils/map-auth-return';

function mapStorageKey(): string | null {
  const user = getSessionUserId(getToken());
  return user ? `scottygo:last-map:${user}` : null;
}

function lastMapPath(): string {
  try {
    const key = mapStorageKey();
    const hash = key && sanitizeMapViewHash(sessionStorage.getItem(key) || '');
    return hash ? `/${hash}` : '/';
  } catch {
    return '/';
  }
}

function hasPreviousAppPage(): boolean {
  if (!document.referrer || window.history.length < 2) return false;
  const previous = new URL(document.referrer);
  return (
    previous.origin === window.location.origin &&
    /^\/(?:map|subscriptions|notifications|account)?\/?$/.test(
      previous.pathname
    )
  );
}

export class AppHeader extends HTMLElement {
  private menuOpen = false;
  private mapOwnerKey: string | null = null;
  // Capture at departure. The map updates its hash with replaceState as the
  // rider changes filters, so reading it only on initial render loses edits.
  private readonly rememberMap = (): void => {
    if (!this.mapOwnerKey) return;
    try {
      const key = mapStorageKey();
      if (!key || key !== this.mapOwnerKey) return;
      const hash = sanitizeMapViewHash(window.location.hash);
      if (hash && hash !== '#/map') sessionStorage.setItem(key, hash);
      else sessionStorage.removeItem(key);
    } catch {
      // Storage may be disabled. Ordinary links still work.
    }
  };

  private readonly refreshMapLinks = (): void => {
    const href = lastMapPath();
    this.querySelectorAll<HTMLAnchorElement>('[data-map-return]').forEach(
      (link) => {
        link.setAttribute('href', href);
      }
    );
  };

  private readonly onOutsideClick = (event: MouseEvent): void => {
    if (!this.contains(event.target as Node)) this.setMenuOpen(false);
  };

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape' && this.menuOpen) {
      event.preventDefault();
      this.setMenuOpen(false, true);
    }
  };

  private readonly onFocusOut = (event: FocusEvent): void => {
    if (
      event.relatedTarget instanceof Node &&
      !this.contains(event.relatedTarget)
    ) {
      this.setMenuOpen(false);
    }
  };

  private setMenuOpen(open: boolean, restoreFocus = false): void {
    const button = this.querySelector<HTMLButtonElement>('#menu-icon');
    const menu = this.querySelector<HTMLElement>('#dropdown-menu');
    const focusWasInside = menu?.contains(document.activeElement);
    this.menuOpen = open;
    if (open) this.rememberMap();
    button?.classList.toggle('is-active', open);
    button?.setAttribute('aria-expanded', String(open));
    button?.setAttribute(
      'aria-label',
      `${open ? 'Close' : 'Open'} navigation menu`
    );
    menu?.classList.toggle('is-active', open);
    menu?.toggleAttribute('inert', !open);
    if (!open && (restoreFocus || focusWasInside)) button?.focus();
  }

  disconnectedCallback(): void {
    this.mapOwnerKey = null;
    window.removeEventListener('pagehide', this.rememberMap);
    window.removeEventListener('pageshow', this.refreshMapLinks);
    document.removeEventListener('click', this.onOutsideClick);
    this.removeEventListener('keydown', this.onKeyDown);
    this.removeEventListener('focusout', this.onFocusOut);
  }

  connectedCallback(): void {
    this.classList.add('app-header');
    this.setAttribute('role', 'banner');
    this.menuOpen = false;

    const page = window.location.pathname.replace(/\/$/, '') || '/';
    const pageLabels: Record<string, string> = {
      '/': 'Map',
      '/map': 'Map',
      '/subscriptions': 'Saved routes',
      '/notifications': 'Alerts',
      '/account': 'Account',
      '/auth': 'Sign in'
    };
    const pageLabel = pageLabels[page] || 'Map';
    const current = (path: string): string =>
      page === path || (path === '/' && page === '/map')
        ? ' aria-current="page"'
        : '';
    const signedIn = Boolean(getToken());
    const showBack = this.hasAttribute('back') && (page !== '/auth' || signedIn);
    const onMap = page === '/' || page === '/map';
    const backArrow = `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M20 11H7.83L13.42 5.41L12 4L4 12L12 20L13.41 18.59L7.83 13H20V11Z" fill="currentColor"/>
    </svg>`;
    let backButton = '';
    if (showBack && hasPreviousAppPage()) {
      backButton = `<button type="button" class="back-icon" id="back-icon" aria-label="Go back">${backArrow}</button>`;
    } else if (showBack) {
      backButton = `<a href="/" data-map-return class="back-icon" aria-label="Return to map">${backArrow}</a>`;
    }

    this.innerHTML = `
      ${backButton}
      <a href="/" data-map-return class="app-brand" aria-label="ScottyGo map">
        <svg class="app-brand-mark" width="26" height="26" viewBox="0 0 26 26" fill="none" aria-hidden="true">
          <path d="M6 20V9a5 5 0 0 1 5-5h9M6 14h9a5 5 0 0 0 5-5V4" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/>
          <circle cx="6" cy="20" r="3" fill="currentColor"/>
          <circle cx="20" cy="4" r="3" fill="currentColor"/>
        </svg>
        <span>ScottyGo</span>
      </a>
      <span class="app-page-context">${pageLabel}</span>
      <button type="button" class="menu-icon" id="menu-icon" aria-label="Open navigation menu" aria-expanded="false" aria-controls="dropdown-menu">
        <span aria-hidden="true"></span>
        <span aria-hidden="true"></span>
        <span aria-hidden="true"></span>
      </button>
      <nav class="dropdown-menu" id="dropdown-menu" aria-label="Main navigation" inert>
        <div class="dropdown-header">
          <h2>Navigation</h2>
        </div>
        <div class="dropdown-grid">
          <a href="/" data-map-return class="dropdown-item"${current('/')}>
            <div class="icon-circle">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="m3 6 6-3 6 3 6-3v15l-6 3-6-3-6 3V6zM9 3v15M15 6v15"/>
              </svg>
            </div>
            <span>Map</span>
          </a>
          <a href="/subscriptions" class="dropdown-item"${current('/subscriptions')}>
            <div class="icon-circle">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"></path>
              </svg>
            </div>
            <span>Saved routes</span>
          </a>
          <a href="/notifications" class="dropdown-item"${current('/notifications')}>
            <div class="icon-circle">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"></path>
                <path d="M13.73 21a2 2 0 0 1-3.46 0"></path>
              </svg>
            </div>
            <span>Alerts</span>
          </a>
          <a href="/account" class="dropdown-item"${current('/account')}>
            <div class="icon-circle">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path>
                <circle cx="12" cy="7" r="4"></circle>
              </svg>
            </div>
            <span>Account</span>
          </a>
        </div>
          <a href="/auth" class="dropdown-session"${signedIn ? ' id="menu-logout-btn"' : current('/auth')}>
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"></path>
                <polyline points="16 17 21 12 16 7"></polyline>
                <line x1="21" y1="12" x2="9" y2="12"></line>
              </svg>
            <span>${signedIn ? 'Log out' : 'Sign in'}</span>
          </a>
      </nav>
    `;

    const menuIcon = this.querySelector<HTMLElement>('#menu-icon');
    const backIcon = this.querySelector<HTMLElement>('#back-icon');
    const logoutBtn = this.querySelector<HTMLElement>('#menu-logout-btn');

    menuIcon?.addEventListener('click', () => {
      this.setMenuOpen(menuIcon.getAttribute('aria-expanded') !== 'true');
    });

    this.querySelectorAll('svg').forEach((icon) => {
      icon.setAttribute('aria-hidden', 'true');
    });
    this.addEventListener('keydown', this.onKeyDown);
    this.addEventListener('focusout', this.onFocusOut);
    document.addEventListener('click', this.onOutsideClick);
    if (onMap) {
      this.mapOwnerKey = mapStorageKey();
      window.addEventListener('pagehide', this.rememberMap);
    } else {
      this.refreshMapLinks();
      window.addEventListener('pageshow', this.refreshMapLinks);
    }

    backIcon?.addEventListener('click', (e) => {
      e.preventDefault();
      history.back();
    });

    logoutBtn?.addEventListener('click', (event) => {
      event.preventDefault();
      signOut();
    });
  }
}

customElements.define('app-header', AppHeader);

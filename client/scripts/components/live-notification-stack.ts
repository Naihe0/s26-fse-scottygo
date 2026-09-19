import type { INotification } from '../../../common/transit.interface';
import {
  appendLinkedText,
  formatNotificationTime,
  notificationTopics,
  routeMapUrl
} from '../utils/alert-content';

const READING_TIME_MS = 30_000;
const MAX_CARDS = 3;
const MAX_REMEMBERED = 200;

interface PopupEntry {
  card: HTMLElement;
  remaining: number;
  startedAt: number;
  timer?: ReturnType<typeof setTimeout>;
  hovered: boolean;
  focused: boolean;
  createdAt: string;
}

/** Owns popup timers and DOM; socket/reconnection logic stays in its component. */
export class LiveNotificationStack {
  private container: HTMLElement | null = null;
  private announcer: HTMLElement | null = null;
  private entries: PopupEntry[] = [];
  private readonly seen = new Set<string>();

  constructor(
    private readonly routeTitle: (routeId: string) => string,
    private readonly formatMessage: (message: string) => string
  ) {
    document.addEventListener('visibilitychange', this.onVisibilityChange);
  }

  show(notification: INotification): void {
    const key =
      notification._id ||
      JSON.stringify([
        notification.routeId,
        notification.vid,
        notification.createdAt,
        notification.message
      ]);
    if (this.seen.has(key)) return;
    this.seen.add(key);
    if (this.seen.size > MAX_REMEMBERED)
      this.seen.delete(this.seen.values().next().value!);

    const container = this.getContainer();
    if (this.entries.length >= MAX_CARDS) {
      const oldestIdle = this.entries.find(
        (entry) => !entry.focused && !entry.hovered
      );
      // Do not pull an action out from under the rider's pointer or keyboard.
      if (!oldestIdle) {
        this.announce('More route updates are available in Alerts.');
        return;
      }
      this.remove(oldestIdle);
    }

    const title = this.routeTitle(notification.routeId);
    const message = this.formatMessage(notification.message);
    const card = this.createCard(notification, title, message);
    const entry: PopupEntry = {
      card,
      remaining: READING_TIME_MS,
      startedAt: 0,
      hovered: false,
      focused: false,
      createdAt: notification.createdAt
    };
    this.entries.push(entry);
    container.querySelector('.live-notif-items')!.append(card);
    card
      .querySelector('button')!
      .addEventListener('click', () => this.remove(entry, true));
    card.addEventListener('pointerenter', () => {
      entry.hovered = true;
      this.pause(entry);
    });
    card.addEventListener('pointerleave', () => {
      entry.hovered = false;
      this.resume(entry);
    });
    card.addEventListener('focusin', () => {
      entry.focused = true;
      this.pause(entry);
    });
    card.addEventListener('focusout', (event) => {
      if (
        event.relatedTarget instanceof Node &&
        card.contains(event.relatedTarget)
      )
        return;
      entry.focused = false;
      this.resume(entry);
    });
    this.resume(entry);
    this.announce(`${title}. Rider report. ${message.slice(0, 300)}`);
  }

  destroy(): void {
    document.removeEventListener('visibilitychange', this.onVisibilityChange);
    this.entries.forEach((entry) => clearTimeout(entry.timer));
    this.entries = [];
    this.seen.clear();
    this.container?.remove();
    this.container = null;
    this.announcer = null;
  }

  private getContainer(): HTMLElement {
    if (this.container) return this.container;
    const container = document.createElement('section');
    container.className = 'live-notif-container';
    container.setAttribute('aria-label', 'Live route updates');
    container.innerHTML =
      '<div class="live-notif-items"></div>' +
      '<a class="live-notif-all" href="/notifications?type=live">Open alert center <span aria-hidden="true">↗</span></a>' +
      '<span class="live-notif-announcer" role="status" aria-live="polite" aria-atomic="true"></span>';
    document.body.append(container);
    this.container = container;
    this.announcer = container.querySelector('.live-notif-announcer');
    return container;
  }

  private createCard(
    notification: INotification,
    title: string,
    message: string
  ): HTMLElement {
    const card = document.createElement('article');
    card.className = 'live-notif-card';
    card.setAttribute('aria-label', `${title} rider update`);
    card.innerHTML =
      '<button type="button" class="live-notif-dismiss" aria-label="Dismiss notification">×</button>' +
      '<div class="live-notif-header"><span class="live-notif-icon" aria-hidden="true">↗</span>' +
      '<span class="live-notif-title"></span></div>' +
      '<p class="live-notif-subtitle"></p><p class="live-notif-body"></p>' +
      '<div class="live-notif-footer"><span class="live-notif-tag"></span><time class="live-notif-time"></time></div>' +
      '<div class="live-notif-actions"><a class="live-notif-map">View route</a><a class="live-notif-history">Read updates</a></div>';
    card.querySelector('.live-notif-title')!.textContent = title;
    card.querySelector('.live-notif-subtitle')!.textContent = notification.vid
      ? `Bus ${notification.vid} · Rider report`
      : 'Rider report';
    appendLinkedText(
      card.querySelector<HTMLElement>('.live-notif-body')!,
      message
    );
    card.querySelector('.live-notif-tag')!.textContent =
      notificationTopics(notification.changedFields).join(' · ') ||
      'Community update';
    const time = card.querySelector('time')!;
    const date = new Date(notification.createdAt);
    if (Number.isFinite(date.getTime())) {
      time.dateTime = date.toISOString();
      time.title = date.toLocaleString();
    }
    time.textContent = formatNotificationTime(notification.createdAt);
    card.querySelector<HTMLAnchorElement>('.live-notif-map')!.href =
      routeMapUrl(notification.routeId);
    card.querySelector<HTMLAnchorElement>('.live-notif-history')!.href =
      `/notifications?${new URLSearchParams({ route: notification.routeId, type: 'live' })}`;
    return card;
  }

  private pause(entry: PopupEntry): void {
    if (entry.timer === undefined) return;
    clearTimeout(entry.timer);
    entry.timer = undefined;
    entry.remaining = Math.max(
      0,
      entry.remaining - (Date.now() - entry.startedAt)
    );
  }

  private resume(entry: PopupEntry): void {
    if (!this.entries.includes(entry)) return;
    entry.card.querySelector('time')!.textContent = formatNotificationTime(
      entry.createdAt
    );
    if (
      entry.timer !== undefined ||
      entry.focused ||
      entry.hovered ||
      document.hidden
    )
      return;
    entry.startedAt = Date.now();
    entry.timer = setTimeout(() => this.remove(entry), entry.remaining);
  }

  private remove(entry: PopupEntry, restoreFocus = false): void {
    clearTimeout(entry.timer);
    entry.timer = undefined;
    this.entries = this.entries.filter((other) => other !== entry);
    if (restoreFocus && entry.card.contains(document.activeElement)) {
      this.container
        ?.querySelector<HTMLAnchorElement>('.live-notif-all')
        ?.focus();
    }
    entry.card.remove();
    // Keep the history action while focused; otherwise an empty stack needs no space.
    if (
      !this.entries.length &&
      !this.container?.contains(document.activeElement)
    ) {
      this.container?.remove();
      this.container = null;
      this.announcer = null;
    }
  }

  private announce(message: string): void {
    if (this.announcer) this.announcer.textContent = message;
  }

  private readonly onVisibilityChange = (): void => {
    this.entries.forEach((entry) =>
      document.hidden ? this.pause(entry) : this.resume(entry)
    );
  };
}

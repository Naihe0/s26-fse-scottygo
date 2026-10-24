import type {
  INotification,
  IServiceAlert
} from '../../../common/transit.interface';
import { getToken } from '../services/session';
import { safeHttpUrl } from './alert-content';
import { notificationKey } from './notification-card';

export type InboxEntry =
  | { kind: 'service'; value: IServiceAlert }
  | { kind: 'live'; value: INotification };
export type InboxSort = 'priority' | 'newest';
export interface InboxGroup {
  key: string;
  routeIds: string[];
  entries: InboxEntry[];
}
export interface InboxShareSummary {
  title: string;
  text: string;
  url?: string;
}
interface ReadReceipt {
  key: string;
  fingerprint: string;
  readAt: number;
}

const READ_LIMIT = 500;
const READ_MAX_AGE = 45 * 24 * 60 * 60_000;
const STORAGE_PREFIX = 'scottygo:notification-inbox:v1:';

/** A compact content identity; it is never used for authentication. */
function fingerprint(text: string): string {
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let index = 0; index < text.length; index++) {
    first = Math.imul(first ^ text.charCodeAt(index), 0x01000193);
    second = Math.imul(second ^ text.charCodeAt(index), 0x85ebca6b);
  }
  return `${(first >>> 0).toString(36)}-${(second >>> 0).toString(36)}-${text.length}`;
}

export function inboxKey(entry: InboxEntry): string {
  return entry.kind === 'service'
    ? `alert:${entry.value.id || entry.value.headerText}`
    : `notification:${notificationKey(entry.value)}`;
}

export function inboxRoutes(entry: InboxEntry): string[] {
  const routes =
    entry.kind === 'service' ? entry.value.routeIds : [entry.value.routeId];
  return [
    ...new Set(
      (routes ?? []).filter((id) => typeof id === 'string' && id.trim())
    )
  ].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

export function inboxFingerprint(entry: InboxEntry): string {
  if (entry.kind === 'live') {
    const value = entry.value;
    return fingerprint(
      JSON.stringify([
        value.routeId,
        value.vid,
        value.message,
        [...(value.changedFields ?? [])].sort(),
        value.createdAt
      ])
    );
  }
  const value = entry.value;
  return fingerprint(
    JSON.stringify([
      value.headerText,
      value.descriptionText,
      inboxRoutes(entry),
      (value.activePeriods ?? [])
        .map((period) => [period.start, period.end])
        .sort(),
      value.url,
      value.effect,
      value.cause,
      value.severityLevel
    ])
  );
}

/** The immutable account ID namespaces preferences across password/session changes. */
export function inboxAccount(): string | null {
  try {
    const token = getToken();
    if (!token) return null;
    const encoded = token.split('.')[1];
    if (encoded) {
      try {
        const payload = JSON.parse(
          atob(encoded.replace(/-/g, '+').replace(/_/g, '/'))
        );
        if (
          typeof payload.userId === 'string' &&
          payload.userId.length > 0 &&
          payload.userId.length < 200
        )
          return `user:${payload.userId}`;
      } catch {
        /* Invalid/opaque sessions keep read state in memory only. */
      }
    }
    return null;
  } catch {
    return null;
  }
}

/** Read state stays in this browser, capped at 500 entries and 45 days. */
export class NotificationReadStore {
  private account: string | null | undefined;
  private anonymousSession: string | null = null;
  private records = new Map<string, ReadReceipt>();

  constructor(
    private readonly getAccount: () => string | null = inboxAccount
  ) {}

  private synchronize(): void {
    const account = this.getAccount();
    let anonymousSession: string | null = null;
    if (!account) {
      try {
        anonymousSession = getToken();
      } catch {
        /* Storage can be unavailable. */
      }
    }
    if (account === this.account && anonymousSession === this.anonymousSession)
      return;
    this.account = account;
    this.anonymousSession = anonymousSession;
    this.records.clear();
    if (!account) return;
    try {
      const stored: unknown = JSON.parse(
        localStorage.getItem(STORAGE_PREFIX + encodeURIComponent(account)) ??
          '[]'
      );
      if (!Array.isArray(stored)) return;
      const now = Date.now();
      for (const item of stored.slice(0, READ_LIMIT)) {
        if (
          !item ||
          typeof item.key !== 'string' ||
          item.key.length > 2000 ||
          typeof item.fingerprint !== 'string' ||
          item.fingerprint.length > 100 ||
          !Number.isFinite(item.readAt) ||
          item.readAt < now - READ_MAX_AGE ||
          item.readAt > now + 60_000
        )
          continue;
        this.records.set(item.key, item);
      }
    } catch {
      /* Keep the session usable when browser storage is unavailable. */
    }
  }

  reload(): void {
    this.account = undefined;
    this.synchronize();
  }

  isRead(entry: InboxEntry): boolean {
    this.synchronize();
    const receipt = this.records.get(inboxKey(entry));
    return (
      !!receipt &&
      receipt.readAt >= Date.now() - READ_MAX_AGE &&
      receipt.fingerprint === inboxFingerprint(entry)
    );
  }

  setRead(entry: InboxEntry, read: boolean): void {
    this.synchronize();
    const key = inboxKey(entry);
    if (read) {
      this.records.delete(key);
      this.records = new Map([
        [
          key,
          { key, fingerprint: inboxFingerprint(entry), readAt: Date.now() }
        ],
        ...this.records
      ]);
    } else this.records.delete(key);
    const records = [...this.records.values()]
      .filter((item) => item.readAt >= Date.now() - READ_MAX_AGE)
      .sort((a, b) => b.readAt - a.readAt)
      .slice(0, READ_LIMIT);
    this.records = new Map(records.map((item) => [item.key, item]));
    if (!this.account) return;
    try {
      localStorage.setItem(
        STORAGE_PREFIX + encodeURIComponent(this.account),
        JSON.stringify(records)
      );
    } catch {
      /* In-memory read state still works for this session. */
    }
  }
}

function entryTime(entry: InboxEntry): number {
  const dates =
    entry.kind === 'live'
      ? [entry.value.createdAt]
      : (entry.value.activePeriods ?? []).map((period) => period.start);
  return Math.max(
    0,
    ...dates.map((date) => Date.parse(date)).filter(Number.isFinite)
  );
}

function priority(entry: InboxEntry): number {
  if (entry.kind !== 'service') return 0;
  return entry.value.severityLevel
    ? ({ SEVERE: 3, WARNING: 2, INFO: 1 }[entry.value.severityLevel] ?? 0)
    : 0;
}

/** Unknown alert severity stays unranked; agency dates are alert-window starts. */
export function sortInbox(
  entries: InboxEntry[],
  order: InboxSort
): InboxEntry[] {
  return entries
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => {
      if (order === 'priority') {
        const urgency = priority(b.entry) - priority(a.entry);
        if (urgency) return urgency;
      }
      return entryTime(b.entry) - entryTime(a.entry) || a.index - b.index;
    })
    .map(({ entry }) => entry);
}

/** Shared notices form one route-combination group, never duplicate cards/counts. */
export function groupInbox(entries: InboxEntry[]): InboxGroup[] {
  const groups = new Map<string, InboxGroup>();
  for (const entry of entries) {
    const routeIds = inboxRoutes(entry);
    const key = JSON.stringify(routeIds);
    const group = groups.get(key) ?? { key, routeIds, entries: [] };
    group.entries.push(entry);
    groups.set(key, group);
  }
  return [...groups.values()];
}

export function buildInboxShare(
  entry: InboxEntry,
  routeTitle: (id: string) => string,
  origin = window.location.origin
): InboxShareSummary {
  const title =
    entry.kind === 'service'
      ? entry.value.headerText || 'Service alert'
      : `Rider update · ${routeTitle(entry.value.routeId)}`;
  const body =
    entry.kind === 'service'
      ? entry.value.descriptionText
      : entry.value.message;
  const routes = inboxRoutes(entry).map(routeTitle).join(', ');
  const text = [
    title.slice(0, 200),
    routes,
    body ? body.slice(0, 700) + (body.length > 700 ? '…' : '') : ''
  ]
    .filter(Boolean)
    .join('\n');
  const source =
    entry.kind === 'service' && entry.value.url
      ? safeHttpUrl(entry.value.url)
      : null;
  const firstRoute = inboxRoutes(entry)[0];
  const fallback = firstRoute
    ? `${origin}/notifications?${new URLSearchParams({ route: firstRoute, type: entry.kind === 'service' ? 'service' : 'live' })}`
    : `${origin}/notifications`;
  const url = source ?? safeHttpUrl(fallback) ?? undefined;
  return { title: title.slice(0, 200), text, ...(url ? { url } : {}) };
}

function manualCopy(summary: string, trigger: HTMLButtonElement): void {
  document.getElementById('notif-share-dialog')?.remove();
  const dialog = document.createElement('dialog');
  dialog.id = 'notif-share-dialog';
  dialog.className = 'notif-share-dialog';
  dialog.setAttribute('aria-labelledby', 'notif-share-title');
  dialog.innerHTML =
    '<h2 id="notif-share-title">Copy update</h2><p>Select and copy this summary to share it.</p><label for="notif-share-value">Update summary</label><textarea id="notif-share-value" readonly rows="8"></textarea><button type="button">Close</button>';
  const textarea = dialog.querySelector('textarea')!;
  textarea.value = summary;
  const close = () => {
    dialog.remove();
    if (trigger.isConnected) trigger.focus();
  };
  dialog.querySelector('button')!.addEventListener('click', close);
  dialog.addEventListener('cancel', (event) => {
    event.preventDefault();
    close();
  });
  document.body.append(dialog);
  if (typeof dialog.showModal === 'function') dialog.showModal();
  else dialog.setAttribute('open', '');
  textarea.focus();
  textarea.select();
}

/** Only a direct button action opens sharing; cancellation does not copy text. */
export async function shareInboxSummary(
  summary: InboxShareSummary,
  trigger: HTMLButtonElement,
  announce: (message: string) => void
): Promise<void> {
  if (trigger.disabled) return;
  trigger.disabled = true;
  try {
    if (navigator.share) {
      try {
        await navigator.share(summary);
        return;
      } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') return;
      }
    }
    const text = [summary.text, summary.url].filter(Boolean).join('\n');
    try {
      if (!navigator.clipboard?.writeText)
        throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(text);
      announce('Update summary copied.');
    } catch {
      if (trigger.isConnected) manualCopy(text, trigger);
      announce('Select and copy the update summary.');
    }
  } finally {
    trigger.disabled = false;
  }
}

import { getSessionUserId, getToken } from '../services/session';
import { safeHttpUrl } from './alert-content';
import { inboxKey, type InboxEntry } from './notification-inbox';

export interface SavedUpdate {
  key: string;
  entry: InboxEntry;
  savedAt: number;
  updatedAt: number;
  /** A successful feed check in this page only; absence is not expiration. */
  current: boolean | null;
}

export const SAVED_UPDATE_LIMIT = 30;
export const SAVED_UPDATES_PREFIX = 'scottygo:saved-updates:v1:';
type Records = Map<string, SavedUpdate>;
interface ScopeState {
  records: Records;
  loaded: boolean;
  dirty: boolean;
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function text(value: unknown, limit: number): string | null {
  return typeof value === 'string' && value.length <= limit ? value : null;
}

function strings(value: unknown, limit: number): string[] {
  return Array.isArray(value)
    ? [...new Set(value.slice(0, limit).filter((item): item is string =>
      typeof item === 'string' && item.length > 0 && item.length <= 512))]
    : [];
}

/** Copy only renderable fields. Browser storage is untrusted input. */
function normalizeEntry(input: unknown): InboxEntry | null {
  const entry = object(input);
  const value = object(entry?.value);
  if (!entry || !value) return null;
  if (entry.kind === 'service') {
    const id = text(value.id, 512);
    const headerText = text(value.headerText, 2000);
    const descriptionText = text(value.descriptionText, 20_000);
    if (id === null || headerText === null || descriptionText === null ||
      !(id || headerText.trim())) return null;
    const activePeriods = Array.isArray(value.activePeriods)
      ? value.activePeriods.slice(0, 50).flatMap(item => {
        const period = object(item);
        const start = text(period?.start, 100);
        const end = text(period?.end, 100);
        return start !== null && end !== null &&
          (!start || Number.isFinite(Date.parse(start))) &&
          (!end || Number.isFinite(Date.parse(end))) ? [{ start, end }] : [];
      }) : [];
    const url = typeof value.url === 'string' && value.url.length <= 4000
      ? safeHttpUrl(value.url) : null;
    const effect = text(value.effect, 100);
    const cause = text(value.cause, 100);
    const severityLevel = value.severityLevel;
    return { kind: 'service', value: {
      id, headerText, descriptionText,
      routeIds: strings(value.routeIds, 100),
      activePeriods,
      ...(Array.isArray(value.stopIds) ? { stopIds: strings(value.stopIds, 200) } : {}),
      ...(url ? { url } : {}),
      ...(effect ? { effect } : {}),
      ...(cause ? { cause } : {}),
      ...(severityLevel === 'INFO' || severityLevel === 'WARNING' || severityLevel === 'SEVERE'
        ? { severityLevel } : {})
    } };
  }
  if (entry.kind === 'live') {
    const routeId = text(value.routeId, 512);
    const vid = text(value.vid, 512);
    const message = text(value.message, 20_000);
    const reportId = text(value.reportId, 512);
    const createdAt = text(value.createdAt, 100);
    const id = value._id === undefined ? undefined : text(value._id, 512);
    if (!routeId || vid === null || !message?.trim() || reportId === null ||
      !createdAt || !Number.isFinite(Date.parse(createdAt)) || id === null || id === '') return null;
    return { kind: 'live', value: {
      ...(id ? { _id: id } : {}), routeId, vid, message, reportId, createdAt,
      changedFields: strings(value.changedFields, 30)
    } };
  }
  return null;
}

function readRecords(raw: unknown, previous: Records): Records {
  const records: Records = new Map();
  if (!Array.isArray(raw)) return records;
  for (const value of raw.slice(0, SAVED_UPDATE_LIMIT * 4)) {
    const item = object(value);
    const entry = normalizeEntry(item?.entry);
    if (!item || !entry || typeof item.savedAt !== 'number' ||
      typeof item.updatedAt !== 'number' || !Number.isFinite(item.savedAt) ||
      !Number.isFinite(item.updatedAt) || item.savedAt < 0 ||
      item.updatedAt < item.savedAt || item.updatedAt > Date.now() + 60_000) continue;
    const key = inboxKey(entry);
    if (records.has(key)) continue;
    records.set(key, {
      key, entry, savedAt: item.savedAt, updatedAt: item.updatedAt,
      current: previous.get(key)?.current ?? null
    });
    if (records.size === SAVED_UPDATE_LIMIT) break;
  }
  return records;
}

/** Account-scoped browser snapshots, retained until explicitly removed. */
export class SavedUpdateStore {
  private scopes = new Map<string, ScopeState>();
  private temporary = new Map<string | null, string>();
  private lastToken: string | null = null;
  private activeScope: string | null = null;

  private scope(): { key: string; persistent: boolean } {
    try { this.lastToken = getToken(); } catch { /* Retain this page's last known scope. */ }
    const id = getSessionUserId(this.lastToken);
    if (id) return { key: SAVED_UPDATES_PREFIX + encodeURIComponent('user:' + id), persistent: true };
    if (!this.temporary.has(this.lastToken))
      this.temporary.set(this.lastToken, 'temporary:' + this.temporary.size);
    return { key: this.temporary.get(this.lastToken)!, persistent: false };
  }

  private state(refresh = false): { key: string; persistent: boolean; state: ScopeState } {
    const scope = this.scope();
    let state = this.scopes.get(scope.key);
    if (!state) {
      state = { records: new Map(), loaded: false, dirty: false };
      this.scopes.set(scope.key, state);
    }
    if (this.activeScope !== scope.key) {
      for (const record of state.records.values()) record.current = null;
      this.activeScope = scope.key;
    }
    if (scope.persistent && !state.dirty && (!state.loaded || refresh)) {
      try {
        state.records = readRecords(JSON.parse(localStorage.getItem(scope.key) ?? '[]'), state.records);
      } catch { /* Blocked or malformed storage keeps the usable in-page snapshot. */ }
    }
    state.loaded = true;
    return { ...scope, state };
  }

  private persist(scope: ReturnType<SavedUpdateStore['state']>): void {
    if (!scope.persistent) return;
    try {
      localStorage.setItem(scope.key, JSON.stringify([...scope.state.records.values()]
        .map(({ entry, savedAt, updatedAt }) => ({ entry, savedAt, updatedAt }))));
      scope.state.dirty = false;
    } catch { scope.state.dirty = true; }
  }

  list(): SavedUpdate[] {
    return [...this.state().state.records.values()]
      .sort((a, b) => b.savedAt - a.savedAt)
      .map(record => ({ ...record, entry: normalizeEntry(record.entry)! }));
  }

  has(entry: InboxEntry): boolean {
    const clean = normalizeEntry(entry);
    return Boolean(clean && this.state().state.records.has(inboxKey(clean)));
  }

  toggle(entry: InboxEntry): { saved: boolean; ok: boolean; message: string } {
    const clean = normalizeEntry(entry);
    if (!clean) return { saved: false, ok: false, message: 'This update could not be saved.' };
    // Read other tabs' latest writes before a local mutation.
    const scope = this.state(true);
    const key = inboxKey(clean);
    const records = scope.state.records;
    const removing = records.has(key);
    if (!removing && records.size >= SAVED_UPDATE_LIMIT)
      return { saved: false, ok: false, message: 'Reading list is full. Remove an update before saving another.' };
    if (removing) records.delete(key);
    else records.set(key, { key, entry: clean, savedAt: Date.now(), updatedAt: Date.now(), current: null });
    this.persist(scope);
    return { saved: !removing, ok: true, message: removing ? 'Removed from Reading list.'
      : scope.persistent && !scope.state.dirty ? 'Saved to Reading list.' : 'Saved to Reading list for this page.' };
  }

  reload(): void { this.state(true); }

  reconcile(entries: InboxEntry[], successfulKinds: ReadonlySet<InboxEntry['kind']>): void {
    const scope = this.state(true);
    const current = new Map<string, InboxEntry>();
    for (const entry of entries) {
      const clean = normalizeEntry(entry);
      if (clean && successfulKinds.has(clean.kind)) current.set(inboxKey(clean), clean);
    }
    let changed = false;
    for (const record of scope.state.records.values()) {
      const fresh = current.get(record.key);
      record.current = successfulKinds.has(record.entry.kind) ? Boolean(fresh) : null;
      if (fresh && JSON.stringify(record.entry) !== JSON.stringify(fresh)) {
        record.entry = fresh;
        record.updatedAt = Math.max(record.savedAt, Date.now());
        changed = true;
      }
    }
    if (changed) this.persist(scope);
  }
}

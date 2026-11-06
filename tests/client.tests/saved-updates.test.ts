/** @jest-environment jsdom */
import { SavedUpdateStore, SAVED_UPDATE_LIMIT, SAVED_UPDATES_PREFIX } from '../../client/scripts/utils/saved-updates';
import { inboxKey, type InboxEntry } from '../../client/scripts/utils/notification-inbox';

const service = (id = 'detour'): InboxEntry => ({ kind: 'service', value: {
  id, headerText: 'Platform moved', descriptionText: 'Use Forbes at Morewood.',
  routeIds: ['61C'], stopIds: ['7117'], activePeriods: [], url: 'https://example.com/advisory', severityLevel: 'WARNING'
} });
const live = (id = 'report'): InboxEntry => ({ kind: 'live', value: {
  _id: id, routeId: '61C', vid: '4001', message: 'Standing room.',
  changedFields: ['crowdedness'], reportId: 'source', createdAt: '2026-11-06T06:00:00Z'
} });
const token = (id: string, suffix = 'signature') => `header.${btoa(JSON.stringify({userId:id}))}.${suffix}`;
const storageKey = (id = 'alice') => SAVED_UPDATES_PREFIX + encodeURIComponent('user:' + id);
const allKinds = new Set<InboxEntry['kind']>(['service', 'live']);

describe('account-scoped saved update snapshots', () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem('token', token('alice'));
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-11-06T06:00:00Z'));
  });
  afterEach(() => { jest.restoreAllMocks(); jest.useRealTimers(); });

  test('explicit save persists readable content without private extra fields or feed status', () => {
    const entry = service();
    Object.assign(entry.value, { userId: 'private-user', token: 'private-token' });
    const store = new SavedUpdateStore();
    expect(store.has(entry)).toBe(false);
    expect(store.toggle(entry)).toMatchObject({saved:true,ok:true});
    store.reconcile([entry], allKinds);
    expect(store.list()[0].current).toBe(true);
    const stored = localStorage.getItem(storageKey())!;
    expect(stored).not.toMatch(/private-user|private-token|current/);
    const restored = new SavedUpdateStore().list()[0];
    expect(restored).toMatchObject({key:inboxKey(entry),current:null,entry:service()});
    expect(store.toggle(entry)).toMatchObject({saved:false,ok:true});
    expect(new SavedUpdateStore().list()).toEqual([]);
    expect(jest.getTimerCount()).toBe(0);
  });

  test('latest successful content replaces snapshot, keeps savedAt, and remains after leaving the feed', () => {
    const store = new SavedUpdateStore();
    const original = service();
    store.toggle(original);
    const savedAt = store.list()[0].savedAt;
    jest.advanceTimersByTime(30_000);
    const updated = service();
    if (updated.kind === 'service') updated.value.descriptionText = 'Use the next platform.';
    store.reconcile([updated], allKinds);
    expect(store.list()[0]).toMatchObject({entry:updated,savedAt,updatedAt:Date.now(),current:true});
    jest.advanceTimersByTime(30_000);
    store.reconcile([updated], allKinds);
    expect(store.list()[0].updatedAt).toBe(savedAt + 30_000);
    store.reconcile([], allKinds);
    expect(store.list()[0]).toMatchObject({entry:updated,current:false});
    expect(new SavedUpdateStore().list()[0]).toMatchObject({entry:updated,current:null});
  });

  test('failed or partial feeds never claim saved content disappeared or overwrite its snapshot', () => {
    const store = new SavedUpdateStore();
    store.toggle(service());
    store.toggle(live());
    store.reconcile([service(),live()], allKinds);
    store.reconcile([], new Set(['service']));
    expect(store.list().find(r => r.entry.kind === 'service')?.current).toBe(false);
    expect(store.list().find(r => r.entry.kind === 'live')?.current).toBeNull();
    const altered = service();
    if (altered.kind === 'service') altered.value.descriptionText = 'Unverified replacement';
    store.reconcile([altered], new Set());
    expect(store.list().every(r => r.current === null)).toBe(true);
    expect(store.list().find(r => r.entry.kind === 'service')?.entry).toEqual(service());
  });

  test('the thirtieth save fits, the next is rejected without evicting an existing update', () => {
    const store = new SavedUpdateStore();
    for (let n=0;n<SAVED_UPDATE_LIMIT;n++) expect(store.toggle(service(String(n))).ok).toBe(true);
    expect(store.toggle(live())).toMatchObject({ok:false,saved:false,message:expect.stringContaining('full')});
    expect(store.list()).toHaveLength(30);
    expect(store.has(service('0'))).toBe(true);
    store.toggle(service('0'));
    expect(store.toggle(live()).ok).toBe(true);
    expect(new SavedUpdateStore().list()).toHaveLength(30);
  });

  test('account changes isolate saved content and returning requires a new feed check', () => {
    const store = new SavedUpdateStore();
    store.toggle(service());
    store.reconcile([service()],allKinds);
    localStorage.setItem('token',token('bob'));
    expect(store.list()).toEqual([]);
    store.toggle(live());
    localStorage.setItem('token',token('alice','renewed'));
    expect(store.list()).toHaveLength(1);
    expect(store.list()[0]).toMatchObject({entry:service(),current:null});
    expect(store.has(live())).toBe(false);
    expect(new SavedUpdateStore().has(service())).toBe(true);
  });

  test('invalid and signed-out tokens use separate temporary memory with no persisted identities', () => {
    const store = new SavedUpdateStore();
    localStorage.setItem('token','opaque-a');
    store.toggle(service());
    expect(store.has(service())).toBe(true);
    localStorage.setItem('token','opaque-b');
    expect(store.list()).toEqual([]);
    store.toggle(live());
    localStorage.setItem('token','opaque-a');
    expect(store.has(service())).toBe(true);
    localStorage.removeItem('token');
    expect(store.list()).toEqual([]);
    expect(new SavedUpdateStore().list()).toEqual([]);
    expect(Object.keys(localStorage).some(key=>key.startsWith(SAVED_UPDATES_PREFIX))).toBe(false);
  });

  test('blocked writes preserve saves and removals across reload instead of restoring stale disk data', () => {
    const store = new SavedUpdateStore();
    store.toggle(service());
    const set = jest.spyOn(Storage.prototype,'setItem').mockImplementation(()=>{ throw new Error('quota'); });
    expect(store.toggle(live()).message).toContain('for this page');
    store.toggle(service());
    store.reload();
    expect(store.has(live())).toBe(true);
    expect(store.has(service())).toBe(false);
    set.mockRestore();
    store.toggle(service('third'));
    expect(new SavedUpdateStore().list().map(r=>r.key)).toEqual(expect.arrayContaining([inboxKey(live()),inboxKey(service('third'))]));
    expect(new SavedUpdateStore().has(service())).toBe(false);
  });

  test('blocked reads retain the last account and in-page snapshot, while cold storage failure stays usable', () => {
    const store = new SavedUpdateStore();
    store.toggle(service());
    jest.spyOn(Storage.prototype,'getItem').mockImplementation(()=>{ throw new Error('denied'); });
    store.reload();
    expect(store.has(service())).toBe(true);
    expect(store.toggle(live()).ok).toBe(true);
    const cold = new SavedUpdateStore();
    expect(cold.list()).toEqual([]);
    expect(cold.toggle(service()).ok).toBe(true);
    cold.reload();
    expect(cold.has(service())).toBe(true);
  });

  test('reload receives another tab changes and local mutation merges the latest saved list', () => {
    const first = new SavedUpdateStore();
    const second = new SavedUpdateStore();
    first.toggle(service());
    second.reload();
    expect(second.has(service())).toBe(true);
    first.toggle(live());
    second.toggle(service('second'));
    first.reload();
    expect(first.list()).toHaveLength(3);
    second.toggle(service());
    first.reload();
    expect(first.has(service())).toBe(false);
  });

  test('import rejects malformed records and timestamps, recomputes keys, and strips unsafe links', () => {
    const entry = service();
    if (entry.kind === 'service') {
      entry.value.url = 'javascript:alert(1)';
      entry.value.routeIds = ['61C','61C',17 as unknown as string];
    }
    localStorage.setItem(storageKey(),JSON.stringify([
      null,{entry:{kind:'other',value:{}},savedAt:1,updatedAt:1},
      {entry:live(),savedAt:Date.now(),updatedAt:Date.now()+120000},
      {entry:live(),savedAt:20,updatedAt:10},
      {key:'forged',entry,savedAt:Date.now(),updatedAt:Date.now(),current:true},
      {entry,savedAt:1,updatedAt:1}
    ]));
    const rows = new SavedUpdateStore().list();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({key:inboxKey(entry),current:null});
    if(rows[0].entry.kind === 'service') {
      expect(rows[0].entry.value.url).toBeUndefined();
      expect(rows[0].entry.value.routeIds).toEqual(['61C']);
    }
  });

  test('oversized imported lists are capped and malformed JSON can recover on an explicit save', () => {
    localStorage.setItem(storageKey(),JSON.stringify(Array.from({length:45},(_,n)=>({entry:service(String(n)),savedAt:1,updatedAt:1}))));
    expect(new SavedUpdateStore().list()).toHaveLength(30);
    localStorage.setItem(storageKey(),'{broken');
    const store = new SavedUpdateStore();
    expect(store.list()).toEqual([]);
    expect(store.toggle(service()).ok).toBe(true);
    expect(new SavedUpdateStore().list()).toHaveLength(1);
  });

  test('saved input and returned records are copied, and malformed updates cannot corrupt existing content', () => {
    const store = new SavedUpdateStore();
    const entry = service();
    store.toggle(entry);
    if(entry.kind === 'service') entry.value.descriptionText = 'External mutation';
    const returned = store.list();
    if(returned[0].entry.kind === 'service') returned[0].entry.value.routeIds.push('71C');
    expect(store.list()[0].entry).toEqual(service());
    const malformed = {kind:'live',value:{}} as InboxEntry;
    expect(store.toggle(malformed)).toMatchObject({ok:false,saved:false});
    expect(store.has(malformed)).toBe(false);
    store.reconcile([malformed],new Set(['live']));
    expect(store.list()[0].entry).toEqual(service());
  });
});

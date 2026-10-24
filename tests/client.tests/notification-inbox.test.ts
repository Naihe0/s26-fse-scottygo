/** @jest-environment jsdom */
import {
  NotificationReadStore,
  buildInboxShare,
  groupInbox,
  inboxAccount,
  inboxFingerprint,
  shareInboxSummary,
  sortInbox,
  type InboxEntry
} from '../../client/scripts/utils/notification-inbox';

const service = (
  id = 'one',
  severity?: 'INFO' | 'WARNING' | 'SEVERE'
): InboxEntry => ({
  kind: 'service',
  value: {
    id,
    headerText: `Service ${id}`,
    descriptionText: 'A service notice.',
    routeIds: ['61C'],
    activePeriods: [],
    severityLevel: severity
  }
});
const live = (id = 'one'): InboxEntry => ({
  kind: 'live',
  value: {
    _id: id,
    routeId: '61C',
    vid: '123',
    message: 'A rider update.',
    changedFields: ['condition'],
    reportId: 'report',
    createdAt: new Date().toISOString()
  }
});

describe('personal notification read state', () => {
  beforeEach(() => {
    localStorage.clear();
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-10-24T16:00:00Z'));
  });
  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  test('requires an explicit read action and persists by account', () => {
    const store = new NotificationReadStore(() => 'one');
    expect(store.isRead(service())).toBe(false);
    store.setRead(service(), true);
    expect(new NotificationReadStore(() => 'one').isRead(service())).toBe(true);
    expect(new NotificationReadStore(() => 'two').isRead(service())).toBe(
      false
    );
    store.setRead(service(), false);
    expect(new NotificationReadStore(() => 'one').isRead(service())).toBe(
      false
    );
  });

  test('updated content is unread while reordered route metadata remains read', () => {
    const entry = service();
    if (entry.kind !== 'service') throw new Error('fixture');
    entry.value.routeIds = ['71C', '61C'];
    const store = new NotificationReadStore(() => 'one');
    store.setRead(entry, true);
    const reordered: InboxEntry = {
      ...entry,
      value: { ...entry.value, routeIds: ['61C', '71C'] }
    };
    expect(inboxFingerprint(reordered)).toBe(inboxFingerprint(entry));
    expect(store.isRead(reordered)).toBe(true);
    expect(
      store.isRead({
        ...entry,
        value: { ...entry.value, descriptionText: 'The road has reopened.' }
      })
    ).toBe(false);
    expect(
      store.isRead({
        ...entry,
        value: { ...entry.value, severityLevel: 'SEVERE' }
      })
    ).toBe(false);
  });

  test('switching accounts never carries another account read receipts', () => {
    let account = 'one';
    const store = new NotificationReadStore(() => account);
    store.setRead(live(), true);
    account = 'two';
    expect(store.isRead(live())).toBe(false);
    account = 'one';
    expect(store.isRead(live())).toBe(true);
  });

  test('uses immutable user ID across renewed tokens and usernames', () => {
    const token = (userId: string, username: string) =>
      `head.${btoa(JSON.stringify({ userId, username }))}.signature`;
    localStorage.setItem('token', token('immutable', 'before'));
    localStorage.setItem('username', 'before');
    expect(inboxAccount()).toBe('user:immutable');
    localStorage.setItem('token', token('immutable', 'after'));
    localStorage.setItem('username', 'after');
    expect(inboxAccount()).toBe('user:immutable');
    localStorage.removeItem('token');
    expect(inboxAccount()).toBeNull();
  });

  test('does not reuse username receipts for another account or an opaque session', () => {
    const token = (userId: string) =>
      `head.${btoa(JSON.stringify({ userId }))}.signature`;
    localStorage.setItem('username', 'alice');
    localStorage.setItem('token', token('account-a'));
    const store = new NotificationReadStore();
    store.setRead(service(), true);
    localStorage.setItem('username', 'alice-renamed');
    expect(store.isRead(service())).toBe(true);
    localStorage.setItem('username', 'alice');
    localStorage.setItem('token', token('account-b'));
    expect(store.isRead(service())).toBe(false);
    localStorage.setItem('token', 'opaque-token');
    expect(inboxAccount()).toBeNull();
    expect(store.isRead(service())).toBe(false);
    store.setRead(service(), true);
    expect(new NotificationReadStore().isRead(service())).toBe(false);
    localStorage.setItem('token', 'different-opaque-token');
    expect(store.isRead(service())).toBe(false);
  });

  test('keeps only the newest 500 receipts even when actions share a timestamp', () => {
    const store = new NotificationReadStore(() => 'one');
    for (let index = 0; index < 505; index++)
      store.setRead(service(String(index)), true);
    const restored = new NotificationReadStore(() => 'one');
    expect(restored.isRead(service('0'))).toBe(false);
    expect(restored.isRead(service('504'))).toBe(true);
    expect(
      JSON.parse(localStorage.getItem('scottygo:notification-inbox:v1:one')!)
        .length
    ).toBe(500);
  });

  test('expires read receipts after 45 days', () => {
    const store = new NotificationReadStore(() => 'one');
    store.setRead(service(), true);
    jest.advanceTimersByTime(46 * 24 * 60 * 60_000);
    expect(store.isRead(service())).toBe(false);
    expect(new NotificationReadStore(() => 'one').isRead(service())).toBe(
      false
    );
  });

  test('invalid storage recovers and blocked writes retain session read state', () => {
    localStorage.setItem('scottygo:notification-inbox:v1:one', '{invalid');
    const store = new NotificationReadStore(() => 'one');
    expect(store.isRead(service())).toBe(false);
    jest.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('Storage blocked');
    });
    store.setRead(service(), true);
    expect(store.isRead(service())).toBe(true);
  });
});

describe('inbox ordering and route grouping', () => {
  test('priority uses supplied severity and never promotes unknown severity', () => {
    const unknown = service('unknown');
    const info = service('info', 'INFO');
    const severe = service('severe', 'SEVERE');
    const warning = service('warning', 'WARNING');
    expect(sortInbox([unknown, info, severe, warning], 'priority')).toEqual([
      severe,
      warning,
      info,
      unknown
    ]);
  });

  test('newest order uses provided alert-window dates and stable ordering for missing dates', () => {
    const old = service('old');
    const recent = service('recent');
    if (old.kind !== 'service' || recent.kind !== 'service')
      throw new Error('fixture');
    old.value.activePeriods = [{ start: '2026-01-01T00:00:00Z', end: '' }];
    recent.value.activePeriods = [{ start: '2026-10-01T00:00:00Z', end: '' }];
    const missingA = service('missing-a');
    const missingB = service('missing-b');
    expect(sortInbox([missingA, old, missingB, recent], 'newest')).toEqual([
      recent,
      old,
      missingA,
      missingB
    ]);
  });

  test('shared notices form one route-combination group without duplicating cards', () => {
    const shared = service('shared');
    const sharedAgain = service('another');
    const network = service('network');
    if (
      shared.kind !== 'service' ||
      sharedAgain.kind !== 'service' ||
      network.kind !== 'service'
    )
      throw new Error('fixture');
    shared.value.routeIds = ['71C', '61C'];
    sharedAgain.value.routeIds = ['61C', '71C'];
    network.value.routeIds = [];
    const entries = [shared, live(), sharedAgain, network];
    const groups = groupInbox(entries);
    expect(groups).toHaveLength(3);
    expect(groups[0].routeIds).toEqual(['61C', '71C']);
    expect(groups[0].entries).toEqual([shared, sharedAgain]);
    expect(groups.flatMap((group) => group.entries)).toHaveLength(
      entries.length
    );
  });
});

describe('explicit update sharing', () => {
  const share = jest.fn();
  const copy = jest.fn();
  const announce = jest.fn();
  let button: HTMLButtonElement;
  beforeEach(() => {
    jest.clearAllMocks();
    Object.defineProperty(navigator, 'share', {
      configurable: true,
      value: share
    });
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: copy }
    });
    document.body.innerHTML = '<button>Share update</button>';
    button = document.querySelector('button')!;
    copy.mockResolvedValue(undefined);
    share.mockResolvedValue(undefined);
  });
  afterEach(() => {
    document.body.innerHTML = '';
  });

  test('includes readable route context and only a validated agency source URL', () => {
    const entry = service();
    if (entry.kind !== 'service') throw new Error('fixture');
    entry.value.url = 'https://agency.example/notice';
    const summary = buildInboxShare(
      entry,
      (id) => `Route ${id}`,
      'https://app.example'
    );
    expect(summary.text).toContain('Route 61C');
    expect(summary.url).toBe('https://agency.example/notice');
    entry.value.url = 'javascript:alert(1)';
    expect(buildInboxShare(entry, (id) => id, 'https://app.example').url).toBe(
      'https://app.example/notifications?route=61C&type=service'
    );
  });

  test('native share is used only after calling the action and does not also copy', async () => {
    const summary = buildInboxShare(service(), (id) => id);
    expect(share).not.toHaveBeenCalled();
    await shareInboxSummary(summary, button, announce);
    expect(share).toHaveBeenCalledWith(summary);
    expect(copy).not.toHaveBeenCalled();
    expect(button.disabled).toBe(false);
  });

  test('a user-cancelled share does not copy behind the share sheet', async () => {
    share.mockRejectedValue(new DOMException('Canceled', 'AbortError'));
    await shareInboxSummary(
      buildInboxShare(service(), (id) => id),
      button,
      announce
    );
    expect(copy).not.toHaveBeenCalled();
    expect(document.querySelector('dialog')).toBeNull();
  });

  test('unsupported native sharing falls back to copying the summary', async () => {
    share.mockRejectedValue(new Error('Not available'));
    await shareInboxSummary(
      buildInboxShare(service(), (id) => id, 'https://app.example'),
      button,
      announce
    );
    expect(copy.mock.calls[0][0]).toContain(
      'https://app.example/notifications?route=61C&type=service'
    );
    expect(announce).toHaveBeenCalledWith('Update summary copied.');
  });

  test('clipboard failure opens a selectable literal summary with focus restoration', async () => {
    Object.defineProperty(navigator, 'share', {
      configurable: true,
      value: undefined
    });
    copy.mockRejectedValue(new Error('Denied'));
    await shareInboxSummary(
      { title: 'Update', text: '<img src=x onerror=alert(1)>' },
      button,
      announce
    );
    const textarea = document.querySelector('textarea')!;
    expect(textarea.value).toBe('<img src=x onerror=alert(1)>');
    expect(document.querySelector('img')).toBeNull();
    expect(document.activeElement).toBe(textarea);
    document.querySelector<HTMLButtonElement>('dialog button')!.click();
    expect(document.querySelector('dialog')).toBeNull();
    expect(document.activeElement).toBe(button);
  });
});

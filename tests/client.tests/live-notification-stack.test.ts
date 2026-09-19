/** @jest-environment jsdom */
import { LiveNotificationStack } from '../../client/scripts/components/live-notification-stack';
import type { INotification } from '../../common/transit.interface';

const fixture = (id = 'n1'): INotification => ({
  _id: id,
  routeId: '61C',
  vid: '3400',
  message: 'Crowding changed. See https://example.com/details.',
  changedFields: ['crowdedness'],
  reportId: 'report',
  createdAt: '2026-09-19T12:00:00.000Z'
});
let stack: LiveNotificationStack;
let hidden = false;

beforeEach(() => {
  jest.useFakeTimers().setSystemTime(new Date('2026-09-19T12:01:00.000Z'));
  hidden = false;
  jest.spyOn(document, 'hidden', 'get').mockImplementation(() => hidden);
  document.body.innerHTML = '';
  stack = new LiveNotificationStack(
    (route) => `Route ${route}`,
    (message) => message
  );
});
afterEach(() => {
  stack.destroy();
  jest.restoreAllMocks();
  jest.useRealTimers();
});
const cards = () => document.querySelectorAll<HTMLElement>('.live-notif-card');

test('renders safe actionable rider information and a polite announcement', () => {
  stack.show(fixture());
  expect(cards()).toHaveLength(1);
  expect(document.querySelector('.live-notif-tag')!.textContent).toBe(
    'Crowding'
  );
  expect(document.querySelector('.live-notif-subtitle')!.textContent).toBe(
    'Bus 3400 · Rider report'
  );
  expect(document.querySelector('.live-notif-time')!.textContent).toBe(
    '1 min ago'
  );
  expect(document.querySelector('.live-notif-map')!.getAttribute('href')).toBe(
    '/#/map?r=61C'
  );
  expect(
    document.querySelector('.live-notif-history')!.getAttribute('href')
  ).toBe('/notifications?route=61C&type=live');
  expect(
    document.querySelector('.live-notif-body a')!.getAttribute('rel')
  ).toBe('noopener noreferrer');
  expect(document.querySelector('[role="status"]')!.textContent).toContain(
    'Rider report'
  );
});

test('malicious rider content is literal text, including title fields', () => {
  stack.show({
    ...fixture(),
    routeId: '<img src=x onerror=alert(1)>',
    vid: '<svg/onload=alert(1)>',
    message: '<img src=x onerror=alert(1)> javascript:alert(1)'
  });
  expect(document.querySelector('img,svg,script')).toBeNull();
  expect(document.querySelector('.live-notif-body')!.textContent).toContain(
    '<img'
  );
  expect(document.querySelectorAll('.live-notif-body a')).toHaveLength(0);
});

test('deduplicates reconnect events by id and by content when no id exists', () => {
  stack.show(fixture());
  stack.show(fixture());
  const withoutId = { ...fixture('other'), _id: undefined };
  stack.show(withoutId);
  stack.show(withoutId);
  expect(cards()).toHaveLength(2);
});

test('caps bursts at three cards and retains the focused card', () => {
  stack.show(fixture('1'));
  cards()[0].querySelector<HTMLAnchorElement>('a')!.focus();
  for (let index = 2; index <= 8; index++) stack.show(fixture(String(index)));
  expect(cards()).toHaveLength(3);
  expect(document.activeElement?.closest('.live-notif-card')).toBe(cards()[0]);
  expect(cards()[0].isConnected).toBe(true);
});

test('auto-dismiss removes cards without relying on animation events', () => {
  stack.show(fixture());
  jest.advanceTimersByTime(30_000);
  expect(cards()).toHaveLength(0);
  expect(document.querySelector('.live-notif-container')).toBeNull();
});

test('reading time pauses on hover and resumes the remaining interval', () => {
  stack.show(fixture());
  jest.advanceTimersByTime(20_000);
  cards()[0].dispatchEvent(new Event('pointerenter'));
  jest.advanceTimersByTime(60_000);
  expect(cards()).toHaveLength(1);
  cards()[0].dispatchEvent(new Event('pointerleave'));
  jest.advanceTimersByTime(9_999);
  expect(cards()).toHaveLength(1);
  jest.advanceTimersByTime(1);
  expect(cards()).toHaveLength(0);
});

test('keyboard focus protects a card even after pointer leaves', () => {
  stack.show(fixture());
  const card = cards()[0];
  card.dispatchEvent(new Event('pointerenter'));
  card.querySelector<HTMLAnchorElement>('a')!.focus();
  card.dispatchEvent(new Event('pointerleave'));
  jest.advanceTimersByTime(60_000);
  expect(cards()).toHaveLength(1);
  document.querySelector<HTMLAnchorElement>('.live-notif-all')!.focus();
  jest.advanceTimersByTime(30_000);
  expect(cards()).toHaveLength(0);
});

test('hidden pages do not consume popup reading time', () => {
  hidden = true;
  stack.show(fixture());
  jest.advanceTimersByTime(60_000);
  expect(cards()).toHaveLength(1);
  hidden = false;
  document.dispatchEvent(new Event('visibilitychange'));
  jest.advanceTimersByTime(10_000);
  hidden = true;
  document.dispatchEvent(new Event('visibilitychange'));
  jest.advanceTimersByTime(60_000);
  hidden = false;
  document.dispatchEvent(new Event('visibilitychange'));
  jest.advanceTimersByTime(20_000);
  expect(cards()).toHaveLength(0);
});

test('manual dismissal retains keyboard focus on the history action', () => {
  stack.show(fixture());
  const dismiss = cards()[0].querySelector<HTMLButtonElement>('button')!;
  dismiss.focus();
  dismiss.click();
  expect(cards()).toHaveLength(0);
  expect(document.activeElement?.className).toBe('live-notif-all');
  stack.destroy();
  expect(jest.getTimerCount()).toBe(0);
});

test('returning from a hidden tab refreshes the reported update time', () => {
  hidden = true;
  stack.show(fixture());
  jest.advanceTimersByTime(3_600_000);
  hidden = false;
  document.dispatchEvent(new Event('visibilitychange'));
  expect(document.querySelector('time')!.textContent).toBe('1 hr ago');
});

test('destroy cancels timers and removes the stack', () => {
  stack.show(fixture());
  stack.show(fixture('2'));
  stack.destroy();
  expect(jest.getTimerCount()).toBe(0);
  expect(document.querySelector('.live-notif-container')).toBeNull();
});

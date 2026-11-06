/** @jest-environment jsdom */
import { StopArrivalBoard } from '../../client/scripts/components/stop-arrival-board';
import type { IPrediction } from '../../common/transit.interface';

const NOW = Date.UTC(2026, 10, 6, 15, 0);
const stop = { stopId: '7117', stopName: 'Forbes at Campus' };
function departure(
  minutes: number,
  occurrenceId: string,
  routeId = '61D',
  vid = '3520'
): IPrediction {
  return {
    stopId: stop.stopId,
    routeId,
    vid,
    occurrenceId,
    predictedArrivalTime: NOW + minutes * 60_000,
    minutes,
    isDelayed: false
  };
}
function mount(rows: IPrediction[], available = true): StopArrivalBoard {
  document.body.innerHTML =
    '<section id="board"></section><button id="directions"><span data-directions-label></span></button>';
  const board = new StopArrivalBoard(rows, available, () => '#a31432', stop);
  board.mount(
    document.getElementById('board')!,
    document.getElementById('directions') as HTMLButtonElement
  );
  return board;
}
function control<T extends HTMLElement = HTMLButtonElement>(
  selector: string
): T {
  const node = document.querySelector<T>(selector);
  if (!node) throw new Error('Missing control: ' + selector);
  return node;
}
function chooseReminder(minutes: string): void {
  const select = control<HTMLSelectElement>('[data-watch-reminder]');
  select.value = minutes;
  select.dispatchEvent(new Event('change'));
}
function watch(index = 0): void {
  document.querySelectorAll<HTMLButtonElement>('[data-key]')[index].click();
  control('[data-watch-selected]').click();
}
const status = () => control('[data-watch-status]').textContent || '';
const clock = () => control('[data-watch-clock]').textContent || '';
const countdown = () => control('[data-watch-countdown]').textContent || '';

beforeEach(() => {
  jest.useFakeTimers().setSystemTime(NOW);
  Object.defineProperty(document, 'hidden', {
    configurable: true,
    value: false
  });
});
afterEach(() => {
  jest.useRealTimers();
  document.body.replaceChildren();
});

test('watch departure requires exactly one selection and All arrivals preserves the directions choices', () => {
  const first = departure(4, 'visit-1');
  const board = mount([first, departure(9, 'visit-2')]);
  expect(control('[data-watch-selected]').hidden).toBe(true);
  const rows = document.querySelectorAll<HTMLButtonElement>('[data-key]');
  rows[0].click();
  expect(control('[data-watch-selected]').hidden).toBe(false);
  rows[1].click();
  expect(control('[data-watch-selected]').hidden).toBe(true);
  rows[1].click();
  control('[data-watch-selected]').click();
  expect(control('.departure-watch').hidden).toBe(false);
  expect(countdown()).toMatch(/4/);
  expect(clock()).toContain('ET');
  expect(control('[data-watch-status]').getAttribute('role')).toBe('status');
  control('[data-watch-back]').click();
  expect(
    document.querySelector<HTMLElement>('.departure-watch')?.hidden ?? true
  ).toBe(true);
  expect(board.selectedPredictions).toEqual([first]);
  expect(control('[data-directions-label]').textContent).toBe(
    'Directions (1 bus)'
  );
});

test('the watched occurrence follows its revised ETA without jumping to a second visit by the same bus', () => {
  const first = departure(4, 'visit-1');
  const board = mount([first, departure(12, 'visit-2')]);
  watch();
  board.refresh([departure(3, 'visit-2'), departure(7, 'visit-1')]);
  expect(countdown()).toMatch(/7/);
  expect(clock()).toContain('10:07');
  expect(board.selectedPredictions[0].occurrenceId).toBe('visit-1');
});

test('a missing watched visit retains its last clock and never silently chooses a different departure', () => {
  const board = mount([departure(4, 'visit-1'), departure(12, 'visit-2')]);
  watch();
  const lastClock = clock();
  board.refresh([departure(12, 'visit-2')]);
  expect(clock()).toContain(lastClock);
  expect(status()).toMatch(/no longer|missing|not.*latest/i);
  expect(countdown()).not.toMatch(/12/);
  chooseReminder('5');
  expect(status()).not.toContain('expected within');
  board.refresh([departure(6, 'visit-1'), departure(12, 'visit-2')]);
  expect(countdown()).toMatch(/6/);
  expect(status()).not.toMatch(/no longer|missing|not.*latest/i);
});

test('ambiguous repeated bus visits without occurrence IDs become missing instead of attaching the watch to another visit', () => {
  const first = { ...departure(4, 'visit-1'), occurrenceId: undefined };
  const later = { ...departure(12, 'visit-2'), occurrenceId: undefined };
  const board = mount([first, later]);
  watch();
  board.refresh([later]);
  expect(clock()).toContain('10:04');
  expect(status()).toMatch(/no longer|missing|not.*latest/i);
  expect(countdown()).not.toMatch(/12/);
});

test('Escape cancels the departure watch, restores its trigger focus and does not escape to the map', () => {
  mount([departure(4, 'visit-1')]);
  watch();
  const bubbled = jest.fn();
  document.addEventListener('keydown', bubbled);
  const escape = new KeyboardEvent('keydown', {
    key: 'Escape',
    bubbles: true,
    cancelable: true
  });
  control('[data-watch-reminder]').dispatchEvent(escape);
  expect(escape.defaultPrevented).toBe(true);
  expect(bubbled).not.toHaveBeenCalled();
  expect(control('.departure-watch').hidden).toBe(true);
  expect(document.activeElement).toBe(control('[data-watch-selected]'));
  document.removeEventListener('keydown', bubbled);
});

test('Next departure explicitly chooses the next later visit on the same route without changing directions selection', () => {
  const first = departure(4, 'visit-1');
  const board = mount([
    first,
    departure(3, 'earlier'),
    departure(5, 'other', '61C'),
    departure(12, 'visit-3'),
    departure(8, 'visit-2')
  ]);
  watch();
  control('[data-watch-next]').click();
  expect(countdown()).toMatch(/8/);
  expect(board.selectedPredictions).toEqual([first]);
  control('[data-watch-next]').click();
  expect(countdown()).toMatch(/12/);
  const next = control<HTMLButtonElement>('[data-watch-next]');
  expect(next.hidden || next.disabled).toBe(true);
});

test('a watch reminder fires at its threshold and does not reannounce after ETA jitter', async () => {
  const board = mount([departure(3, 'visit-1')]);
  watch();
  chooseReminder('2');
  expect(status()).not.toContain('expected within');
  const announcements: string[] = [];
  const observer = new MutationObserver((records) => {
    for (const record of records)
      for (const added of record.addedNodes)
        if (added.textContent?.includes('expected within'))
          announcements.push(added.textContent);
  });
  observer.observe(control('.departure-watch'), {
    subtree: true,
    childList: true,
    characterData: true
  });
  jest.setSystemTime(NOW + 60_000);
  board.tick();
  await Promise.resolve();
  expect(status()).toBe('Route 61D is expected within 2 min.');
  board.tick();
  board.refresh([departure(6, 'visit-1')]);
  board.refresh([departure(2, 'visit-1')]);
  await Promise.resolve();
  observer.disconnect();
  expect(announcements).toHaveLength(1);
});

test('arming a reminder already within its window notifies immediately while switching it off prevents another reminder', () => {
  const board = mount([departure(1, 'visit-1')]);
  watch();
  chooseReminder('2');
  expect(status()).toBe('Route 61D is expected within 2 min.');
  chooseReminder('0');
  jest.setSystemTime(NOW + 20_000);
  board.refresh([departure(1, 'visit-1')]);
  expect(status()).not.toContain('expected within');
});

test('a past watched estimate never triggers an arrival reminder', () => {
  const board = mount([departure(-1, 'visit-1')]);
  watch();
  chooseReminder('5');
  board.tick();
  expect(status()).not.toContain('expected within');
});

test.each(['unavailable', 'inactive', 'hidden', 'stale'] as const)(
  'a %s watch cannot trigger a reminder until fresh active foreground data is available',
  (condition) => {
    const board = mount([departure(3, 'visit-1')]);
    watch();
    chooseReminder('2');
    if (condition === 'unavailable') board.setUnavailable(true);
    if (condition === 'inactive') board.setActive(false);
    if (condition === 'hidden')
      Object.defineProperty(document, 'hidden', {
        configurable: true,
        value: true
      });
    jest.setSystemTime(NOW + (condition === 'stale' ? 91_000 : 60_000));
    board.tick();
    expect(status()).not.toContain('expected within');
    board.setActive(true);
    Object.defineProperty(document, 'hidden', {
      configurable: true,
      value: false
    });
    board.refresh([departure(3, 'visit-1')]);
    expect(status()).toBe('Route 61D is expected within 2 min.');
  }
);

test('unavailable watched data retains an absolute ET clock and clears fresh countdown claims', () => {
  const board = mount([departure(3, 'visit-1')]);
  watch();
  const previousClock = clock();
  board.setUnavailable(true);
  jest.setSystemTime(NOW + 120_000);
  board.tick();
  expect(clock()).toContain(previousClock);
  expect(status()).toMatch(/waiting|paused|unavailable|last known/i);
  expect(countdown()).not.toMatch(/^1\s*min$/);
});

test('Next departure preserves the reminder threshold and rearms it only for the explicitly chosen visit', () => {
  const board = mount([departure(1, 'visit-1'), departure(2, 'visit-2')]);
  watch();
  chooseReminder('2');
  expect(status()).toBe('Route 61D is expected within 2 min.');
  control('[data-watch-next]').click();
  expect(control<HTMLSelectElement>('[data-watch-reminder]').value).toBe('2');
  expect(countdown()).toMatch(/2/);
  expect(status()).toBe('Route 61D is expected within 2 min.');
  expect(board.selectedPredictions[0].occurrenceId).toBe('visit-1');
});

test('All arrivals cancels watch reminders and remount keeps an active watch on the same visit', () => {
  const board = mount([departure(3, 'visit-1'), departure(9, 'visit-2')]);
  watch();
  chooseReminder('2');
  board.setActive(false);
  board.mount(
    document.getElementById('board')!,
    document.getElementById('directions') as HTMLButtonElement
  );
  expect(control('.departure-watch').hidden).toBe(false);
  expect(clock()).toContain('10:03');
  control('[data-watch-back]').click();
  board.setActive(true);
  jest.setSystemTime(NOW + 60_000);
  board.refresh([departure(3, 'visit-1')]);
  expect(
    document.querySelector<HTMLElement>('.departure-watch')?.hidden ?? true
  ).toBe(true);
  expect(document.body.textContent).not.toContain('expected within');
});

test('a detached departure watch cannot announce a reminder or create offscreen feedback', () => {
  const board = mount([departure(3, 'visit-1')]);
  watch();
  chooseReminder('2');
  const host = document.getElementById('board')!;
  host.remove();
  jest.setSystemTime(NOW + 60_000);
  board.tick();
  expect(host.querySelector('[data-watch-status]')?.textContent).not.toContain(
    'expected within'
  );
  expect(document.body.textContent).not.toContain('expected within');
  document.body.append(host);
  board.refresh([departure(3, 'visit-1')]);
  expect(status()).toBe('Route 61D is expected within 2 min.');
});

test('a fired reminder stays acknowledged after pause and fresh recovery without reannouncing the threshold', () => {
  const board = mount([departure(1, 'visit-1')]);
  watch();
  chooseReminder('2');
  expect(status()).toBe('Route 61D is expected within 2 min.');
  board.setActive(false);
  expect(status()).not.toContain('expected within');
  board.setUnavailable(true);
  board.refresh([departure(1, 'visit-1')]);
  board.setActive(true);
  expect(status()).toMatch(/reminder.*shown/i);
  expect(status()).not.toContain('expected within');
});

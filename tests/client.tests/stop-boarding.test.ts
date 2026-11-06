/** @jest-environment jsdom */
import { StopArrivalBoard } from '../../client/scripts/components/stop-arrival-board';
import type { IPrediction } from '../../common/transit.interface';

const base = Date.UTC(2026, 10, 5, 14);
function arrival(routeId: string, minutes: number, vid: string): IPrediction {
  return {
    routeId,
    minutes,
    vid,
    stopId: '10',
    predictedArrivalTime: base + minutes * 60_000,
    isDelayed: false
  };
}
function mount(rows: IPrediction[]) {
  document.body.innerHTML =
    '<section></section><button><span data-directions-label></span></button>';
  const board = new StopArrivalBoard(rows, true, () => '#404040');
  board.mount(
    document.querySelector('section')!,
    document.querySelector('button')!
  );
  return board;
}
function choose(selector: string, value: string) {
  const input = document.querySelector<HTMLSelectElement>(selector)!;
  input.value = value;
  input.dispatchEvent(new Event('change'));
}
const visible = () =>
  Array.from(document.querySelectorAll<HTMLButtonElement>('[data-key]'));

beforeEach(() => jest.useFakeTimers().setSystemTime(base));
afterEach(() => {
  jest.useRealTimers();
  document.body.replaceChildren();
});

test('the soonest viable trip on each route changes as old estimates pass and more enter the time window', () => {
  const board = mount([
    arrival('A', -3, '0'),
    arrival('A', 18, '2'),
    arrival('B', 16, '3'),
    arrival('A', 2, '1')
  ]);
  expect(visible()[0].textContent).toContain('Estimate passed');
  choose('[data-view]', 'first');
  choose('[data-within]', '15');
  expect(visible()).toHaveLength(1);
  expect(visible()[0].textContent).toContain('Bus 1');
  jest.setSystemTime(base + 4 * 60_000);
  board.tick();
  expect(
    visible().map((r) => r.querySelector('.map-popup__meta')?.textContent)
  ).toEqual(['Bus 3', 'Bus 2']);
});

test('review one selected visit and see a changed ETA only for the same identifiable departure', () => {
  const rows = [
    arrival('A', 2, 'loop'),
    arrival('A', 12, 'loop'),
    arrival('B', 8, 'bus')
  ];
  const board = mount(rows);
  visible()[0].click();
  expect(
    visible().filter((r) => r.getAttribute('aria-pressed') === 'true')
  ).toHaveLength(1);
  choose('[data-view]', 'selected');
  expect(visible()).toHaveLength(1);
  visible()[0].click();
  expect(document.querySelector('.map-popup__empty')?.textContent).toMatch(
    /No selected/
  );
  document.querySelector<HTMLButtonElement>('[data-reset-view]')!.click();
  board.refresh([rows[0], rows[1], arrival('B', 12, 'bus')]);
  expect(
    document.querySelector('.arrival-board__change')?.textContent
  ).toContain('4 min later');
  expect(document.querySelectorAll('.arrival-board__change')).toHaveLength(1);
});

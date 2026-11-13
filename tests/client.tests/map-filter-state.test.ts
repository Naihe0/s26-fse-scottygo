/** @jest-environment jsdom */
import { MapStateManager } from '../../client/scripts/state/map-state';
import {
  shortRouteLabel,
  summarizeFilters
} from '../../client/scripts/components/map-controls';
import type { IRoute } from '../../common/transit.interface';

const state = MapStateManager.getInstance();
const routes = [
  { id: '61C', name: 'McKeesport', system: 'PRT' },
  { id: 'CMU-2', name: 'AB Route- N. Oak & Shadyside Comb.', system: 'CMU' },
  { id: 'CMU-9', name: 'Escort service', system: 'CMU' }
] as IRoute[];

const button = (id: string) =>
  document.querySelector<HTMLButtonElement>(`#${id}`)!;
const value = (id: string) =>
  button(id).querySelector('[data-filter-value]')!.textContent;

beforeEach(() => {
  state.resetFilters();
  state.setAvailableRoutes(routes);
  document.body.innerHTML = '<map-controls></map-controls>';
});
afterEach(() => {
  document.body.innerHTML = '';
  jest.restoreAllMocks();
});

test('default filters read as all routes, PRT and both directions, with no Clear', () => {
  expect(value('route-filter-btn')).toBe('All');
  expect(value('system-filter-btn')).toBe('PRT');
  expect(value('direction-filter-btn')).toBe('Both');
  expect(button('route-filter-btn').getAttribute('aria-label')).toBe(
    'Route filter: all routes'
  );
  expect(button('system-filter-btn').getAttribute('aria-label')).toBe(
    'Transit system filter: PRT only'
  );
  expect(button('clear-filters-btn').hidden).toBe(true);
  expect(document.querySelectorAll('.is-filtered')).toHaveLength(0);
});

test('committed filters show their values and mark each narrowed control', () => {
  state.updateFilters({
    selectedRouteId: '61C',
    selectedSystems: { prt: true, cmu: true },
    selectedDirections: { inbound: true, outbound: false }
  });
  expect(value('route-filter-btn')).toBe('61C');
  expect(button('route-filter-btn').getAttribute('aria-label')).toBe(
    'Route filter: Route 61C'
  );
  expect(
    [...button('system-filter-btn').querySelectorAll('.system-text')].map(
      (part) => part.textContent
    )
  ).toEqual(['PRT', 'CMU']);
  expect(value('direction-filter-btn')).toBe('In');
  expect(button('direction-filter-btn').getAttribute('aria-label')).toBe(
    'Direction filter: inbound only'
  );
  for (const id of [
    'route-filter-btn',
    'system-filter-btn',
    'direction-filter-btn'
  ])
    expect(button(id).classList.contains('is-filtered')).toBe(true);
  expect(button('clear-filters-btn').hidden).toBe(false);
});

test('a scheduled date alone still offers Clear', () => {
  state.updateFilters({ selectedDate: new Date('2026-11-13T12:00:00Z') });
  expect(button('clear-filters-btn').hidden).toBe(false);
  expect(document.querySelectorAll('.is-filtered')).toHaveLength(0);
});

test('Clear hides itself after the reset and keeps keyboard focus on the toolbar', () => {
  state.updateFilters({ selectedRouteId: '61C' });
  const clear = button('clear-filters-btn');
  const requested = jest.fn();
  document.addEventListener('clearFilters', requested, { once: true });
  clear.focus();
  clear.click();
  expect(requested).toHaveBeenCalledTimes(1);
  // The map resets asynchronously through its navigation coordinator.
  state.resetFilters();
  expect(clear.hidden).toBe(true);
  expect(document.activeElement).toBe(button('route-filter-btn'));
  expect(value('route-filter-btn')).toBe('All');
  expect(document.querySelector('.toast-notification')?.textContent).toContain(
    'Filters cleared'
  );
});

test('a removed toolbar stops following map state', () => {
  const controls = document.querySelector('map-controls')!;
  const route = button('route-filter-btn');
  controls.remove();
  state.updateFilters({ selectedRouteId: '61C' });
  expect(route.querySelector('[data-filter-value]')!.textContent).toBe('All');
});

test('short labels fit the button for PRT and CMU routes', () => {
  expect(shortRouteLabel('61C', routes)).toBe('61C');
  expect(shortRouteLabel('CMU-2', routes)).toBe('AB');
  expect(shortRouteLabel('CMU-9', routes)).toBe('CMU');
  expect(shortRouteLabel('CMU-404', routes)).toBe('CMU');
  expect(
    summarizeFilters({
      ...state.getState(),
      selectedSystems: { prt: false, cmu: false },
      selectedDirections: { inbound: false, outbound: false }
    })
  ).toMatchObject({
    system: { value: 'None', active: true },
    direction: { value: 'None', active: true },
    narrowed: true
  });
});

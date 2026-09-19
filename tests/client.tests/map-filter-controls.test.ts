/** @jest-environment jsdom */
import { synchronizeMapFilterControls } from '../../client/scripts/state/map-filter-controls';
import { MapStateManager } from '../../client/scripts/state/map-state';
import { TogglePanel } from '../../client/scripts/components/toggle-panel';
import { RouteSelectorPanel } from '../../client/scripts/components/route-selector';
import '../../client/scripts/components/toggle-panel';
import '../../client/scripts/components/route-selector';
import '../../client/scripts/components/transit-search';

const state = MapStateManager.getInstance();
const flush = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};
let system: TogglePanel;
let direction: TogglePanel;
let routes: RouteSelectorPanel;

beforeEach(() => {
  jest.spyOn(console, 'log').mockImplementation(() => undefined);
  state.resetFilters();
  document.body.innerHTML =
    '<transit-search></transit-search><toggle-panel id="system-panel"></toggle-panel><toggle-panel id="direction-panel"></toggle-panel><route-selector-panel></route-selector-panel>';
  system = document.querySelector('#system-panel')!;
  direction = document.querySelector('#direction-panel')!;
  routes = document.querySelector('route-selector-panel')!;
  system.configure({
    eventName: 'systemFilterApplied',
    options: [
      { id: 'prt', label: 'PRT', defaultChecked: true },
      { id: 'cmu', label: 'CMU', defaultChecked: false }
    ]
  });
  direction.configure({
    eventName: 'directionFilterApplied',
    options: [
      { id: 'inbound', label: 'Inbound', defaultChecked: true },
      { id: 'outbound', label: 'Outbound', defaultChecked: true }
    ]
  });
  routes.setRoutes([
    { id: '61A', name: '61A' },
    { id: '61B', name: '61B' }
  ]);
});
afterEach(() => {
  document.body.innerHTML = '';
  jest.restoreAllMocks();
});

test('restored filters synchronize route search, selected route, and all committed toggles', () => {
  state.updateFilters({
    selectedRouteId: '61B',
    selectedSystems: { prt: true, cmu: true },
    selectedDirections: { inbound: false, outbound: true }
  });
  synchronizeMapFilterControls(state.getState());
  expect(
    document.querySelector<HTMLInputElement>('#transit-search-input')!.value
  ).toBe('61B');
  expect(
    routes.querySelector('[data-route="61B"]')!.getAttribute('aria-pressed')
  ).toBe('true');
  expect(system.getState()).toEqual(
    new Map([
      ['prt', true],
      ['cmu', true]
    ])
  );
  expect(direction.querySelector<HTMLInputElement>('#inbound')!.checked).toBe(
    false
  );
  // A draft change followed by Cancel must return to the history-restored state.
  direction.querySelector<HTMLInputElement>('#inbound')!.checked = true;
  direction.querySelector<HTMLButtonElement>('#toggle-cancel')!.click();
  expect(direction.querySelector<HTMLInputElement>('#inbound')!.checked).toBe(
    false
  );
});

test('clear resets text, draft controls, panel visibility, and late search responses without emitting selections', async () => {
  let finish!: (value: unknown) => void;
  global.fetch = jest.fn().mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    })
  );
  const search = document.querySelector<HTMLInputElement>(
    '#transit-search-input'
  )!;
  search.value = '61C';
  search.dispatchEvent(new Event('input'));
  routes.setSelection('61B');
  system.show();
  direction.show();
  routes.show();
  system.querySelector<HTMLInputElement>('#prt')!.checked = false;
  direction.querySelector<HTMLInputElement>('#outbound')!.checked = false;
  routes.querySelector<HTMLInputElement>('.route-search-input')!.value =
    'stale';
  const selected = jest.fn();
  document.addEventListener('routeSelected', selected);
  synchronizeMapFilterControls(state.getState());
  finish({
    ok: true,
    json: async () => ({
      payload: { routes: [{ id: '61C', name: 'old' }], stops: [] }
    })
  });
  await flush();
  expect(search.value).toBe('');
  expect(document.querySelector<HTMLElement>('#search-dropdown')!.hidden).toBe(
    true
  );
  expect(
    routes.querySelector<HTMLInputElement>('.route-search-input')!.value
  ).toBe('');
  expect(routes.querySelector('.selected')).toBeNull();
  expect(system.querySelector<HTMLInputElement>('#prt')!.checked).toBe(true);
  expect(system.querySelector<HTMLInputElement>('#cmu')!.checked).toBe(false);
  expect(direction.querySelector<HTMLInputElement>('#outbound')!.checked).toBe(
    true
  );
  expect([system.isOpen(), direction.isOpen(), routes.isOpen()]).toEqual([
    false,
    false,
    false
  ]);
  expect(selected).not.toHaveBeenCalled();
  document.removeEventListener('routeSelected', selected);
});

test('canceling a route draft retains the previously committed selection', () => {
  routes.setSelection('61A');
  routes.show();
  routes.querySelector<HTMLButtonElement>('[data-route="61B"]')!.click();
  routes.querySelector<HTMLButtonElement>('#route-cancel')!.click();
  routes.show();
  expect(
    routes.querySelector('[data-route="61A"]')!.getAttribute('aria-pressed')
  ).toBe('true');
  expect(
    routes.querySelector('[data-route="61B"]')!.getAttribute('aria-pressed')
  ).toBe('false');
});

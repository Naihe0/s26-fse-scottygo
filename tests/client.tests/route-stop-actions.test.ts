/** @jest-environment jsdom */
import type { IRoute, IStop } from '../../common/transit.interface';
import {
  createRouteStopActions,
  refreshRouteStopActions
} from '../../client/scripts/components/route-stop-actions';
import {
  getRiderShortcuts,
  toggleSavedStop
} from '../../client/scripts/utils/rider-shortcuts';
import { copyStopLink } from '../../client/scripts/utils/stop-link';

jest.mock('../../client/scripts/utils/stop-link', () => ({
  copyStopLink: jest.fn().mockResolvedValue(undefined)
}));
const stop: IStop = {
  stopId: '4407',
  stopName: 'Forbes & Morewood',
  lat: 40.44,
  lon: -79.94,
  routes: ['61C', '61D', '61D', 'CMU-1', 'UNKNOWN'],
  dtradd: [],
  dtrrem: []
};
const route = (
  id: string,
  name: string,
  system: 'PRT' | 'CMU' = 'PRT'
): IRoute => ({
  id,
  name,
  system,
  color: '#123456',
  directions: ['INBOUND'],
  activeStatus: true,
  operatingDays: [1]
});
const routes = [
  route('61C', 'McKeesport'),
  route('61D', 'Murray'),
  route('CMU-1', 'Campus Loop', 'CMU')
];
let sequence = 0;
function account(id: string): void {
  localStorage.setItem('token', `x.${btoa(JSON.stringify({ userId: id }))}.x`);
}
function setup(value = stop) {
  const explore = jest.fn(),
    announce = jest.fn(),
    openStop = jest.fn();
  const row = document.createElement('li');
  row.addEventListener('click', openStop);
  const menu = createRouteStopActions(value, '61C', routes, explore, announce);
  row.append(menu);
  document.body.append(row);
  (menu as HTMLDetailsElement).open = true;
  return {
    row,
    menu,
    explore,
    announce,
    openStop,
    save: menu.querySelector<HTMLButtonElement>('[data-explorer-save]')!
  };
}
beforeEach(() => {
  document.body.replaceChildren();
  localStorage.clear();
  jest.clearAllMocks();
  account('route-actions-' + ++sequence);
});

test('saving and removing a platform preserves its menu without opening arrivals', () => {
  const { menu, save, openStop, announce } = setup();
  save.focus();
  save.click();
  expect(getRiderShortcuts().stops[0].stopId).toBe('4407');
  expect(save.textContent).toBe('Saved');
  expect(save.getAttribute('aria-pressed')).toBe('true');
  expect(document.activeElement).toBe(save);
  expect((menu as HTMLDetailsElement).open).toBe(true);
  expect(announce).toHaveBeenLastCalledWith('Stop saved in My places.');
  save.click();
  expect(getRiderShortcuts().stops).toHaveLength(0);
  expect(save.getAttribute('aria-pressed')).toBe('false');
  expect(openStop).not.toHaveBeenCalled();
});

test('external shortcut changes and account changes update controls without replacing focus', () => {
  const { menu, save } = setup();
  const other = setup();
  save.focus();
  toggleSavedStop(stop);
  refreshRouteStopActions(document.body);
  expect(save.textContent).toBe('Saved');
  expect(other.save.textContent).toBe('Saved');
  const firstToken = localStorage.getItem('token')!;
  account('route-actions-another-' + sequence);
  refreshRouteStopActions(document.body);
  expect(save.textContent).toBe('Save stop');
  expect(document.activeElement).toBe(save);
  expect((menu as HTMLDetailsElement).open).toBe(true);
  localStorage.setItem('token', firstToken);
  refreshRouteStopActions(document.body);
  expect(save.textContent).toBe('Saved');
});

test('limit and invalid-stop errors remain visible without reporting a successful save', () => {
  for (let i = 0; i < 20; i++)
    toggleSavedStop({ ...stop, stopId: String(8000 + i) });
  const { save, announce } = setup();
  save.click();
  expect(save.getAttribute('aria-pressed')).toBe('false');
  expect(announce).toHaveBeenLastCalledWith(
    'You have 20 saved stops. Remove one to save another.'
  );
  const invalid = setup({ ...stop, lat: NaN });
  invalid.save.click();
  expect(invalid.announce).toHaveBeenLastCalledWith(
    'This stop cannot be saved yet.'
  );
});

test('offers each known connecting route once and preserves the chosen platform context', () => {
  const { menu, explore, openStop } = setup();
  const connections = [
    ...menu.querySelectorAll<HTMLButtonElement>('[data-explore-transfer]')
  ];
  expect(connections.map((button) => button.textContent)).toEqual([
    'Route 61D · Murray',
    'Campus Loop'
  ]);
  connections[0].click();
  expect(explore).toHaveBeenCalledWith('61D', stop);
  expect(openStop).not.toHaveBeenCalled();
});

test('route and platform names are rendered as text, with no invalid connection target', () => {
  const value = {
    ...stop,
    stopName: '<img src=x onerror=alert(1)>',
    routes: ['bad route', '61D']
  };
  const menu = createRouteStopActions(
    value,
    '61C',
    [route('bad route', 'Invalid'), route('61D', '<script>bad</script>')],
    jest.fn(),
    jest.fn()
  );
  document.body.append(menu);
  expect(menu.querySelector('img, script')).toBeNull();
  expect(menu.querySelectorAll('[data-explore-transfer]')).toHaveLength(1);
  expect(menu.querySelector('[data-explore-transfer]')!.textContent).toContain(
    '<script>bad</script>'
  );
});

test('sharing calls the existing public-stop helper synchronously from the tap', () => {
  const { menu, announce, openStop } = setup();
  const share = menu.querySelector<HTMLButtonElement>('[data-explorer-share]')!;
  share.click();
  expect(copyStopLink).toHaveBeenCalledWith('4407', share, announce);
  expect(openStop).not.toHaveBeenCalled();
});

test('explains an unavailable connecting-route catalog without inventing a target', () => {
  const menu = createRouteStopActions(stop, '61C', [], jest.fn(), jest.fn());
  expect(menu.textContent).toContain(
    'Connecting route details are not available yet.'
  );
  expect(menu.querySelectorAll('[data-explore-transfer]')).toHaveLength(0);
  const singleRoute = createRouteStopActions(
    { ...stop, routes: ['61C'] },
    '61C',
    [],
    jest.fn(),
    jest.fn()
  );
  expect(singleRoute.textContent).not.toContain('not available yet');
});

test('detached menus cannot save, share or navigate after a list refresh', () => {
  const { row, menu, save, explore } = setup();
  row.remove();
  save.click();
  menu.querySelector<HTMLButtonElement>('[data-explorer-share]')!.click();
  menu.querySelector<HTMLButtonElement>('[data-explore-transfer]')!.click();
  expect(getRiderShortcuts().stops).toHaveLength(0);
  expect(copyStopLink).not.toHaveBeenCalled();
  expect(explore).not.toHaveBeenCalled();
});

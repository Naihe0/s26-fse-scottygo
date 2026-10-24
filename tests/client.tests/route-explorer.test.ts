/** @jest-environment jsdom */
import '../../client/scripts/components/route-explorer';
import type { RouteExplorer } from '../../client/scripts/components/route-explorer';
import { MapStateManager } from '../../client/scripts/state/map-state';
import { transitApiService } from '../../client/scripts/services/transit-api.service';
import type { IRoute, IStop, IVehicle } from '../../common/transit.interface';

jest.mock('../../client/scripts/services/transit-api.service', () => ({
  transitApiService: { getStops: jest.fn() }
}));

const state = MapStateManager.getInstance();
const getStops = transitApiService.getStops as jest.Mock;
const route = (id = '61C', directions = ['INBOUND', 'OUTBOUND']): IRoute => ({
  id,
  name: `Route ${id}`,
  system: 'PRT',
  color: '#123456',
  directions,
  activeStatus: true,
  operatingDays: [1, 2, 3, 4, 5]
});
const stop = (id: string, name: string, lat = 40.44): IStop => ({
  stopId: id,
  stopName: name,
  lat,
  lon: -79.94,
  dtradd: [],
  dtrrem: []
});
const vehicle = (
  vid = '6001',
  direction: string | undefined = 'INBOUND'
): IVehicle => ({
  vid,
  direction,
  routeId: '61C',
  lat: 40.44,
  lon: -79.94,
  source: 'live',
  lastUpdate: '2026-10-24T12:00:00Z',
  isDetoured: false
});
const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

let explorer: RouteExplorer;
let selectedStop: jest.Mock;
beforeEach(() => {
  jest.clearAllMocks();
  state.resetFilters();
  state.updateFilters({
    plannedLocation: null,
    plannedLocationLabel: null,
    currentLocation: null
  });
  state.setAvailableRoutes([
    route(),
    route('61D'),
    route('CMU-1', ['OUTBOUND'])
  ]);
  getStops.mockResolvedValue([stop('s2', 'Zeta'), stop('s1', 'Alpha', 40.441)]);
  selectedStop = jest.fn();
  explorer = document.createElement('route-explorer') as RouteExplorer;
  explorer.configure({
    getOrigin: () => ({ lat: 40.44, lng: -79.94 }),
    onSelectStop: selectedStop
  });
  document.body.append(explorer);
});
afterEach(() => {
  document.body.replaceChildren();
  jest.useRealTimers();
});

function chooseRoute(id = '61C') {
  state.updateFilter('selectedRouteId', id);
}
async function open() {
  chooseRoute();
  explorer.open();
  await flush();
}
function direction(value: string) {
  const select = explorer.querySelector('select')!;
  select.value = value;
  select.dispatchEvent(new Event('change', { bubbles: true }));
}

test('only exposes the trigger for a selected route and loads stops on demand', async () => {
  expect(explorer.hidden).toBe(true);
  expect(getStops).not.toHaveBeenCalled();
  chooseRoute();
  expect(explorer.hidden).toBe(false);
  expect(getStops).not.toHaveBeenCalled();
  explorer
    .querySelector<HTMLButtonElement>('.route-explorer__trigger')!
    .click();
  expect(explorer.querySelector('dialog')!.open).toBe(true);
  expect(explorer.querySelector('[data-status]')!.textContent).toBe(
    'Loading stops…'
  );
  await flush();
  expect(getStops).toHaveBeenCalledWith(
    '61C',
    'INBOUND',
    expect.any(AbortSignal)
  );
  expect(explorer.querySelector('h2')!.textContent).toBe('Route 61C');
});

test('deduplicates stop sets and sorts alphabetically without claiming a travel sequence', async () => {
  getStops.mockResolvedValue([
    stop('s2', 'Zeta'),
    stop('s1', 'Alpha'),
    stop('s2', 'Zeta'),
    stop('bad', 'Invalid', NaN)
  ]);
  await open();
  expect(
    [...explorer.querySelectorAll('[data-stops] strong')].map(
      (item) => item.textContent
    )
  ).toEqual(['Alpha', 'Zeta']);
  expect(explorer.textContent).toContain('not in travel order');
  expect(explorer.querySelector('[data-status]')!.textContent).toBe('2 stops');
});

test('searches by stop name and ID while maintaining input focus', async () => {
  await open();
  const input = explorer.querySelector('input')!;
  input.focus();
  input.value = 's2';
  input.dispatchEvent(new Event('input'));
  expect(explorer.querySelectorAll('[data-stops] li')).toHaveLength(1);
  expect(explorer.querySelector('[data-stops] strong')!.textContent).toBe(
    'Zeta'
  );
  state.setActiveVehicles([vehicle()]);
  expect(document.activeElement).toBe(input);
  expect(input.value).toBe('s2');
  input.value = 'nowhere';
  input.dispatchEvent(new Event('input'));
  expect(explorer.querySelector('[data-status]')!.textContent).toBe(
    'No stops match your search.'
  );
});

test('selecting a stop closes the explorer and calls the configured map action', async () => {
  await open();
  explorer.querySelector<HTMLButtonElement>('[data-stops] button')!.click();
  expect(selectedStop).toHaveBeenCalledWith(stop('s1', 'Alpha', 40.441));
  expect(explorer.querySelector('dialog')!.open).toBe(false);
});

test('nearest boarding stop uses the selected direction and labels straight-line distance', async () => {
  state.updateFilter('plannedLocationLabel', 'CMU Campus');
  await open();
  const nearest = explorer.querySelector<HTMLElement>(
    '.route-explorer__nearest'
  )!;
  expect(nearest.hidden).toBe(false);
  expect(nearest.textContent).toContain(
    '0 m from CMU Campus · straight-line distance'
  );
  nearest.querySelector('button')!.click();
  expect(selectedStop).toHaveBeenCalledWith(stop('s2', 'Zeta'));
  explorer.configure({ getOrigin: () => null, onSelectStop: selectedStop });
  expect(nearest.hidden).toBe(true);
});

test('stop direction changes refetch stop sets while bus lists continue to respect map visibility', async () => {
  await open();
  state.setActiveVehicles([
    vehicle('in'),
    vehicle('out', 'OUTBOUND'),
    { ...vehicle('other'), routeId: '61D' }
  ]);
  expect(explorer.querySelector('[data-buses]')!.textContent).toContain(
    'Bus in'
  );
  direction('OUTBOUND');
  await flush();
  expect(getStops).toHaveBeenLastCalledWith(
    '61C',
    'OUTBOUND',
    expect.any(AbortSignal)
  );
  expect(explorer.querySelector('[data-buses]')!.textContent).toContain(
    'Bus out'
  );
  expect(explorer.querySelector('[data-buses]')!.textContent).toContain(
    'Bus in'
  );
  state.updateFilter('selectedDirections', { inbound: false, outbound: true });
  expect(explorer.querySelector('[data-buses]')!.textContent).not.toContain(
    'Bus in'
  );
  expect(explorer.querySelector('[data-buses]')!.textContent).toContain(
    'Bus out'
  );
  expect(explorer.querySelector('[data-buses]')!.textContent).not.toContain(
    'Bus other'
  );
  expect(explorer.textContent).toContain('Buses shown on map');
});

test('single-direction loop routes avoid a meaningless direction switch', async () => {
  chooseRoute('CMU-1');
  explorer.open();
  await flush();
  expect(explorer.querySelector('select')!.disabled).toBe(true);
  expect(getStops).toHaveBeenCalledWith(
    'CMU-1',
    'OUTBOUND',
    expect.any(AbortSignal)
  );
});

test('late route metadata repairs restored loop direction and title without reopening the explorer', async () => {
  state.setAvailableRoutes([]);
  chooseRoute('CMU-1');
  explorer.open();
  await flush();
  expect(explorer.querySelector('h2')!.textContent).toBe('CMU-1');
  expect(explorer.querySelector('select')!.value).toBe('INBOUND');
  state.setAvailableRoutes([
    { ...route('CMU-1', ['OUTBOUND']), system: 'CMU', name: 'West Loop' }
  ]);
  await flush();
  expect(explorer.querySelector('h2')!.textContent).toBe('West Loop');
  expect(explorer.querySelector('select')!.value).toBe('OUTBOUND');
  expect(explorer.querySelector('select')!.disabled).toBe(true);
  expect(getStops).toHaveBeenLastCalledWith(
    'CMU-1',
    'OUTBOUND',
    expect.any(AbortSignal)
  );
  const option = explorer.querySelector('option');
  const calls = getStops.mock.calls.length;
  state.setActiveVehicles([]);
  state.setAvailableRoutes([
    {
      ...route('CMU-1', ['OUTBOUND']),
      system: 'CMU',
      name: 'Updated West Loop'
    }
  ]);
  expect(explorer.querySelector('option')).toBe(option);
  expect(explorer.querySelector('h2')!.textContent).toBe('Updated West Loop');
  expect(getStops).toHaveBeenCalledTimes(calls);
});

test('metadata updates retain a valid rider-selected stop direction and input focus', async () => {
  await open();
  direction('OUTBOUND');
  await flush();
  const calls = getStops.mock.calls.length;
  const input = explorer.querySelector('input')!;
  input.value = 'Alpha';
  input.focus();
  state.setAvailableRoutes([route('61C', ['OUTBOUND', 'INBOUND'])]);
  expect(explorer.querySelector('select')!.value).toBe('OUTBOUND');
  expect(document.activeElement).toBe(input);
  expect(input.value).toBe('Alpha');
  expect(getStops).toHaveBeenCalledTimes(calls);
});

test('a slow previous direction cannot overwrite the newly selected stop set', async () => {
  let resolveOld!: (value: IStop[]) => void;
  getStops.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        resolveOld = resolve;
      })
  );
  chooseRoute();
  explorer.open();
  const oldSignal = getStops.mock.calls[0][2] as AbortSignal;
  direction('OUTBOUND');
  expect(oldSignal.aborted).toBe(true);
  await flush();
  resolveOld([stop('stale', 'Stale stop')]);
  await flush();
  expect(explorer.querySelector('[data-stops]')!.textContent).not.toContain(
    'Stale stop'
  );
  expect(explorer.querySelector('[data-stops]')!.textContent).toContain(
    'Alpha'
  );
});

test('failed loads have a retry action and distinguish a valid empty direction', async () => {
  getStops.mockResolvedValueOnce(null).mockResolvedValueOnce([]);
  await open();
  const retry = explorer.querySelector<HTMLButtonElement>('[data-retry]')!;
  expect(retry.hidden).toBe(false);
  expect(explorer.querySelector('[data-status]')!.textContent).toContain(
    'could not be loaded'
  );
  retry.click();
  await flush();
  expect(retry.hidden).toBe(true);
  expect(explorer.querySelector('[data-status]')!.textContent).toBe(
    'No stops available in this direction.'
  );
});

test('a hanging stop request becomes retryable after fifteen seconds', async () => {
  jest.useFakeTimers();
  getStops.mockImplementationOnce(() => new Promise(() => undefined));
  chooseRoute();
  explorer.open();
  jest.advanceTimersByTime(15_000);
  await flush();
  expect(
    explorer.querySelector<HTMLButtonElement>('[data-retry]')!.hidden
  ).toBe(false);
});

test('bus rows use reported timestamps, keep delayed buses, and dispatch the selected vehicle', async () => {
  jest.useFakeTimers().setSystemTime(new Date('2026-10-24T12:05:00Z'));
  await open();
  const event = jest.fn();
  explorer.addEventListener('selectBus', event);
  state.setActiveVehicles([
    vehicle(),
    vehicle(),
    { ...vehicle('unknown', undefined), lastUpdate: '' }
  ]);
  expect(explorer.querySelectorAll('[data-buses] li')).toHaveLength(2);
  expect(explorer.querySelector('[data-buses]')!.textContent).toContain(
    'delayed'
  );
  expect(explorer.querySelector('[data-buses]')!.textContent).toContain(
    'Report time unavailable'
  );
  explorer.querySelector<HTMLButtonElement>('[data-buses] button')!.click();
  expect(event.mock.calls[0][0].detail).toEqual({
    vid: '6001',
    routeId: '61C'
  });
  expect(explorer.querySelector('dialog')!.open).toBe(false);
});

test('full-route overview emits the selected route and dismisses the panel', async () => {
  await open();
  const listener = jest.fn();
  explorer.addEventListener('routeOverview', listener);
  explorer.querySelector<HTMLButtonElement>('[data-overview]')!.click();
  expect(listener.mock.calls[0][0].detail).toEqual({ routeId: '61C' });
  expect(explorer.querySelector('dialog')!.open).toBe(false);
});

test('vehicle refresh preserves a focused bus row and uses the current route after reassignment', async () => {
  await open();
  const listener = jest.fn();
  explorer.addEventListener('selectBus', listener);
  state.setActiveVehicles([vehicle()]);
  const busButton = explorer.querySelector<HTMLButtonElement>(
    '[data-buses] button'
  )!;
  busButton.focus();
  state.setActiveVehicles([
    { ...vehicle(), lastUpdate: '2026-10-24T12:01:00Z' }
  ]);
  expect(document.activeElement).toBe(busButton);
  state.updateFilters({
    selectedRouteId: '61D',
    activeVehicles: [{ ...vehicle(), routeId: '61D' }]
  });
  busButton.click();
  expect(listener.mock.calls[0][0].detail).toEqual({
    vid: '6001',
    routeId: '61D'
  });
});

test('regular bus refresh keeps keyboard focus on the nearest boarding action', async () => {
  await open();
  const nearestButton = explorer.querySelector<HTMLButtonElement>(
    '.route-explorer__nearest button'
  )!;
  nearestButton.focus();
  state.setActiveVehicles([vehicle()]);
  expect(document.activeElement).toBe(nearestButton);
});

test('Escape closes and returns focus, while clearing a route dismisses without hidden focus', async () => {
  await open();
  explorer
    .querySelector('dialog')!
    .dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })
    );
  expect(explorer.querySelector('dialog')!.open).toBe(false);
  expect(document.activeElement).toBe(
    explorer.querySelector('.route-explorer__trigger')
  );
  explorer.open();
  state.updateFilter('selectedRouteId', null);
  expect(explorer.hidden).toBe(true);
  expect(explorer.querySelector('dialog')!.open).toBe(false);
});

test('untrusted stop and vehicle text remains inert DOM text', async () => {
  getStops.mockResolvedValue([stop('unsafe', '<img src=x onerror=alert(1)>')]);
  await open();
  state.setActiveVehicles([vehicle('<script>alert(1)</script>')]);
  expect(explorer.querySelector('img, script')).toBeNull();
  expect(explorer.textContent).toContain('<img src=x onerror=alert(1)>');
});

test('detaching cancels pending renders and disconnects state listeners', async () => {
  let resolveStops!: (value: IStop[]) => void;
  getStops.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        resolveStops = resolve;
      })
  );
  chooseRoute();
  explorer.open();
  explorer.remove();
  resolveStops([stop('late', 'Late stop')]);
  state.updateFilter('selectedRouteId', '61D');
  await flush();
  expect(explorer.querySelector('[data-stops]')!.textContent).toBe('');
  expect(explorer.querySelector('h2')!.textContent).toBe('Route 61C');
});

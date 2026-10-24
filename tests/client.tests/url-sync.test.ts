/** @jest-environment jsdom */

import { MapStateManager } from '../../client/scripts/state/map-state';
import { URLSyncManager } from '../../client/scripts/state/url-sync';

const state = MapStateManager.getInstance();
const sync = URLSyncManager.getInstance();

beforeEach(() => {
  history.replaceState(null, '', '/');
  state.resetFilters();
  sync.initialize();
});

test('saved links round-trip calendar/time and explicitly disabled systems/directions', () => {
  state.updateFilters({
    selectedRouteId: 'CMU-B',
    selectedDate: new Date(2026, 8, 19),
    selectedTime: { hour: 12, minute: 5, period: 'AM' },
    selectedSystems: { prt: false, cmu: false },
    selectedDirections: { inbound: false, outbound: false }
  });
  sync.updateURL(state.getState());
  expect(window.location.hash).toContain('d=20260919');
  expect(window.location.hash).toContain('t=0005');
  state.resetFilters();
  sync.restoreStateFromURL();
  expect(state.getState()).toMatchObject({
    selectedRouteId: 'CMU-B',
    selectedDate: new Date(2026, 8, 19),
    selectedTime: { hour: 12, minute: 5, period: 'AM' },
    selectedSystems: { prt: false, cmu: false },
    selectedDirections: { inbound: false, outbound: false }
  });
});

test('restoring a default link clears the previous route and filters', () => {
  state.updateFilters({
    selectedRouteId: '61D',
    selectedSystems: { prt: false, cmu: true }
  });
  history.replaceState(null, '', '#/map');
  sync.restoreStateFromURL();
  expect(state.getState()).toMatchObject({
    selectedRouteId: null,
    selectedSystems: { prt: true, cmu: false }
  });
});

test('invalid calendar dates and times are ignored', () => {
  history.replaceState(null, '', '#/map?d=20260230&t=2599');
  expect(sync.restoreStateFromURL()).toMatchObject({
    selectedDate: null,
    selectedTime: null
  });
});

test('startup and passive canonical writes retain a valid stop alongside public filters', () => {
  history.replaceState(null, '', '#/map?stop=cmu%3A123-4&r=61C&dir=OB');
  sync.initialize();
  sync.updateURL(state.getState());
  const params = new URLSearchParams(window.location.hash.split('?')[1]);
  expect(params.get('stop')).toBe('cmu:123-4');
  expect(params.get('r')).toBe('61C');
  expect(params.get('dir')).toBe('OB');
  expect(state.getState()).not.toHaveProperty('selectedStopId');
  expect(state.getState()).not.toHaveProperty('stop');
});

test('setting or clearing a selected stop replaces the current entry without altering filters', () => {
  state.updateFilters({
    selectedRouteId: '61D',
    selectedSystems: { prt: true, cmu: true }
  });
  const before = state.getState();
  const length = history.length;
  sync.setSelectedStop('stop.123');
  expect(window.location.hash).toContain('stop=stop.123');
  expect(window.location.hash).toContain('r=61D');
  expect(window.location.hash).toContain('s=PRT%2CCMU');
  expect(state.getState()).toEqual(before);
  expect(history.length).toBe(length);
  sync.setSelectedStop(null);
  expect(window.location.hash).not.toContain('stop=');
  expect(window.location.hash).toContain('r=61D');
  expect(history.length).toBe(length);
});

test('push navigation clears the remembered stop and later replaces cannot resurrect it', () => {
  sync.setSelectedStop('123');
  state.updateFilter('selectedRouteId', '61C');
  sync.updateURL(state.getState(), 'push');
  expect(window.location.hash).toBe('#/map?r=61C');
  sync.updateURL(state.getState(), 'replace');
  expect(window.location.hash).toBe('#/map?r=61C');
});

test('copy-view links serialize filters alone while the address bar keeps the selected stop', () => {
  state.updateFilter('selectedRouteId', '61C');
  sync.setSelectedStop('private-choice');
  expect(sync.getViewLink(state.getState())).toBe(
    'http://localhost/#/map?r=61C'
  );
  expect(window.location.hash).toContain('stop=private-choice');
});

test.each(['', '../bad', 'space id', '<script>', 'x'.repeat(121)])(
  'invalid selected stop %s clears the previous selection instead of serializing it',
  (id) => {
    sync.setSelectedStop('123');
    sync.setSelectedStop(id);
    expect(window.location.hash).toBe('#/map');
  }
);

test.each([
  '#/map?stop=123&stop=456',
  '#/map?stop=123&stop=123',
  '#/map?stop=..%2Fbad',
  '#/map?stop=',
  '#/other?stop=123',
  '#/map?stop=123&extra=' + 'x'.repeat(2048)
])('restoring %s does not retain or resurrect an invalid stop', (hash) => {
  sync.setSelectedStop('old');
  history.replaceState(null, '', hash);
  sync.restoreStateFromURL();
  sync.updateURL(state.getState());
  expect(window.location.hash).toBe('#/map');
});

test('popstate and hashchange restore new stop selections once and clear them on a filter-only entry', () => {
  history.replaceState(null, '', '#/map?stop=123');
  sync.initialize();
  const onRestore = jest.fn();
  const unsubscribe = sync.onRestore(onRestore);
  try {
    history.replaceState(null, '', '#/map?r=61D&stop=456');
    window.dispatchEvent(new PopStateEvent('popstate'));
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    expect(onRestore).toHaveBeenCalledTimes(1);
    expect(state.getState().selectedRouteId).toBe('61D');
    sync.updateURL(state.getState());
    expect(window.location.hash).toContain('stop=456');
    history.replaceState(null, '', '#/map?r=61C');
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    expect(onRestore).toHaveBeenCalledTimes(2);
    sync.updateURL(state.getState());
    expect(window.location.hash).toBe('#/map?r=61C');
  } finally {
    unsubscribe();
  }
});

test('synchronous filter subscribers cannot remove a stop while URL restoration is in progress', () => {
  const unsubscribe = state.subscribe((snapshot) => sync.updateURL(snapshot));
  try {
    history.replaceState(null, '', '#/map?stop=cmu%3Anew&r=CMU-1');
    sync.restoreStateFromURL();
    expect(window.location.hash).toContain('stop=cmu%3Anew');
    expect(window.location.hash).toContain('r=CMU-1');
  } finally {
    unsubscribe();
  }
});

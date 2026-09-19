/** @jest-environment jsdom */

import { MapStateManager } from '../../client/scripts/state/map-state';
import { URLSyncManager } from '../../client/scripts/state/url-sync';

const state = MapStateManager.getInstance();
const sync = URLSyncManager.getInstance();

beforeEach(() => {
  history.replaceState(null, '', '/');
  state.resetFilters();
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

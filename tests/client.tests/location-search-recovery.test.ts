/** @jest-environment jsdom */

import '../../client/scripts/components/location-search';
import type { ILocationSearchElement } from '../../client/scripts/components/location-search';
import { MapStateManager } from '../../client/scripts/state/map-state';

const key = 'scottygo_planned_location';

beforeEach(() => {
  localStorage.clear();
  const state = MapStateManager.getInstance();
  state.resetPlannedLocationToCurrent();
  state.setGpsUnavailable();
});

afterEach(() => {
  document.body.replaceChildren();
  localStorage.clear();
});

function mount() {
  const parent = document.createElement('div');
  const search = document.createElement(
    'location-search'
  ) as ILocationSearchElement;
  const reset = jest.fn();
  const selected = jest.fn();
  parent.addEventListener('locationReset', reset);
  parent.addEventListener('locationSelected', selected);
  parent.appendChild(search);
  document.body.appendChild(parent);
  search.open();
  return { search, reset, selected };
}

test('Current Location requests GPS recovery instead of persisting the campus fallback', () => {
  const state = MapStateManager.getInstance();
  const { search, reset, selected } = mount();
  search.querySelector<HTMLElement>('.location-search-current')!.click();
  expect(reset).toHaveBeenCalledTimes(1);
  expect(selected).not.toHaveBeenCalled();
  expect(localStorage.getItem(key)).toBeNull();
  expect(state.hasCustomPlannedLocation()).toBe(false);
  expect(state.getEffectiveLocation()).toBeNull();
  expect(
    search.querySelector<HTMLElement>('.location-search-dropdown')!.hidden
  ).toBe(true);
  state.setCurrentLocation({ lat: 40.45, lng: -79.95 });
  expect(state.getEffectiveLocation()).toEqual({ lat: 40.45, lng: -79.95 });
});

test('Current Location clears a saved custom choice even while GPS is unavailable', () => {
  const state = MapStateManager.getInstance();
  state.setPlannedLocation({ lat: 40.4, lng: -79.9 }, 'Saved destination');
  const { search, reset, selected } = mount();
  search
    .querySelector<HTMLElement>('.location-search-current')!
    .dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })
    );
  expect(reset).toHaveBeenCalledTimes(1);
  expect(selected).not.toHaveBeenCalled();
  expect(localStorage.getItem(key)).toBeNull();
  expect(state.hasCustomPlannedLocation()).toBe(false);
  expect(state.getEffectiveLocation()).toBeNull();
});

test('Current Location uses a valid GPS fix and keeps following later fixes', () => {
  const state = MapStateManager.getInstance();
  state.setPlannedLocation({ lat: 40.4, lng: -79.9 }, 'Saved destination');
  state.setCurrentLocation({ lat: 40.45, lng: -79.95 });
  const { search, reset, selected } = mount();
  expect(
    search.querySelector('#location-search-current-sublabel')!.textContent
  ).toBe('Using GPS');
  search.querySelector<HTMLElement>('.location-search-current')!.click();
  expect(reset).toHaveBeenCalledTimes(1);
  expect(selected).not.toHaveBeenCalled();
  expect(state.getEffectiveLocation()).toEqual({ lat: 40.45, lng: -79.95 });
  expect(state.hasCustomPlannedLocation()).toBe(false);
  state.setCurrentLocation({ lat: 40.46, lng: -79.96 });
  expect(state.getEffectiveLocation()).toEqual({ lat: 40.46, lng: -79.96 });
});

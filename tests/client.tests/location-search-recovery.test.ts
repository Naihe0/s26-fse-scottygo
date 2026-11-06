/** @jest-environment jsdom */

import '../../client/scripts/components/location-search';
import type { ILocationSearchElement } from '../../client/scripts/components/location-search';
import { MapStateManager } from '../../client/scripts/state/map-state';
import { toggleSavedStop } from '../../client/scripts/utils/rider-shortcuts';

const key = 'scottygo:planned-location:v2:user%3Alocation-search-rider';

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem(
    'token',
    `header.${btoa(JSON.stringify({ userId: 'location-search-rider' }))}.signature`
  );
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

test('saved-place picker returns coordinates without changing the current trip or GPS eligibility', () => {
  const state = MapStateManager.getInstance();
  state.setPlannedLocation({ lat: 40.4, lng: -79.9 }, 'Existing trip');
  const { search, selected, reset } = mount();
  const chosen = jest.fn();
  search.pick(chosen);
  search.querySelector<HTMLButtonElement>('[data-campus]')!.click();
  expect(chosen).toHaveBeenCalledWith(
    expect.objectContaining({ label: 'CMU campus' })
  );
  expect(state.getState().plannedLocationLabel).toBe('Existing trip');
  expect(state.getState().gpsPermissionGranted).toBe(false);
  expect(selected).not.toHaveBeenCalled();
  expect(reset).not.toHaveBeenCalled();
});

test('saved-place picker cancels once and unavailable GPS keeps the draft choice open', () => {
  const { search, selected, reset } = mount();
  const chosen = jest.fn();
  search.pick(chosen);
  search.querySelector<HTMLElement>('.location-search-current')!.click();
  expect(search.querySelector('[data-current-start]')!.textContent).toContain(
    'GPS is unavailable'
  );
  expect(chosen).not.toHaveBeenCalled();
  expect(reset).not.toHaveBeenCalled();
  search.querySelector<HTMLButtonElement>('[data-close-start]')!.click();
  search.close();
  expect(chosen).toHaveBeenCalledTimes(1);
  expect(chosen).toHaveBeenCalledWith(null);
  search.open();
  search.querySelector<HTMLButtonElement>('[data-campus]')!.click();
  expect(selected).toHaveBeenCalledTimes(1);
});

test('using a saved platform provides a walking origin without granting GPS', () => {
  toggleSavedStop({
    stopId: '7117',
    stopName: 'Forbes & Morewood',
    lat: 40.44,
    lon: -79.94,
    routes: ['61C']
  });
  const { search, selected } = mount();
  const select = search.querySelector<HTMLSelectElement>('[data-start-stop]')!;
  expect(select.selectedOptions[0].textContent).toContain('#7117');
  search.querySelector<HTMLButtonElement>('[data-use-stop]')!.click();
  const state = MapStateManager.getInstance();
  expect(selected).toHaveBeenCalledTimes(1);
  expect(state.getEffectiveLocation()).toEqual({ lat: 40.44, lng: -79.94 });
  expect(state.getState().gpsPermissionGranted).toBe(false);
  search.open();
  expect(search.querySelector('[data-current-start]')!.textContent).toContain(
    'Forbes & Morewood'
  );
});

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

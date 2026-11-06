/** @jest-environment jsdom */
import {
  nearbyBearing,
  nearbySaveButton
} from '../../client/scripts/components/nearby-stop-actions';
import { isStopSaved } from '../../client/scripts/utils/rider-shortcuts';
const stop = {
  stopId: '7117',
  stopName: 'Forbes & Morewood',
  lat: 40.441,
  lon: -79.94,
  dtradd: [],
  dtrrem: []
};

test('save a nearby platform and undo it without opening its map card', () => {
  const row = document.createElement('li'),
    open = jest.fn();
  row.addEventListener('click', open);
  const button = nearbySaveButton(stop);
  row.append(button);
  button.click();
  expect(button.getAttribute('aria-pressed')).toBe('true');
  expect(isStopSaved(stop.stopId)).toBe(true);
  expect(nearbySaveButton(stop).textContent).toBe('Saved');
  button.click();
  expect(isStopSaved(stop.stopId)).toBe(false);
  expect(open).not.toHaveBeenCalled();
});

test.each([
  [40.44, -79.941, 138, 'NE'],
  [40.45, -79.94, 1000, 'S'],
  [40.441, -79.941, 20, ''],
  [NaN, -79.94, 80, '']
])('direction from %s, %s at %s m is %s', (lat, lng, distance, dir) => {
  expect(
    nearbyBearing(
      { lat: Number(lat), lng: Number(lng) },
      stop,
      Number(distance)
    )
  ).toBe(dir);
});

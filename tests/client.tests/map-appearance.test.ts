/** @jest-environment jsdom */
import {
  DEFAULT_MAP_APPEARANCE,
  normalizeMapAppearance
} from '../../common/map-appearance';

let preferences: typeof import('../../client/scripts/utils/map-appearance');
beforeEach(async () => {
  jest.resetModules();
  localStorage.clear();
  preferences = await import('../../client/scripts/utils/map-appearance');
});
afterEach(() => jest.restoreAllMocks());

test.each([
  null,
  [],
  '',
  { base: 'data:image', overlay: 'unknown', contrast: 'true' }
])('invalid or old data produces supported defaults (%p)', (value) => {
  expect(normalizeMapAppearance(value)).toEqual(DEFAULT_MAP_APPEARANCE);
});

test('only cosmetic preferences persist and later readers receive independent copies', () => {
  const chosen = {
    base: 'satellite',
    overlay: 'traffic',
    contrast: true
  } as const;
  expect(preferences.writeMapAppearance(chosen)).toBe(true);
  expect(preferences.readMapAppearance()).toEqual(chosen);
  const first = preferences.readMapAppearance();
  first.overlay = 'bike';
  expect(preferences.readMapAppearance().overlay).toBe('traffic');
  expect(
    JSON.parse(localStorage.getItem('scottygo.mapAppearance.v1')!)
  ).toEqual(chosen);
  localStorage.setItem('token', 'different-account');
  expect(preferences.readMapAppearance()).toEqual(chosen);
});

test('blocked writes retain the latest choice in this page and return a persistence failure', () => {
  const set = jest
    .spyOn(Storage.prototype, 'setItem')
    .mockImplementation(() => {
      throw new Error('Blocked');
    });
  const choice = { base: 'road', overlay: 'bike', contrast: true } as const;
  expect(preferences.writeMapAppearance(choice)).toBe(false);
  expect(preferences.readMapAppearance()).toEqual(choice);
  set.mockRestore();
  expect(preferences.writeMapAppearance({ ...choice, overlay: 'none' })).toBe(
    true
  );
  expect(preferences.readMapAppearance().overlay).toBe('none');
});

test('malformed stored JSON falls back and blocked reads use the last successful setting', () => {
  localStorage.setItem('scottygo.mapAppearance.v1', '{invalid');
  expect(preferences.readMapAppearance()).toEqual(DEFAULT_MAP_APPEARANCE);
  preferences.writeMapAppearance({
    base: 'road',
    overlay: 'transit',
    contrast: false
  });
  jest.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
    throw new Error('Blocked');
  });
  expect(preferences.readMapAppearance().overlay).toBe('transit');
});

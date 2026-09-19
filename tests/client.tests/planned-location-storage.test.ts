/** @jest-environment jsdom */

const key = 'scottygo_planned_location';

beforeEach(() => {
  jest.resetModules();
  localStorage.clear();
});

afterEach(() => jest.restoreAllMocks());

async function bootState() {
  const { MapStateManager } =
    await import('../../client/scripts/state/map-state');
  const state = MapStateManager.getInstance();
  state.setGpsDenied();
  return state;
}

test('a saved planned location survives reload and GPS denial', async () => {
  localStorage.setItem(
    key,
    JSON.stringify({ lat: 40.4433, lng: -79.9436, label: '  CMU Campus  ' })
  );
  const state = await bootState();
  expect(state.getState()).toMatchObject({
    plannedLocation: { lat: 40.4433, lng: -79.9436 },
    plannedLocationLabel: 'CMU Campus'
  });
});

test.each([
  'not JSON',
  'null',
  '[]',
  '{"lat":1e400,"lng":0,"label":"Overflow"}',
  JSON.stringify({ lat: 91, lng: 0, label: 'Bad latitude' }),
  JSON.stringify({ lat: 0, lng: -181, label: 'Bad longitude' }),
  JSON.stringify({ lat: '40', lng: -79, label: 'Old value' }),
  JSON.stringify({ lat: 40, lng: -79, label: '  ' }),
  JSON.stringify({ lat: 40, lng: -79, label: 'x'.repeat(513) })
])('invalid saved location falls back to the campus map: %s', async (raw) => {
  localStorage.setItem(key, raw);
  const state = await bootState();
  expect(state.getEffectiveLocation()).toEqual({ lat: 40.4433, lng: -79.9436 });
  expect(state.getState().plannedLocationLabel).toBe('CMU Campus');
});

test.each([
  { lat: 0, lng: 0 },
  { lat: -90, lng: 180 },
  { lat: 90, lng: -180 }
])('geographic boundary values remain valid: %o', async (location) => {
  localStorage.setItem(
    key,
    JSON.stringify({ ...location, label: 'Saved destination' })
  );
  expect((await bootState()).getEffectiveLocation()).toEqual(location);
});

test('blocked storage does not prevent the map from finding a fallback location', async () => {
  jest.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
    throw new DOMException('Unavailable');
  });
  expect((await bootState()).getEffectiveLocation()).toEqual({
    lat: 40.4433,
    lng: -79.9436
  });
});

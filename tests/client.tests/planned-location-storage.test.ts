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
  expect(state.hasCustomPlannedLocation()).toBe(true);
  state.setCurrentLocation({ lat: 40.45, lng: -79.95 });
  expect(state.getEffectiveLocation()).toEqual({ lat: 40.4433, lng: -79.9436 });
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
  expect(state.hasCustomPlannedLocation()).toBe(false);
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

test('GPS recovery replaces the automatic campus fallback and continues following fixes', async () => {
  const state = await bootState();
  expect(state.hasCustomPlannedLocation()).toBe(false);
  expect(localStorage.getItem(key)).toBeNull();
  state.setCurrentLocation({ lat: 40.45, lng: -79.95 });
  expect(state.getState()).toMatchObject({
    currentLocation: { lat: 40.45, lng: -79.95 },
    plannedLocation: { lat: 40.45, lng: -79.95 },
    plannedLocationLabel: 'Current Location',
    gpsPermissionGranted: true
  });
  state.setCurrentLocation({ lat: 40.46, lng: -79.96 });
  expect(state.getEffectiveLocation()).toEqual({ lat: 40.46, lng: -79.96 });
  expect(state.hasCustomPlannedLocation()).toBe(false);
  expect(localStorage.getItem(key)).toBeNull();
});

test.each(['CMU Campus', 'Current Location', 'My chosen place'])(
  'GPS recovery preserves an explicitly selected place even when its label is %s',
  async (label) => {
    const state = await bootState();
    const custom = { lat: 40.4433, lng: -79.9436 };
    state.setPlannedLocation(custom, label);
    state.setGpsUnavailable();
    state.setCurrentLocation({ lat: 40.45, lng: -79.95 });
    expect(state.hasCustomPlannedLocation()).toBe(true);
    expect(state.getEffectiveLocation()).toEqual(custom);
    expect(state.getState().plannedLocationLabel).toBe(label);
    expect(JSON.parse(localStorage.getItem(key)!)).toEqual({
      ...custom,
      label
    });
  }
);

test('revoking GPS after a fix invalidates the old automatic location and can recover', async () => {
  const state = await bootState();
  state.setCurrentLocation({ lat: 40.45, lng: -79.95 });
  state.setGpsUnavailable();
  expect(state.getState()).toMatchObject({
    currentLocation: null,
    gpsPermissionGranted: false,
    plannedLocation: { lat: 40.4433, lng: -79.9436 },
    plannedLocationLabel: 'CMU Campus'
  });
  expect(state.hasCustomPlannedLocation()).toBe(false);
  state.setCurrentLocation({ lat: 40.46, lng: -79.96 });
  expect(state.getEffectiveLocation()).toEqual({ lat: 40.46, lng: -79.96 });
});

test('revoking GPS preserves a custom selection while discarding the old current fix', async () => {
  const state = await bootState();
  state.setCurrentLocation({ lat: 40.45, lng: -79.95 });
  state.setPlannedLocation({ lat: 40.4, lng: -79.9 }, 'Chosen place');
  state.setGpsDenied();
  expect(state.getState()).toMatchObject({
    currentLocation: null,
    gpsPermissionGranted: false,
    plannedLocation: { lat: 40.4, lng: -79.9 },
    plannedLocationLabel: 'Chosen place'
  });
  expect(state.hasCustomPlannedLocation()).toBe(true);
});

test('resetting an explicit place resumes current GPS and removes the persisted choice', async () => {
  const state = await bootState();
  state.setPlannedLocation({ lat: 40.4, lng: -79.9 }, 'Chosen place');
  state.setCurrentLocation({ lat: 40.45, lng: -79.95 });
  state.resetPlannedLocationToCurrent();
  expect(state.hasCustomPlannedLocation()).toBe(false);
  expect(state.getEffectiveLocation()).toEqual({ lat: 40.45, lng: -79.95 });
  expect(state.getState().plannedLocationLabel).toBe('Current Location');
  expect(localStorage.getItem(key)).toBeNull();
  state.setCurrentLocation({ lat: 40.46, lng: -79.96 });
  expect(state.getEffectiveLocation()).toEqual({ lat: 40.46, lng: -79.96 });
});

test('resetting without GPS clears the explicit place so the next fix can recover', async () => {
  const state = await bootState();
  state.setPlannedLocation({ lat: 40.4, lng: -79.9 }, 'Chosen place');
  state.resetPlannedLocationToCurrent();
  expect(state.getEffectiveLocation()).toBeNull();
  expect(state.getState().plannedLocationLabel).toBeNull();
  expect(state.hasCustomPlannedLocation()).toBe(false);
  expect(localStorage.getItem(key)).toBeNull();
  state.setGpsUnavailable();
  expect(state.hasCustomPlannedLocation()).toBe(false);
  state.setCurrentLocation({ lat: 40.46, lng: -79.96 });
  expect(state.getEffectiveLocation()).toEqual({ lat: 40.46, lng: -79.96 });
});

test('clearing route filters preserves explicit versus automatic planned-location provenance', async () => {
  const state = await bootState();
  state.resetFilters();
  expect(state.hasCustomPlannedLocation()).toBe(false);
  state.setPlannedLocation({ lat: 40.4433, lng: -79.9436 }, 'CMU Campus');
  state.resetFilters();
  expect(state.hasCustomPlannedLocation()).toBe(true);
  state.setCurrentLocation({ lat: 40.45, lng: -79.95 });
  expect(state.getEffectiveLocation()).toEqual({ lat: 40.4433, lng: -79.9436 });
});

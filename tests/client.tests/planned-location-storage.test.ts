/** @jest-environment jsdom */

const scopedKey = (userId: string) =>
  `scottygo:planned-location:v2:${encodeURIComponent(`user:${userId}`)}`;
const key = scopedKey('account-a');
const unsubscribers: Array<() => void> = [];
function tokenFor(userId: unknown, username = 'alice') {
  return `header.${btoa(JSON.stringify({ userId, username }))}.signature`;
}
function signIn(userId: string, username = 'alice') {
  localStorage.setItem('token', tokenFor(userId, username));
  localStorage.setItem('username', username);
}
function switchAccountInAnotherTab(userId: string | null) {
  const oldValue = localStorage.getItem('token');
  if (userId) signIn(userId);
  else localStorage.removeItem('token');
  window.dispatchEvent(
    new StorageEvent('storage', {
      key: 'token',
      oldValue,
      newValue: localStorage.getItem('token'),
      storageArea: localStorage
    })
  );
}

beforeEach(() => {
  jest.resetModules();
  localStorage.clear();
  signIn('account-a');
});

afterEach(() => {
  unsubscribers.splice(0).forEach((unsubscribe) => unsubscribe());
  jest.restoreAllMocks();
});

async function bootState() {
  const { MapStateManager } =
    await import('../../client/scripts/state/map-state');
  const state = MapStateManager.getInstance();
  state.setGpsUnavailable();
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
  state.setGpsUnavailable();
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

test('never reads or migrates an old global private destination', async () => {
  localStorage.setItem(
    'scottygo_planned_location',
    JSON.stringify({ lat: 40.4, lng: -79.9, label: 'Previous rider home' })
  );
  const state = await bootState();
  expect(state.hasCustomPlannedLocation()).toBe(false);
  expect(state.getState().plannedLocationLabel).toBe('CMU Campus');
  expect(localStorage.getItem(key)).toBeNull();
});

test('reloading restores only the current immutable account destination', async () => {
  const state = await bootState();
  state.setPlannedLocation({ lat: 40.4, lng: -79.9 }, 'A home');
  jest.resetModules();
  expect((await bootState()).getState().plannedLocationLabel).toBe('A home');
  signIn('account-b', 'alice');
  jest.resetModules();
  expect((await bootState()).hasCustomPlannedLocation()).toBe(false);
  expect(localStorage.getItem(scopedKey('account-b'))).toBeNull();
});

test('renaming an account and refreshing its token retain the same private destination', async () => {
  const state = await bootState();
  state.setPlannedLocation({ lat: 40.4, lng: -79.9 }, 'A home');
  signIn('account-a', 'alice-renamed');
  expect(state.getState().plannedLocationLabel).toBe('A home');
  expect(state.hasCustomPlannedLocation()).toBe(true);
  expect(
    Object.keys(localStorage).filter((item) =>
      item.includes('planned-location')
    )
  ).toEqual([key]);
  signIn('account-b', 'alice');
  expect(state.hasCustomPlannedLocation()).toBe(false);
});

test('cross-tab account changes immediately restore the new plan and preserve GPS and filters', async () => {
  const state = await bootState();
  const current = { lat: 40.45, lng: -79.95 };
  state.setCurrentLocation(current);
  state.updateFilter('selectedRouteId', '61C');
  state.setPlannedLocation({ lat: 40.4, lng: -79.9 }, 'A home');
  localStorage.setItem(
    scopedKey('account-b'),
    JSON.stringify({ lat: 40.5, lng: -79.8, label: 'B work' })
  );
  const listener = jest.fn();
  unsubscribers.push(state.subscribe(listener));
  switchAccountInAnotherTab('account-b');
  expect(listener).toHaveBeenCalledTimes(1);
  expect(listener).toHaveBeenLastCalledWith(
    expect.objectContaining({
      currentLocation: current,
      gpsPermissionGranted: true,
      selectedRouteId: '61C',
      plannedLocation: { lat: 40.5, lng: -79.8 },
      plannedLocationLabel: 'B work'
    })
  );
  switchAccountInAnotherTab('account-a');
  expect(listener).toHaveBeenCalledTimes(2);
  expect(state.getState().plannedLocationLabel).toBe('A home');
});

test('switching to an account without a plan resumes the existing GPS fix and subsequent fixes', async () => {
  const state = await bootState();
  state.setCurrentLocation({ lat: 40.45, lng: -79.95 });
  state.setPlannedLocation({ lat: 40.4, lng: -79.9 }, 'A home');
  const listener = jest.fn();
  unsubscribers.push(state.subscribe(listener));
  switchAccountInAnotherTab('account-b');
  expect(listener).toHaveBeenLastCalledWith(
    expect.objectContaining({
      plannedLocation: { lat: 40.45, lng: -79.95 },
      plannedLocationLabel: 'Current Location',
      gpsPermissionGranted: true
    })
  );
  expect(state.hasCustomPlannedLocation()).toBe(false);
  state.setCurrentLocation({ lat: 40.46, lng: -79.96 });
  expect(state.getEffectiveLocation()).toEqual({ lat: 40.46, lng: -79.96 });
  expect(localStorage.getItem(scopedKey('account-b'))).toBeNull();
});

test('cross-tab logout clears private state and keeps the automatic campus fallback without GPS', async () => {
  const state = await bootState();
  state.setPlannedLocation({ lat: 40.4, lng: -79.9 }, 'A home');
  const listener = jest.fn();
  unsubscribers.push(state.subscribe(listener));
  switchAccountInAnotherTab(null);
  expect(listener).toHaveBeenCalledTimes(1);
  expect(listener).toHaveBeenLastCalledWith(
    expect.objectContaining({
      currentLocation: null,
      gpsPermissionGranted: false,
      plannedLocationLabel: 'CMU Campus'
    })
  );
  expect(state.hasCustomPlannedLocation()).toBe(false);
});

test('same-tab selection and reset write only the latest account even without storage events', async () => {
  const state = await bootState();
  state.setPlannedLocation({ lat: 40.4, lng: -79.9 }, 'A home');
  signIn('account-b');
  state.setPlannedLocation({ lat: 40.5, lng: -79.8 }, 'B work');
  expect(JSON.parse(localStorage.getItem(key)!).label).toBe('A home');
  expect(JSON.parse(localStorage.getItem(scopedKey('account-b'))!).label).toBe(
    'B work'
  );
  state.resetPlannedLocationToCurrent();
  expect(localStorage.getItem(scopedKey('account-b'))).toBeNull();
  expect(JSON.parse(localStorage.getItem(key)!).label).toBe('A home');
});

test.each([
  null,
  'opaque-session',
  'header.not-base64.signature',
  `header.${btoa('null')}.signature`,
  `header.${btoa('[]')}.signature`,
  `header.${btoa('{}')}.signature`,
  tokenFor(123),
  tokenFor('account/a'),
  tokenFor(''),
  tokenFor('a'.repeat(129)),
  `header.${btoa(JSON.stringify({ userId: 'account-a' }))}`
])(
  'missing or malformed account sessions never persist a planned address: %s',
  async (token) => {
    if (token === null) localStorage.removeItem('token');
    else localStorage.setItem('token', token);
    const state = await bootState();
    state.setPlannedLocation({ lat: 40.4, lng: -79.9 }, 'Temporary place');
    expect(state.getState().plannedLocationLabel).toBe('Temporary place');
    expect(
      Object.keys(localStorage).filter((item) => item.includes('planned'))
    ).toEqual([]);
    jest.resetModules();
    expect((await bootState()).hasCustomPlannedLocation()).toBe(false);
  }
);

test('two unrecognized sessions do not share temporary planned locations', async () => {
  localStorage.setItem('token', 'opaque-a');
  const state = await bootState();
  state.setPlannedLocation({ lat: 40.4, lng: -79.9 }, 'Temporary home');
  localStorage.setItem('token', 'opaque-b');
  expect(state.getState().plannedLocationLabel).toBe('CMU Campus');
  expect(state.hasCustomPlannedLocation()).toBe(false);
});

test('unsubscribing removes the account listener and subsequent reads still check account identity', async () => {
  const state = await bootState();
  state.setPlannedLocation({ lat: 40.4, lng: -79.9 }, 'A home');
  const listener = jest.fn();
  const unsubscribe = state.subscribe(listener);
  unsubscribe();
  switchAccountInAnotherTab('account-b');
  expect(listener).not.toHaveBeenCalled();
  expect(state.getState().plannedLocationLabel).toBe('CMU Campus');
  expect(state.hasCustomPlannedLocation()).toBe(false);
});

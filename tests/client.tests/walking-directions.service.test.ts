/** @jest-environment jsdom */

import {
  DIRECTIONS_TIMEOUT_MS,
  requestWalkingDirections
} from '../../client/scripts/services/walking-directions.service';

const origin = { lat: 40.443, lng: -79.943 };
const destination = { lat: 40.444, lng: -79.942 };
const path = [origin, destination];
const validRoute = {
  path,
  durationMillis: 125_500,
  distanceMeters: 170,
  warnings: ['Walking directions may not reflect real-world conditions.']
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('walking directions Routes adapter', () => {
  let computeRoutes: jest.Mock;
  let importLibrary: jest.Mock;
  let controller: AbortController;
  let removeAbortListener: jest.SpyInstance;
  let originalGoogle: PropertyDescriptor | undefined;

  beforeEach(() => {
    jest.useFakeTimers();
    originalGoogle = Object.getOwnPropertyDescriptor(globalThis, 'google');
    computeRoutes = jest.fn().mockResolvedValue({ routes: [validRoute] });
    importLibrary = jest.fn().mockResolvedValue({ Route: { computeRoutes } });
    Object.defineProperty(globalThis, 'google', {
      configurable: true,
      value: { maps: { importLibrary } }
    });
    controller = new AbortController();
    removeAbortListener = jest.spyOn(controller.signal, 'removeEventListener');
  });

  afterEach(() => {
    const remainingTimers = jest.getTimerCount();
    jest.clearAllTimers();
    jest.useRealTimers();
    jest.restoreAllMocks();
    if (originalGoogle) {
      Object.defineProperty(globalThis, 'google', originalGoogle);
    } else {
      Reflect.deleteProperty(globalThis, 'google');
    }
    expect(remainingTimers).toBe(0);
  });

  test('requests a WALKING route and converts milliseconds while preserving warnings', async () => {
    await expect(
      requestWalkingDirections(origin, destination, controller.signal)
    ).resolves.toEqual({
      polyline: path,
      durationSeconds: 125.5,
      distanceMeters: 170,
      warnings: validRoute.warnings
    });
    expect(importLibrary).toHaveBeenCalledWith('routes');
    expect(computeRoutes).toHaveBeenCalledWith({
      origin,
      destination,
      travelMode: 'WALKING',
      fields: ['path', 'durationMillis', 'distanceMeters', 'warnings']
    });
    expect(removeAbortListener).toHaveBeenCalledWith(
      'abort',
      expect.any(Function)
    );
  });

  test('uses the first route and defaults omitted warnings to an empty list', async () => {
    computeRoutes.mockResolvedValue({
      routes: [
        {
          ...validRoute,
          durationMillis: 0,
          distanceMeters: 0,
          warnings: undefined
        },
        validRoute
      ]
    });
    await expect(
      requestWalkingDirections(origin, destination, controller.signal)
    ).resolves.toEqual({
      polyline: path,
      durationSeconds: 0,
      distanceMeters: 0,
      warnings: []
    });
  });

  test('accepts SDK path coordinates exposed through numeric getters', async () => {
    class SdkPoint {
      constructor(
        private latitude: number,
        private longitude: number
      ) {}

      get lat() {
        return this.latitude;
      }
      get lng() {
        return this.longitude;
      }
    }
    computeRoutes.mockResolvedValue({
      routes: [
        {
          ...validRoute,
          path: path.map((point) => new SdkPoint(point.lat, point.lng))
        }
      ]
    });
    await expect(
      requestWalkingDirections(origin, destination, controller.signal)
    ).resolves.toMatchObject({ polyline: path, durationSeconds: 125.5 });
  });

  test.each(['library', 'computation'])(
    'propagates a rejected %s request and releases resources',
    async (stage) => {
      const failure = new Error('The Routes API denied the request.');
      (stage === 'library' ? importLibrary : computeRoutes).mockRejectedValue(
        failure
      );
      await expect(
        requestWalkingDirections(origin, destination, controller.signal)
      ).rejects.toBe(failure);
      expect(removeAbortListener).toHaveBeenCalledWith(
        'abort',
        expect.any(Function)
      );
    }
  );

  test.each([
    ['missing routes', {}],
    ['empty routes', { routes: [] }],
    ['empty path', { routes: [{ ...validRoute, path: [] }] }],
    [
      'nonfinite latitude',
      { routes: [{ ...validRoute, path: [{ lat: NaN, lng: 0 }] }] }
    ],
    [
      'nonfinite longitude',
      { routes: [{ ...validRoute, path: [{ lat: 0, lng: Infinity }] }] }
    ],
    [
      'missing duration',
      { routes: [{ ...validRoute, durationMillis: undefined }] }
    ],
    ['negative duration', { routes: [{ ...validRoute, durationMillis: -1 }] }],
    [
      'nonfinite duration',
      { routes: [{ ...validRoute, durationMillis: Infinity }] }
    ],
    ['negative distance', { routes: [{ ...validRoute, distanceMeters: -1 }] }],
    ['nonfinite distance', { routes: [{ ...validRoute, distanceMeters: NaN }] }]
  ])(
    'rejects %s instead of returning unusable directions',
    async (_label, response) => {
      computeRoutes.mockResolvedValue(response);
      await expect(
        requestWalkingDirections(origin, destination, controller.signal)
      ).rejects.toThrow('No walking route was found for this stop.');
      expect(removeAbortListener).toHaveBeenCalledWith(
        'abort',
        expect.any(Function)
      );
    }
  );

  test('reports unavailable directions when the Google SDK is absent', async () => {
    Reflect.deleteProperty(globalThis, 'google');
    await expect(
      requestWalkingDirections(origin, destination, controller.signal)
    ).rejects.toThrow('Walking directions are unavailable. Please try again.');
  });

  test('rejects an already aborted signal without loading the SDK or creating timers', async () => {
    controller.abort();
    await expect(
      requestWalkingDirections(origin, destination, controller.signal)
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(importLibrary).not.toHaveBeenCalled();
    expect(computeRoutes).not.toHaveBeenCalled();
  });

  test('aborts during library loading and never starts the delayed route computation', async () => {
    const library = deferred<unknown>();
    importLibrary.mockReturnValue(library.promise);
    const onResolved = jest.fn();
    const onRejected = jest.fn();
    const result = requestWalkingDirections(
      origin,
      destination,
      controller.signal
    ).then(onResolved, onRejected);
    controller.abort();
    await result;
    expect(onRejected).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'AbortError' })
    );
    library.resolve({ Route: { computeRoutes } });
    await jest.advanceTimersByTimeAsync(0);
    expect(computeRoutes).not.toHaveBeenCalled();
    expect(onResolved).not.toHaveBeenCalled();
    expect(onRejected).toHaveBeenCalledTimes(1);
    expect(removeAbortListener).toHaveBeenCalledWith(
      'abort',
      expect.any(Function)
    );
  });

  test.each(['resolve', 'reject'])(
    'ignores a delayed route %s after abort',
    async (completion) => {
      const route = deferred<unknown>();
      computeRoutes.mockReturnValue(route.promise);
      const onResolved = jest.fn();
      const onRejected = jest.fn();
      const result = requestWalkingDirections(
        origin,
        destination,
        controller.signal
      ).then(onResolved, onRejected);
      await jest.advanceTimersByTimeAsync(0);
      expect(computeRoutes).toHaveBeenCalledTimes(1);
      controller.abort();
      await result;
      expect(onRejected).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'AbortError' })
      );
      if (completion === 'resolve') route.resolve({ routes: [validRoute] });
      else route.reject(new Error('A late SDK failure'));
      await jest.advanceTimersByTimeAsync(0);
      expect(onResolved).not.toHaveBeenCalled();
      expect(onRejected).toHaveBeenCalledTimes(1);
      expect(removeAbortListener).toHaveBeenCalledWith(
        'abort',
        expect.any(Function)
      );
    }
  );

  test('times out at 15 seconds even when the routes library never finishes loading', async () => {
    const library = deferred<unknown>();
    importLibrary.mockReturnValue(library.promise);
    const onResolved = jest.fn();
    const onRejected = jest.fn();
    const result = requestWalkingDirections(
      origin,
      destination,
      controller.signal
    ).then(onResolved, onRejected);
    expect(DIRECTIONS_TIMEOUT_MS).toBe(15_000);
    await jest.advanceTimersByTimeAsync(14_999);
    expect(onRejected).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1);
    await result;
    expect(onRejected).toHaveBeenCalledWith(
      new Error('Walking directions timed out. Please try again.')
    );
    library.resolve({ Route: { computeRoutes } });
    await jest.advanceTimersByTimeAsync(0);
    expect(computeRoutes).not.toHaveBeenCalled();
    expect(onResolved).not.toHaveBeenCalled();
    expect(onRejected).toHaveBeenCalledTimes(1);
    expect(removeAbortListener).toHaveBeenCalledWith(
      'abort',
      expect.any(Function)
    );
  });

  test.each(['resolve', 'reject'])(
    'ignores a delayed route %s after the shared 15-second deadline',
    async (completion) => {
      const library = deferred<unknown>();
      const route = deferred<unknown>();
      importLibrary.mockReturnValue(library.promise);
      computeRoutes.mockReturnValue(route.promise);
      const onResolved = jest.fn();
      const onRejected = jest.fn();
      const result = requestWalkingDirections(
        origin,
        destination,
        controller.signal
      ).then(onResolved, onRejected);
      await jest.advanceTimersByTimeAsync(5_000);
      library.resolve({ Route: { computeRoutes } });
      await jest.advanceTimersByTimeAsync(9_999);
      expect(computeRoutes).toHaveBeenCalledTimes(1);
      expect(onRejected).not.toHaveBeenCalled();
      await jest.advanceTimersByTimeAsync(1);
      await result;
      expect(onRejected).toHaveBeenCalledWith(
        new Error('Walking directions timed out. Please try again.')
      );
      if (completion === 'resolve') route.resolve({ routes: [validRoute] });
      else route.reject(new Error('A late SDK failure'));
      await jest.advanceTimersByTimeAsync(0);
      expect(onResolved).not.toHaveBeenCalled();
      expect(onRejected).toHaveBeenCalledTimes(1);
      expect(removeAbortListener).toHaveBeenCalledWith(
        'abort',
        expect.any(Function)
      );
    }
  );
});

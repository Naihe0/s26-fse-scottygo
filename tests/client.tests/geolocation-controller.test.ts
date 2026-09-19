/** @jest-environment jsdom */

import { GeolocationController } from '../../client/scripts/services/geolocation-controller';

type RegisteredWatch = {
  success: PositionCallback;
  error: PositionErrorCallback;
};

function position(latitude = 40.44): GeolocationPosition {
  return {
    coords: {
      latitude,
      longitude: -79.94,
      accuracy: 12,
      altitude: null,
      altitudeAccuracy: null,
      heading: null,
      speed: null
    },
    timestamp: 123
  } as GeolocationPosition;
}

function error(code: number): GeolocationPositionError {
  return {
    code,
    message: 'Provider detail',
    PERMISSION_DENIED: 1,
    POSITION_UNAVAILABLE: 2,
    TIMEOUT: 3
  };
}

describe('GeolocationController', () => {
  let watches: RegisteredWatch[];
  let geolocation: Geolocation;
  let watchPosition: jest.Mock;
  let clearWatch: jest.Mock;
  let onPosition: jest.Mock;
  let onError: jest.Mock;
  let controller: GeolocationController;

  beforeEach(() => {
    watches = [];
    watchPosition = jest.fn(
      (success: PositionCallback, failure: PositionErrorCallback) => {
        watches.push({ success, error: failure });
        return watches.length - 1;
      }
    );
    clearWatch = jest.fn();
    geolocation = { watchPosition, clearWatch, getCurrentPosition: jest.fn() };
    onPosition = jest.fn();
    onError = jest.fn();
    controller = new GeolocationController(
      { onPosition, onError },
      geolocation
    );
  });

  test('repeated start owns one watch with bounded, fresh high-accuracy options', () => {
    controller.start();
    controller.start();
    controller.start();
    expect(watchPosition).toHaveBeenCalledTimes(1);
    expect(watchPosition.mock.calls[0][2]).toEqual({
      enableHighAccuracy: true,
      maximumAge: 5_000,
      timeout: 20_000
    });
    watches[0].success(position());
    expect(onPosition).toHaveBeenCalledWith(position());
  });

  test('denial stops its watch and explicit retry can recover', () => {
    controller.start();
    watches[0].error(error(1));
    expect(onError).toHaveBeenCalledWith('denied');
    expect(clearWatch).toHaveBeenCalledWith(0);
    controller.start();
    expect(watchPosition).toHaveBeenCalledTimes(1);
    watches[0].success(position());
    expect(onPosition).not.toHaveBeenCalled();
    controller.retry();
    watches[1].success(position(41));
    expect(watchPosition).toHaveBeenCalledTimes(2);
    expect(onPosition).toHaveBeenCalledWith(position(41));
    expect(clearWatch).toHaveBeenCalledTimes(1);
  });

  test.each([
    [2, 'unavailable'],
    [3, 'timeout'],
    [99, 'unavailable']
  ])(
    'error code %s reports %s and leaves the watch alive for recovery',
    (code, expected) => {
      controller.start();
      watches[0].error(error(code as number));
      expect(onError).toHaveBeenCalledWith(expected);
      expect(clearWatch).not.toHaveBeenCalled();
      watches[0].success(position());
      expect(onPosition).toHaveBeenCalledWith(position());
      expect(watchPosition).toHaveBeenCalledTimes(1);
    }
  );

  test('suppresses repeated error kinds until success or retry', () => {
    controller.start();
    watches[0].error(error(3));
    watches[0].error(error(3));
    watches[0].error(error(2));
    watches[0].error(error(3));
    expect(onError.mock.calls).toEqual([['timeout'], ['unavailable']]);
    watches[0].success(position());
    watches[0].error(error(3));
    expect(onError).toHaveBeenCalledTimes(3);
    controller.retry();
    watches[1].error(error(3));
    expect(onError).toHaveBeenCalledTimes(4);
  });

  test('retry ignores stale success and error callbacks from the previous watch', () => {
    controller.start();
    controller.retry();
    watches[0].success(position());
    watches[0].error(error(1));
    expect(onPosition).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
    expect(clearWatch).toHaveBeenCalledWith(0);
    watches[1].success(position(42));
    expect(onPosition).toHaveBeenCalledWith(position(42));
  });

  test('stop is idempotent and ignores late callbacks, including callbacks during clearWatch', () => {
    controller.start();
    clearWatch.mockImplementation(() => watches[0].success(position()));
    controller.stop();
    controller.stop();
    watches[0].error(error(1));
    expect(clearWatch).toHaveBeenCalledTimes(1);
    expect(onPosition).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
    controller.start();
    expect(watchPosition).toHaveBeenCalledTimes(2);
  });

  test('unsupported geolocation is graceful and deduplicated until retry', () => {
    controller = new GeolocationController({ onPosition, onError }, undefined);
    controller.start();
    controller.start();
    expect(onError.mock.calls).toEqual([['unsupported']]);
    controller.retry();
    expect(onError.mock.calls).toEqual([['unsupported'], ['unsupported']]);
    expect(onPosition).not.toHaveBeenCalled();
  });

  test('a throwing request reports unavailable and can be retried', () => {
    watchPosition.mockImplementationOnce(() => {
      throw new Error('Request blocked');
    });
    expect(() => controller.start()).not.toThrow();
    expect(onError).toHaveBeenCalledWith('unavailable');
    controller.start();
    expect(watchPosition).toHaveBeenCalledTimes(1);
    controller.retry();
    watches[0].success(position());
    expect(onPosition).toHaveBeenCalledWith(position());
  });

  test('synchronous denial clears the watch after its ID becomes available', () => {
    watchPosition.mockImplementationOnce(
      (_success: PositionCallback, failure: PositionErrorCallback) => {
        failure(error(1));
        return 77;
      }
    );
    controller.start();
    expect(onError).toHaveBeenCalledWith('denied');
    expect(clearWatch).toHaveBeenCalledWith(77);
    controller.stop();
    expect(clearWatch).toHaveBeenCalledTimes(1);
  });

  test('synchronous success may stop before the returned watch ID is assigned', () => {
    watchPosition.mockImplementationOnce((success: PositionCallback) => {
      success(position());
      return 77;
    });
    onPosition.mockImplementation(() => controller.stop());
    controller.start();
    expect(clearWatch).toHaveBeenCalledWith(77);
    expect(onPosition).toHaveBeenCalledTimes(1);
  });

  test('synchronous retry cannot replace the new watch with the old returned ID', () => {
    watchPosition.mockImplementationOnce((success: PositionCallback) => {
      success(position());
      return 77;
    });
    onPosition.mockImplementationOnce(() => controller.retry());
    controller.start();
    expect(watchPosition).toHaveBeenCalledTimes(2);
    expect(clearWatch).toHaveBeenCalledWith(77);
    watches[0].success(position(43));
    expect(onPosition).toHaveBeenLastCalledWith(position(43));
    controller.stop();
    expect(clearWatch.mock.calls).toEqual([[77], [0]]);
  });

  test('a stale throwing request cannot stop a watch created by a synchronous retry', () => {
    watchPosition.mockImplementationOnce((success: PositionCallback) => {
      success(position());
      throw new Error('Old provider failure');
    });
    onPosition.mockImplementationOnce(() => controller.retry());
    controller.start();
    expect(onError).not.toHaveBeenCalled();
    watches[0].success(position(44));
    expect(onPosition).toHaveBeenLastCalledWith(position(44));
  });

  test('clearWatch exceptions do not revive a stopped attempt', () => {
    controller.start();
    clearWatch.mockImplementation(() => {
      throw new Error('Already closed');
    });
    expect(() => controller.stop()).not.toThrow();
    watches[0].success(position());
    watches[0].error(error(2));
    expect(onPosition).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });
});

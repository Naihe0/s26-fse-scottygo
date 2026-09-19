/** @jest-environment jsdom */

import { PredictionController } from '../../client/scripts/controllers/prediction-controller';
import type { IStop, IPrediction } from '../../common/transit.interface';
const mockPredictions = jest.fn();
const mockStartDirections = jest.fn().mockResolvedValue(false);
jest.mock('../../client/scripts/services/transit-api.service', () => ({
  transitApiService: {
    getPredictions: (...args: unknown[]) => mockPredictions(...args)
  }
}));
jest.mock('../../client/scripts/renderers/route-renderer', () => ({
  RouteRenderer: { getInstance: () => ({}) }
}));
jest.mock('../../client/scripts/trackers/vehicle-tracker', () => ({
  VehicleTracker: { getInstance: () => ({}) }
}));
jest.mock('../../client/scripts/controllers/directions-controller', () => ({
  DirectionsController: {
    getInstance: () => ({
      isActive: false,
      startDirections: (...args: unknown[]) => mockStartDirections(...args)
    })
  }
}));

describe('prediction refresh contents', () => {
  const controller = PredictionController.getInstance();
  const stop: IStop = {
    stopId: 'refresh',
    stopName: 'Refresh',
    lat: 40,
    lon: -79
  };
  const first: IPrediction = {
    stopId: 'refresh',
    routeId: '61D',
    vid: '111',
    predictedArrivalTime: Date.now() + 120000,
    minutes: 2,
    isDelayed: false
  };
  const second: IPrediction = { ...first, vid: '222' };
  beforeEach(() => {
    jest.useFakeTimers();
    mockPredictions.mockReset();
    mockStartDirections.mockClear();
    document.body.innerHTML = '<div class="map-container"></div>';
  });
  afterEach(() => {
    controller.stopPolling();
    jest.clearAllTimers();
    jest.useRealTimers();
    document.body.innerHTML = '';
  });

  test('an initially empty popup gains arrivals after a successful refresh', async () => {
    mockPredictions
      .mockResolvedValueOnce([])
      .mockResolvedValue([first, second]);
    await controller.handleStopClick(stop);
    expect(document.querySelector('.map-popup__empty')).not.toBeNull();
    await jest.advanceTimersByTimeAsync(30000);
    expect(document.querySelectorAll('.map-popup__arrival')).toHaveLength(2);
    expect(document.querySelector('.map-popup__empty')).toBeNull();
  });

  test('selected buses remain the same when refreshed arrivals change order', async () => {
    mockPredictions
      .mockResolvedValueOnce([first, second])
      .mockResolvedValue([second, first]);
    await controller.handleStopClick(stop);
    document.querySelectorAll<HTMLElement>('.map-popup__arrival')[1].click();
    await jest.advanceTimersByTimeAsync(30000);
    const rows = document.querySelectorAll('.map-popup__arrival');
    expect(rows[0].getAttribute('aria-pressed')).toBe('true');
    expect(rows[1].getAttribute('aria-pressed')).toBe('false');
    document
      .querySelector<HTMLButtonElement>('.map-popup__directions-btn')!
      .click();
    expect(mockStartDirections).toHaveBeenCalledWith(stop, [second]);
  });
});

describe('stop prediction request ownership', () => {
  const controller = PredictionController.getInstance();
  const first: IStop = {
    stopId: 'first',
    stopName: 'First',
    lat: 40,
    lon: -79
  };
  const second: IStop = { ...first, stopId: 'second', stopName: 'Second' };
  let show: jest.SpyInstance;
  beforeEach(() => {
    controller.stopPolling();
    mockPredictions.mockReset();
    show = jest
      .spyOn(
        controller as unknown as {
          showStopPopup(stop: IStop, predictions: IPrediction[]): void;
        },
        'showStopPopup'
      )
      .mockImplementation(() => undefined);
  });
  afterEach(() => {
    show.mockRestore();
    controller.stopPolling();
  });

  test('an earlier clicked stop cannot replace a newer stop popup', async () => {
    let finishFirst!: (predictions: IPrediction[]) => void;
    mockPredictions
      .mockReturnValueOnce(
        new Promise((resolve) => {
          finishFirst = resolve;
        })
      )
      .mockResolvedValueOnce([]);
    const firstRequest = controller.handleStopClick(first);
    await controller.handleStopClick(second);
    finishFirst([]);
    await firstRequest;
    expect(show).toHaveBeenCalledTimes(1);
    expect(show).toHaveBeenCalledWith(second, []);
  });

  test('clearing the map cancels a stop popup that is still loading', async () => {
    let finish!: (predictions: IPrediction[]) => void;
    mockPredictions.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      })
    );
    const request = controller.handleStopClick(first);
    controller.stopPolling();
    finish([]);
    await request;
    expect(show).not.toHaveBeenCalled();
  });
});

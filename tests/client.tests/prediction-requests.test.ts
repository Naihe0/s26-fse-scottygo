/** @jest-environment jsdom */

import { PredictionController } from '../../client/scripts/controllers/prediction-controller';
import type { IStop, IPrediction } from '../../common/transit.interface';
import { keyArrivalRows } from '../../client/scripts/utils/arrival-identity';
const mockPredictions = jest.fn();
const mockStartDirections = jest.fn().mockResolvedValue(false);
jest.mock('../../client/scripts/services/transit-api.service', () => ({
  transitApiService: {
    getArrivalSnapshot: async (...args: unknown[]) => {
      const result = await mockPredictions(...args);
      return Array.isArray(result) ? { rows: result, state: 'ready' } : result;
    }
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
    dtradd: [],
    dtrrem: [],
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
    Object.defineProperty(document, 'hidden', {
      configurable: true,
      value: false
    });
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

  test('the first successful prediction feed distinguishes warmup, paused cached arrivals and healthy empty service', async () => {
    mockPredictions
      .mockResolvedValueOnce({ state: 'warming', rows: [] })
      .mockResolvedValueOnce({ state: 'ready', rows: [first] })
      .mockResolvedValueOnce({ state: 'unavailable', rows: [] })
      .mockResolvedValueOnce({ state: 'ready', rows: [] });
    await controller.handleStopClick(stop);
    const notice = document.querySelector<HTMLElement>('.arrival-recovery')!;
    expect(notice.textContent).toContain('Waiting for the first');
    expect(
      document.querySelector<HTMLElement>('.map-popup__empty')!.hidden
    ).toBe(true);
    const retry = notice.querySelector('button')!;
    retry.click();
    await jest.advanceTimersByTimeAsync(1);
    expect(notice.hidden).toBe(true);
    await jest.advanceTimersByTimeAsync(30_000);
    expect(notice.textContent).toContain('last known');
    expect(document.querySelector('time')!.textContent).toContain(' ET');
    retry.click();
    await jest.advanceTimersByTimeAsync(1);
    expect(notice.hidden).toBe(true);
    expect(
      document.querySelector<HTMLElement>('.map-popup__empty')!.hidden
    ).toBe(false);
  });

  test('failed refresh keeps the selected bus and displays a last-known time until reconnection', async () => {
    mockPredictions
      .mockResolvedValueOnce([first])
      .mockResolvedValueOnce(null)
      .mockResolvedValue([]);
    await controller.handleStopClick(stop);
    document.querySelector<HTMLElement>('.map-popup__arrival')!.click();
    await jest.advanceTimersByTimeAsync(30000);
    expect(
      document.querySelector<HTMLElement>('.arrival-recovery')!.hidden
    ).toBe(false);
    expect(
      document
        .querySelector('.map-popup__arrival')!
        .getAttribute('aria-pressed')
    ).toBe('true');
    expect(document.querySelector('.map-popup__minutes')!.textContent).toMatch(
      /:/
    );
    window.dispatchEvent(new Event('online'));
    await jest.advanceTimersByTimeAsync(1);
    expect(
      document.querySelector<HTMLElement>('.arrival-recovery')!.hidden
    ).toBe(true);
    expect(
      document.querySelector<HTMLElement>('.map-popup__empty')!.hidden
    ).toBe(false);
  });

  test('directions retain the selected bus and its unavailable-feed status', async () => {
    mockPredictions.mockResolvedValue({ state: 'unavailable', rows: [first] });
    await controller.handleStopClick(stop);
    document.querySelector<HTMLButtonElement>('[data-key]')!.click();
    document
      .querySelector<HTMLButtonElement>('.map-popup__directions-btn')!
      .click();
    expect(mockStartDirections).toHaveBeenCalledWith(stop, [first], false, {
      keys:[...keyArrivalRows([first]).values()],checkedAt:null,routeId:undefined
    });
  });

  test('an initial failure offers retry and coalesces a double tap and reconnect', async () => {
    let finish!: (p: IPrediction[]) => void;
    mockPredictions.mockResolvedValueOnce(null).mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      })
    );
    await controller.handleStopClick(stop);
    expect(
      document.querySelector<HTMLElement>('.map-popup__empty')!.hidden
    ).toBe(true);
    const retry = document.querySelector<HTMLButtonElement>(
      '.arrival-recovery button'
    )!;
    retry.focus();
    retry.click();
    retry.click();
    window.dispatchEvent(new Event('online'));
    expect(mockPredictions).toHaveBeenCalledTimes(2);
    finish([first]);
    await jest.advanceTimersByTimeAsync(1);
    expect(document.querySelector('.map-popup__arrival')).not.toBeNull();
    expect(document.activeElement).toBe(
      document.querySelector('.map-popup__arrival')
    );
    expect(
      document.querySelector<HTMLElement>('.arrival-recovery')!.hidden
    ).toBe(true);
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
    expect(mockStartDirections).toHaveBeenCalledWith(stop, [second], true, {
      keys:[keyArrivalRows([second,first]).get(second)],checkedAt:Date.now(),routeId:undefined
    });
  });

  test('route filtering and paging keep the selected arrivals for directions, including after minimize', async () => {
    const arrivals = Array.from({ length: 14 }, (_, index) => ({
      ...first,
      routeId: index % 2 ? '61C' : '61A',
      vid: String(index),
      predictedArrivalTime: Date.now() + (index + 1) * 60000
    }));
    mockPredictions.mockResolvedValue(arrivals);
    await controller.handleStopClick(stop);
    const rows = () =>
      Array.from(
        document.querySelectorAll<HTMLButtonElement>('.map-popup__arrival')
      );
    expect(rows()).toHaveLength(8);
    const paging = () =>
      document.querySelector<HTMLButtonElement>('.arrival-board__more')!;
    paging().focus();
    await jest.advanceTimersByTimeAsync(30_000);
    expect(document.activeElement).toBe(paging());
    paging().click();
    rows()[13].click();
    const route = document.querySelector<HTMLSelectElement>('[data-route]')!;
    route.value = '61A';
    route.dispatchEvent(new Event('change'));
    expect(rows()).toHaveLength(7);
    rows()[0].click();
    document.querySelector<HTMLButtonElement>('.map-popup__minimize')!.click();
    await controller.handleStopClick(stop);
    expect(
      document.querySelector<HTMLSelectElement>('[data-route]')!.value
    ).toBe('61A');
    const directions = document.querySelector<HTMLButtonElement>(
      '.map-popup__directions-btn'
    )!;
    directions.click();
    expect(mockStartDirections).toHaveBeenCalledWith(
      stop,
      [arrivals[0], arrivals[13]],
      true,
      {keys:[keyArrivalRows(arrivals).get(arrivals[0]),keyArrivalRows(arrivals).get(arrivals[13])],
        checkedAt:Date.now(),routeId:undefined}
    );
    document.querySelector<HTMLButtonElement>('[data-clear]')!.click();
    directions.click();
    expect(mockStartDirections).toHaveBeenLastCalledWith(stop, [], true, {keys:[],checkedAt:Date.now(),routeId:undefined});
  });

  test('walking receives the full-board identity when selecting one of two visits by the same bus', async () => {
    const later = {...first,predictedArrivalTime:first.predictedArrivalTime+600_000};
    mockPredictions.mockResolvedValue([first,later]);
    await controller.handleStopClick(stop);
    document.querySelectorAll<HTMLButtonElement>('[data-key]')[1].click();
    document.querySelector<HTMLButtonElement>('.map-popup__directions-btn')!.click();
    const fullBoardKey = keyArrivalRows([first,later]).get(later);
    expect(fullBoardKey).not.toEqual(keyArrivalRows([later]).get(later));
    expect(mockStartDirections).toHaveBeenLastCalledWith(stop,[later],true, {
      keys:[fullBoardKey],checkedAt:Date.now(),routeId:undefined
    });
  });

  test('manual refresh updates the checked time and preserves the Pittsburgh time display', async () => {
    jest.setSystemTime(new Date('2026-11-05T20:00:00Z'));
    mockPredictions.mockResolvedValue([
      { ...first, predictedArrivalTime: Date.now() + 120_000 },
      { ...second, predictedArrivalTime: '2026-11-05T21:00:00Z' }
    ]);
    await controller.handleStopClick(stop);
    const stamp = () => document.querySelector('[data-checked]')!.textContent;
    expect(stamp()).toContain('3:00 PM ET');
    document.querySelector<HTMLInputElement>('[data-clock]')!.click();
    expect(document.querySelector('time')!.textContent).toBe('3:02 PM ET');
    expect(document.querySelectorAll('time')).toHaveLength(1);
    jest.setSystemTime(new Date('2026-11-05T20:01:00Z'));
    document.querySelector<HTMLButtonElement>('[data-refresh]')!.click();
    await jest.advanceTimersByTimeAsync(1);
    expect(mockPredictions).toHaveBeenCalledTimes(2);
    expect(stamp()).toContain('3:01 PM ET');
    expect(document.querySelector('time')!.textContent).toBe('3:02 PM ET');
  });

  test('restoring a minimized stop revokes another pending selection without leaving it stuck', async () => {
    mockPredictions.mockResolvedValueOnce([]);
    await controller.handleStopClick(stop);
    document.querySelector<HTMLButtonElement>('.map-popup__minimize')!.click();
    expect(controller.hasActiveSelection).toBe(false);
    let finish!: (predictions: IPrediction[]) => void;
    mockPredictions.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      })
    );
    const request = controller.handleStopClick({ ...stop, stopId: 'another' });
    expect(controller.hasActiveSelection).toBe(true);
    await controller.handleStopClick(stop);
    expect(controller.hasActiveSelection).toBe(true);
    document.querySelector<HTMLButtonElement>('.map-popup__minimize')!.click();
    expect(controller.hasActiveSelection).toBe(false);
    finish([]);
    await request;
    expect(controller.hasActiveSelection).toBe(false);
  });

  test.each(['minimized', 'hidden'] as const)(
    'a %s departure watch waits for its fresh response before resuming reminders',
    async (state) => {
      const startedAt = Date.now();
      const row = {
        ...first,
        occurrenceId: 'watched-visit',
        predictedArrivalTime: startedAt + 180_000
      };
      let finish!: (rows: IPrediction[]) => void;
      mockPredictions.mockResolvedValueOnce([row]).mockReturnValueOnce(
        new Promise((resolve) => {
          finish = resolve;
        })
      );
      await controller.handleStopClick(stop);
      document.querySelector<HTMLButtonElement>('[data-key]')!.click();
      document
        .querySelector<HTMLButtonElement>('[data-watch-selected]')!
        .click();
      const reminder = document.querySelector<HTMLSelectElement>(
        '[data-watch-reminder]'
      )!;
      reminder.value = '2';
      reminder.dispatchEvent(new Event('change'));
      if (state === 'minimized')
        document
          .querySelector<HTMLButtonElement>('.map-popup__minimize')!
          .click();
      else {
        Object.defineProperty(document, 'hidden', {
          configurable: true,
          value: true
        });
        document.dispatchEvent(new Event('visibilitychange'));
      }
      jest.setSystemTime(startedAt + 60_000);
      if (state === 'minimized') await controller.handleStopClick(stop);
      else {
        Object.defineProperty(document, 'hidden', {
          configurable: true,
          value: false
        });
        document.dispatchEvent(new Event('visibilitychange'));
      }
      expect(mockPredictions).toHaveBeenCalledTimes(2);
      await jest.advanceTimersByTimeAsync(1_000);
      expect(
        document.querySelector('[data-watch-status]')?.textContent
      ).toContain('Waiting for fresh');
      expect(document.body.textContent).not.toContain('expected within');
      finish([row]);
      await jest.advanceTimersByTimeAsync(1);
      expect(document.querySelector('[data-watch-status]')?.textContent).toBe(
        'Route 61D is expected within 2 min.'
      );
      expect(
        document.querySelector('[data-watch-countdown]')?.textContent
      ).toBe('2 min');
    }
  );
});

describe('stop prediction request ownership', () => {
  const controller = PredictionController.getInstance();
  const first: IStop = {
    stopId: 'first',
    stopName: 'First',
    dtradd: [],
    dtrrem: [],
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
    expect(show).toHaveBeenCalledWith(second, { rows: [], state: 'ready' });
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

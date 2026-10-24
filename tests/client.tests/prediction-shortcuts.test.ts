/** @jest-environment jsdom */
import { PredictionController } from '../../client/scripts/controllers/prediction-controller';
import {
  dismissPopup,
  restorePopup
} from '../../client/scripts/utils/map-popup';
import {
  getRiderShortcuts,
  isStopSaved,
  removeShortcut
} from '../../client/scripts/utils/rider-shortcuts';
import type { IStop, IPrediction } from '../../common/transit.interface';

const mockPredictions = jest.fn();
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
  DirectionsController: { getInstance: () => ({ isActive: false }) }
}));
jest.mock('../../client/scripts/utils/toast', () => ({ showToast: jest.fn() }));

describe('stop card personal shortcuts', () => {
  const controller = PredictionController.getInstance();
  const stop: IStop = {
    stopId: '123',
    stopName: 'Forbes & Morewood',
    lat: 40.44,
    lon: -79.94,
    routes: ['61C'],
    dtradd: [],
    dtrrem: []
  };
  let account = 0;
  const originalClipboard = Object.getOwnPropertyDescriptor(
    navigator,
    'clipboard'
  );
  const save = () =>
    document.querySelector<HTMLButtonElement>('.map-popup__save-stop')!;
  const share = () =>
    document.querySelector<HTMLButtonElement>('.map-popup__share-stop')!;
  const minimize = () =>
    document.querySelector<HTMLButtonElement>('.map-popup__minimize')!.click();
  beforeEach(() => {
    jest.useFakeTimers();
    localStorage.clear();
    localStorage.setItem('username', `prediction-shortcuts-${++account}`);
    localStorage.setItem(
      'token',
      `header.${btoa(JSON.stringify({ userId: `prediction-shortcuts-${account}` }))}.signature`
    );
    controller.stopPolling();
    controller.setSelectionCallback(() => undefined);
    dismissPopup();
    document.body.innerHTML = '<div class="map-container"></div>';
    mockPredictions.mockReset().mockResolvedValue([]);
  });
  afterEach(() => {
    controller.stopPolling();
    dismissPopup();
    document.body.innerHTML = '';
    jest.clearAllTimers();
    jest.useRealTimers();
    if (originalClipboard)
      Object.defineProperty(navigator, 'clipboard', originalClipboard);
    else Reflect.deleteProperty(navigator, 'clipboard');
  });

  test('successful stop selection records a recent stop and save toggles immediately', async () => {
    await controller.handleStopClick(stop);
    expect(getRiderShortcuts().recent[0]).toEqual(
      expect.objectContaining({ kind: 'stop', id: 'stop:123' })
    );
    expect(save().getAttribute('aria-pressed')).toBe('false');
    save().click();
    expect(isStopSaved('123')).toBe(true);
    expect(save().textContent).toContain('Saved');
    expect(save().getAttribute('aria-pressed')).toBe('true');
    save().click();
    expect(isStopSaved('123')).toBe(false);
  });

  test('external saved-stop removal updates the open card', async () => {
    await controller.handleStopClick(stop);
    save().click();
    removeShortcut('stop', '123');
    expect(save().getAttribute('aria-pressed')).toBe('false');
    expect(save().textContent).toContain('Save stop');
  });

  test('minimize and restore rebind once and refresh saved state', async () => {
    await controller.handleStopClick(stop);
    save().click();
    const oldSave = save();
    minimize();
    removeShortcut('stop', '123');
    oldSave.click();
    expect(isStopSaved('123')).toBe(false);
    restorePopup('stop');
    expect(save().getAttribute('aria-pressed')).toBe('false');
    save().click();
    expect(isStopSaved('123')).toBe(true);
    minimize();
    restorePopup('stop');
    save().click();
    expect(isStopSaved('123')).toBe(false);
    expect(getRiderShortcuts().recent).toHaveLength(1);
    expect(
      document.querySelectorAll('.map-popup__shortcut-actions')
    ).toHaveLength(1);
  });

  test('restoring via the stop marker retains the shortcut actions', async () => {
    await controller.handleStopClick(stop);
    minimize();
    await controller.handleStopClick(stop);
    save().click();
    expect(isStopSaved('123')).toBe(true);
    expect(getRiderShortcuts().recent).toHaveLength(1);
  });

  test('shares the public stop once while a copy is pending, including after restoration', async () => {
    let finish!: () => void;
    const clipboard = jest.fn<Promise<void>, [string]>(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        })
    );
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: clipboard }
    });
    await controller.handleStopClick(stop);
    share().click();
    share().click();
    expect(clipboard).toHaveBeenCalledTimes(1);
    expect(clipboard.mock.calls[0][0]).toMatch(/\/#\/map\?stop=123$/);
    finish();
    await Promise.resolve();
    await Promise.resolve();
    minimize();
    restorePopup('stop');
    share().click();
    expect(clipboard).toHaveBeenCalledTimes(2);
    finish();
    await Promise.resolve();
  });

  test('closing a stop card during denied clipboard access does not reopen a copy dialog', async () => {
    let fail!: (error: Error) => void;
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: () =>
          new Promise<void>((_resolve, reject) => {
            fail = reject;
          })
      }
    });
    await controller.handleStopClick(stop);
    share().click();
    document.querySelector<HTMLButtonElement>('.map-popup__close')!.click();
    fail(new Error('Denied'));
    await Promise.resolve();
    await Promise.resolve();
    expect(document.getElementById('copy-view-link-dialog')).toBeNull();
  });

  test('restoring during an unfinished copy does not leave the new Share button disabled', async () => {
    let finish!: () => void;
    const clipboard = jest.fn<Promise<void>, [string]>(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: clipboard }
    });
    await controller.handleStopClick(stop);
    share().click();
    expect(share().disabled).toBe(true);
    minimize();
    restorePopup('stop');
    expect(share().disabled).toBe(false);
    finish();
    await Promise.resolve();
  });

  test('a cancelled stop lookup does not enter recent history', async () => {
    let finish!: (predictions: IPrediction[]) => void;
    mockPredictions.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      })
    );
    const pending = controller.handleStopClick(stop);
    controller.stopPolling();
    finish([]);
    await pending;
    expect(getRiderShortcuts().recent).toEqual([]);
    expect(save()).toBeNull();
  });

  test('explicit marker and restored-tab selections notify navigation, while prediction refresh does not', async () => {
    const selected = jest.fn();
    controller.setSelectionCallback(selected);
    await controller.handleStopClick(stop);
    expect(selected).toHaveBeenCalledTimes(1);
    expect(selected).toHaveBeenCalledWith(stop);
    await jest.advanceTimersByTimeAsync(30_000);
    expect(selected).toHaveBeenCalledTimes(1);
    minimize();
    restorePopup('stop');
    expect(selected).toHaveBeenCalledTimes(2);
    save().click();
    expect(selected).toHaveBeenCalledTimes(2);
  });
});

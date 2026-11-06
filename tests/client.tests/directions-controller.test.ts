/** @jest-environment jsdom */

import { DirectionsController } from '../../client/scripts/controllers/directions-controller';
import {
  requestWalkingDirections,
  IDirectionsResult
} from '../../client/scripts/services/walking-directions.service';
import type { IMapProvider, IMapPolyline } from '../../common/map.interface';
import type { IStop, IPrediction } from '../../common/transit.interface';
import { transitApiService, type IArrivalSnapshot } from '../../client/scripts/services/transit-api.service';
import { keyArrivalRows } from '../../client/scripts/utils/arrival-identity';

const mockClearRoutes = jest.fn();
const mockStopPolling = jest.fn();
jest.mock('../../client/scripts/renderers/route-renderer', () => ({
  RouteRenderer: { getInstance: () => ({ clearAllRoutes: mockClearRoutes }) }
}));
jest.mock('../../client/scripts/trackers/vehicle-tracker', () => ({
  VehicleTracker: { getInstance: () => ({ stopPolling: mockStopPolling }) }
}));
jest.mock('../../client/scripts/utils/map-popup', () => ({
  closeMapPopup: jest.fn()
}));
jest.mock('../../client/scripts/services/walking-directions.service', () => ({
  requestWalkingDirections: jest.fn()
}));
jest.mock('../../client/scripts/services/transit-api.service', () => ({
  transitApiService: {getArrivalSnapshot:jest.fn()}
}));

const request = jest.mocked(requestWalkingDirections);
const arrivals = jest.mocked(transitApiService.getArrivalSnapshot);
const origin = { lat: 40.44, lng: -79.94 };
const stop: IStop = {
  stopId: 'test-stop',
  stopName: 'Test stop',
  lat: 40.45,
  lon: -79.94,
  dtradd: [],
  dtrrem: []
};
const route: IDirectionsResult = {
  polyline: [origin, { lat: stop.lat, lng: stop.lon }],
  durationSeconds: 600,
  distanceMeters: 1100,
  warnings: ['Use caution on walking routes.']
};

function deferredRoute() {
  let resolve!: (value: IDirectionsResult) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<IDirectionsResult>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('Walking directions lifecycle', () => {
  let controller: DirectionsController;
  let polyline: IMapPolyline;
  const addPolyline = jest.fn();
  const toast = jest.fn();
  const loading = jest.fn();
  const panel = jest.fn();
  const restoreMap = jest.fn();
  let testNumber = 0;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(Date.UTC(2026, 8, 19) + testNumber++ * 1_000_000);
    jest.clearAllMocks();
    request.mockReset();
    arrivals.mockReset();
    localStorage.clear();
    Object.defineProperty(document, 'hidden', {configurable:true,value:false});
    Object.defineProperty(navigator, 'onLine', {configurable:true,value:true});
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    polyline = {
      id: 'walk',
      remove: jest.fn(),
      setVisible: jest.fn(),
      onClick: jest.fn()
    };
    addPolyline.mockReturnValue(polyline);
    controller = DirectionsController.getInstance();
    controller.initialize({ addPolyline } as unknown as IMapProvider);
    controller.updatePlannedLocation(origin);
    controller.updateUserLocation(origin);
    controller.setToastCallback(toast);
    controller.setLoadingCallback(loading);
    controller.setInfoPanelCallback(panel);
    controller.setExitCallback(restoreMap);
  });

  afterEach(() => {
    controller.exitDirections();
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  test('cleared GPS cannot start directions from a stale fix; a new fix restores the origin', async () => {
    controller.updatePlannedLocation(null);
    controller.updateUserLocation(null);
    const warning = jest
      .spyOn(console, 'warn')
      .mockImplementation(() => undefined);
    await expect(controller.startDirections(stop)).resolves.toBe(false);
    expect(request).not.toHaveBeenCalled();
    expect(toast).toHaveBeenCalledWith(
      'Choose a starting location before requesting directions.'
    );

    jest.advanceTimersByTime(600);
    const recovered = { lat: 40.43, lng: -79.95 };
    controller.updateUserLocation(recovered);
    request.mockResolvedValue(route);
    await expect(controller.startDirections(stop)).resolves.toBe(true);
    expect(request.mock.calls[0][0]).toEqual(recovered);
    warning.mockRestore();
  });

  test('clearing GPS during active directions does not run arrival or deviation checks', async () => {
    controller.updatePlannedLocation(null);
    request.mockResolvedValue(route);
    await controller.startDirections(stop);
    expect(() => controller.updateUserLocation(null)).not.toThrow();
    expect(controller.isActive).toBe(true);
    expect(controller.targetStop).toEqual(stop);
    expect(request).toHaveBeenCalledTimes(1);
    expect(restoreMap).not.toHaveBeenCalled();
    expect(toast).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(1);
  });

  test('a walking refresh keeps unavailable bus predictions separate from a fresh route duration', async () => {
    request.mockResolvedValue(route);
    await controller.startDirections(stop, [], false);
    expect(panel).toHaveBeenLastCalledWith(expect.objectContaining({predictionsAvailable:false}));
    await jest.advanceTimersByTimeAsync(120_000);
    expect(panel).toHaveBeenLastCalledWith(expect.objectContaining({predictionsAvailable:false}));
  });

  test('an explicit planned origin remains usable after GPS is cleared', async () => {
    const planned = { lat: 40.46, lng: -79.96 };
    controller.updatePlannedLocation(planned);
    controller.updateUserLocation(null);
    request.mockResolvedValue(route);
    await expect(controller.startDirections(stop)).resolves.toBe(true);
    expect(request.mock.calls[0][0]).toEqual(planned);
  });

  test.each([
    ['denial', new Error('REQUEST_DENIED')],
    ['timeout', new DOMException('Request timed out', 'TimeoutError')],
    ['provider abort', new DOMException('Request aborted', 'AbortError')]
  ])(
    'restores the map after initial %s instead of leaving directions active',
    async (_name, error) => {
      request.mockRejectedValue(error);

      await expect(controller.startDirections(stop)).resolves.toBe(false);

      expect(controller.isActive).toBe(false);
      expect(controller.targetStop).toBeNull();
      expect(restoreMap).toHaveBeenCalledTimes(1);
      expect(toast).toHaveBeenCalledTimes(1);
      expect(loading.mock.calls).toEqual([[true], [false]]);
      expect(panel).toHaveBeenLastCalledWith(null);
      expect(addPolyline).not.toHaveBeenCalled();
      expect(jest.getTimerCount()).toBe(0);
    }
  );

  test('can exit while loading; a late response cannot reactivate the map', async () => {
    const pending = deferredRoute();
    request.mockReturnValue(pending.promise);
    const started = controller.startDirections(stop);
    const signal = request.mock.calls[0][2];

    expect(loading).toHaveBeenCalledWith(true);
    controller.exitDirections();
    expect(signal.aborted).toBe(true);
    pending.resolve(route);

    await expect(started).resolves.toBe(false);
    expect(controller.isActive).toBe(false);
    expect(addPolyline).not.toHaveBeenCalled();
    expect(restoreMap).toHaveBeenCalledTimes(1);
    expect(toast).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
  });

  test('ignores an old completion after a replacement route succeeds', async () => {
    const oldRequest = deferredRoute();
    request
      .mockReturnValueOnce(oldRequest.promise)
      .mockResolvedValueOnce(route);
    const oldStart = controller.startDirections(stop);
    const oldSignal = request.mock.calls[0][2];
    jest.advanceTimersByTime(600);
    const nextStop = { ...stop, stopId: 'next-stop' };

    await expect(controller.startDirections(nextStop)).resolves.toBe(true);
    oldRequest.resolve(route);
    await expect(oldStart).resolves.toBe(false);

    expect(oldSignal.aborted).toBe(true);
    expect(controller.targetStop).toBe(nextStop);
    expect(controller.isActive).toBe(true);
    expect(addPolyline).toHaveBeenCalledTimes(1);
    expect(polyline.remove).not.toHaveBeenCalled();
    expect(restoreMap).not.toHaveBeenCalled();
    expect(panel).toHaveBeenCalledTimes(1);
    expect(panel).toHaveBeenLastCalledWith(
      expect.objectContaining({ warnings: route.warnings })
    );
    expect(jest.getTimerCount()).toBe(1);
  });

  test('keeps the displayed route and exit control when rerouting fails', async () => {
    controller.updatePlannedLocation(null);
    request
      .mockResolvedValueOnce(route)
      .mockRejectedValueOnce(new Error('REQUEST_DENIED'));
    await controller.startDirections(stop);
    jest.advanceTimersByTime(45_000);

    controller.updateUserLocation({ lat: 40.44, lng: -79.95 });
    await jest.advanceTimersByTimeAsync(0);

    expect(request).toHaveBeenCalledTimes(2);
    expect(controller.isActive).toBe(true);
    expect(polyline.remove).not.toHaveBeenCalled();
    expect(panel).toHaveBeenCalledTimes(2);
    expect(panel).toHaveBeenLastCalledWith(expect.objectContaining({walkCurrent:false}));
    expect(restoreMap).not.toHaveBeenCalled();
    expect(toast).toHaveBeenCalledWith(
      expect.stringContaining('Keeping your current route')
    );
    controller.exitDirections();
    expect(polyline.remove).toHaveBeenCalledTimes(1);
    expect(restoreMap).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });

  test('preserves the walking path and coalesces repeated GPS deviations', async () => {
    controller.updatePlannedLocation(null);
    request.mockResolvedValue(route);
    await controller.startDirections(stop);

    for (let i = 0; i < 20; i++) {
      controller.updateUserLocation({ lat: 40.44, lng: -79.95 });
    }
    expect(jest.getTimerCount()).toBe(2); // One periodic + one deferred reroute.
    await jest.advanceTimersByTimeAsync(44_999);
    expect(request).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1);
    expect(request).toHaveBeenCalledTimes(2);
    controller.updateUserLocation({ lat: 40.44, lng: -79.95 });
    expect(jest.getTimerCount()).toBe(2);
    controller.exitDirections();
    expect(jest.getTimerCount()).toBe(0);
    await jest.advanceTimersByTimeAsync(120_000);
    expect(request).toHaveBeenCalledTimes(2);
  });

  const departure = (eta = Date.UTC(2026, 8, 19) + 900_000): IPrediction => ({
    stopId:stop.stopId, routeId:'61A', vid:'3552', occurrenceId:'visit-1', predictedArrivalTime:eta, isDelayed:false, minutes:10
  });
  async function startWithDeparture() {
    const row = departure(Date.now()+600_000);
    request.mockResolvedValue(route);
    arrivals.mockResolvedValue({state:'ready',rows:[row]});
    await controller.startDirections(stop,[row],true, {keys:[...keyArrivalRows([row]).values()],checkedAt:Date.now()});
    await Promise.resolve();
    return row;
  }

  test('refreshes selected walking departures and retains a missing visit instead of switching buses', async () => {
    const original = await startWithDeparture();
    const updated = {...original,predictedArrivalTime:original.predictedArrivalTime+180_000};
    arrivals.mockResolvedValue({state:'ready',rows:[updated]});
    await jest.advanceTimersByTimeAsync(30_000);
    expect(controller.selectedPredictions).toEqual([updated]);
    expect(panel).toHaveBeenLastCalledWith(expect.objectContaining({predictionsAvailable:true,checkedAt:Date.now()}));
    arrivals.mockResolvedValue({state:'ready',rows:[{...updated,occurrenceId:'next-visit',vid:'other'}]});
    await controller.refreshArrivals();
    expect(controller.selectedPredictions).toEqual([updated]);
    expect(panel.mock.calls.at(-1)![0].missingPredictionKeys).toEqual([...keyArrivalRows([original]).values()]);
  });

  test('offline walking departures become last-known immediately and fresh-first online recovery coalesces requests', async () => {
    await startWithDeparture();
    Object.defineProperty(navigator,'onLine',{configurable:true,value:false});
    window.dispatchEvent(new Event('offline'));
    expect(panel).toHaveBeenLastCalledWith(expect.objectContaining({predictionsAvailable:false}));
    const count = arrivals.mock.calls.length;
    await jest.advanceTimersByTimeAsync(120_000);
    expect(request).toHaveBeenCalledTimes(1);
    await controller.refreshArrivals();
    expect(arrivals).toHaveBeenCalledTimes(count);
    let resolve!: (value:IArrivalSnapshot) => void;
    arrivals.mockImplementation(()=>new Promise(r=>{resolve=r;}));
    Object.defineProperty(navigator,'onLine',{configurable:true,value:true});
    window.dispatchEvent(new Event('online'));
    void controller.refreshArrivals();
    expect(arrivals).toHaveBeenCalledTimes(count+1);
    expect(panel).toHaveBeenLastCalledWith(expect.objectContaining({predictionsAvailable:false,updatingPredictions:true}));
    resolve({state:'ready',rows:[]});await Promise.resolve();
    expect(panel).toHaveBeenLastCalledWith(expect.objectContaining({predictionsAvailable:true,updatingPredictions:false}));
  });

  test('hidden and pagehide abort walking refreshes; foreground waits for a new success', async () => {
    const row = await startWithDeparture();
    let resolve!: (value:IArrivalSnapshot) => void;
    arrivals.mockImplementation(()=>new Promise(r=>{resolve=r;}));
    void controller.refreshArrivals();
    const signal = arrivals.mock.calls.at(-1)![2]!;
    Object.defineProperty(document,'hidden',{configurable:true,value:true});
    document.dispatchEvent(new Event('visibilitychange'));
    expect(signal.aborted).toBe(true);
    resolve({state:'ready',rows:[{...row,predictedArrivalTime:row.predictedArrivalTime+600_000}]});
    await Promise.resolve();
    expect(controller.selectedPredictions).toEqual([row]);
    const count = arrivals.mock.calls.length;
    await jest.advanceTimersByTimeAsync(120_000);
    expect(arrivals).toHaveBeenCalledTimes(count);
    Object.defineProperty(document,'hidden',{configurable:true,value:false});
    document.dispatchEvent(new Event('visibilitychange'));
    expect(panel).toHaveBeenLastCalledWith(expect.objectContaining({predictionsAvailable:false}));
    window.dispatchEvent(new Event('pagehide'));
    await jest.advanceTimersByTimeAsync(60_000);
    expect(arrivals).toHaveBeenCalledTimes(count+1);
    window.dispatchEvent(new PageTransitionEvent('pageshow',{persisted:true}));
    expect(arrivals).toHaveBeenCalledTimes(count+2);
    resolve({state:'ready',rows:[row]});await Promise.resolve();
    expect(panel).toHaveBeenLastCalledWith(expect.objectContaining({predictionsAvailable:true}));
  });

  test('a changed account ends the walk and a late arrivals response cannot repopulate it', async () => {
    await startWithDeparture();
    let resolve!: (value:IArrivalSnapshot) => void;
    arrivals.mockImplementation(()=>new Promise(r=>{resolve=r;}));
    void controller.refreshArrivals();
    localStorage.setItem('token','another-session');
    window.dispatchEvent(new StorageEvent('storage',{key:'token'}));
    expect(controller.isActive).toBe(false);
    resolve({state:'ready',rows:[departure()]});await Promise.resolve();
    expect(panel).toHaveBeenLastCalledWith(null);
    expect(jest.getTimerCount()).toBe(0);
  });

  test('expired arrival freshness removes boarding claims even during an unresolved refresh', async () => {
    await startWithDeparture();
    arrivals.mockImplementation(()=>new Promise(()=>undefined));
    jest.setSystemTime(Date.now()+90_001);
    controller.checkArrivalFreshness();
    expect(panel).toHaveBeenLastCalledWith(expect.objectContaining({predictionsAvailable:false}));
  });

  test('a planned-origin preview does not end or reroute when unrelated GPS reaches the destination', async () => {
    request.mockResolvedValue(route);
    await controller.startDirections(stop);
    jest.advanceTimersByTime(50_000);
    controller.updateUserLocation({lat:stop.lat,lng:stop.lon});
    expect(controller.isActive).toBe(true);
    expect(request).toHaveBeenCalledTimes(1);
    expect(panel).toHaveBeenLastCalledWith(expect.objectContaining({plannedOrigin:true,origin}));
  });

  test('foreground restoration marks an old walking estimate stale even with no selected buses or ticker', async () => {
    request.mockResolvedValue(route);
    await controller.startDirections(stop);
    Object.defineProperty(document,'hidden',{configurable:true,value:true});
    document.dispatchEvent(new Event('visibilitychange'));
    expect(panel).toHaveBeenLastCalledWith(expect.objectContaining({walkCurrent:false}));
    jest.setSystemTime(Date.now()+180_001);
    request.mockImplementation(()=>new Promise(()=>undefined));
    Object.defineProperty(document,'hidden',{configurable:true,value:false});
    document.dispatchEvent(new Event('visibilitychange'));
    expect(panel).toHaveBeenLastCalledWith(expect.objectContaining({walkCurrent:false}));
    expect(arrivals).not.toHaveBeenCalled();
  });

  test('boarding buffer updates only this walk; explicit View arrivals hands off the chosen platform', async () => {
    await startWithDeparture();
    controller.setBoardingBuffer(5);
    expect(panel).toHaveBeenLastCalledWith(expect.objectContaining({boardingBufferMin:5}));
    controller.viewArrivals();
    expect(restoreMap).toHaveBeenLastCalledWith(stop);
    expect(controller.isActive).toBe(false);
    jest.advanceTimersByTime(600);
    await controller.startDirections({...stop,stopId:'other'});
    expect(panel).toHaveBeenLastCalledWith(expect.objectContaining({boardingBufferMin:0}));
  });
});

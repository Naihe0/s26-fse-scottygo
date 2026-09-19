import type { Request, Response } from 'express';
import DAC, { type IDatabase } from '../../../server/db/dac';
import { TransitModel } from '../../../server/models/transit.model';
import trueTimeService from '../../../server/services/truetime.service';
import BusController from '../../../server/controllers/transit.controller';
import type {
  IDetour,
  IDetourGeometry
} from '../../../common/transit.interface';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((finish) => {
    resolve = finish;
  });
  return { promise, resolve };
}
const geometry = (detourId: string): IDetourGeometry[] => [
  { detourId, direction: 'INBOUND', detourPath: [{ lat: 40.44, lng: -79.94 }] }
];

beforeEach(async () => {
  DAC.db = {
    getTransitCache: jest.fn().mockResolvedValue(null),
    upsertTransitCache: jest.fn().mockResolvedValue(undefined),
    clearTransitCache: jest.fn().mockResolvedValue(undefined)
  } as unknown as IDatabase;
  await TransitModel.clearCache();
  jest.spyOn(console, 'log').mockImplementation(() => undefined);
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
  jest.spyOn(trueTimeService, 'getDetours').mockResolvedValue([]);
  jest.spyOn(trueTimeService, 'getDetourGeometry').mockResolvedValue([]);
});
afterEach(() => jest.restoreAllMocks());

test('twenty simultaneous detour metadata misses share one upstream fetch and write', async () => {
  await Promise.all(
    Array.from({ length: 20 }, (_, i) => TransitModel.getDetours([`R${i}`]))
  );
  expect(trueTimeService.getDetours).toHaveBeenCalledTimes(1);
  expect(DAC.db.upsertTransitCache).toHaveBeenCalledTimes(1);
});

test('twelve simultaneous same-route geometry reads share one upstream call', async () => {
  await Promise.all(
    Array.from({ length: 12 }, () => TransitModel.getDetoursWithGeometry('61C'))
  );
  expect(trueTimeService.getDetourGeometry).toHaveBeenCalledTimes(1);
});

test('shared metadata keeps each callers route filter independent', async () => {
  const detours: IDetour[] = [
    { id: 'd1', routeIds: ['61C'], description: 'one', startdt: '', enddt: '' },
    { id: 'd2', routeIds: ['P1'], description: 'two', startdt: '', enddt: '' }
  ];
  jest.mocked(trueTimeService.getDetours).mockResolvedValue(detours);
  const [first, second] = await Promise.all([
    TransitModel.getDetours(['61C']),
    TransitModel.getDetours(['P1'])
  ]);
  expect(first.map((item) => item.id)).toEqual(['d1']);
  expect(second.map((item) => item.id)).toEqual(['d2']);
  expect(trueTimeService.getDetours).toHaveBeenCalledTimes(1);
});

test('normalized route keys share successful empty geometry until its 60-second expiry', async () => {
  let now = 1000;
  jest.spyOn(Date, 'now').mockImplementation(() => now);
  await TransitModel.getDetoursWithGeometry(' 61c ');
  now += 59_999;
  await TransitModel.getDetoursWithGeometry('61C');
  expect(trueTimeService.getDetourGeometry).toHaveBeenCalledTimes(1);
  expect(trueTimeService.getDetourGeometry).toHaveBeenCalledWith('61C');
  now += 1;
  await TransitModel.getDetoursWithGeometry('61C');
  expect(trueTimeService.getDetourGeometry).toHaveBeenCalledTimes(2);
});

test('geometry-only detours survive caching when metadata omits them', async () => {
  jest
    .mocked(trueTimeService.getDetourGeometry)
    .mockResolvedValue(geometry('orphan'));
  const first = await TransitModel.getDetoursWithGeometry('P1');
  const repeated = await TransitModel.getDetoursWithGeometry('P1');
  expect(first[0]).toMatchObject({
    id: 'orphan',
    routeIds: ['P1'],
    geometry: geometry('orphan')
  });
  expect(repeated).toEqual(first);
  expect(trueTimeService.getDetourGeometry).toHaveBeenCalledTimes(1);
});

test('geometry failure is not cached as successful empty and the next request recovers', async () => {
  jest
    .mocked(trueTimeService.getDetourGeometry)
    .mockRejectedValueOnce(new Error('network'))
    .mockResolvedValue(geometry('recovered'));
  expect(await TransitModel.getDetoursWithGeometry('61C')).toEqual([]);
  expect((await TransitModel.getDetoursWithGeometry('61C'))[0].id).toBe(
    'recovered'
  );
  await TransitModel.getDetoursWithGeometry('61C');
  expect(trueTimeService.getDetourGeometry).toHaveBeenCalledTimes(2);
});

test('metadata failure releases the shared load for recovery', async () => {
  jest
    .mocked(trueTimeService.getDetours)
    .mockRejectedValueOnce(new Error('network'))
    .mockResolvedValue([]);
  await Promise.all([TransitModel.getDetours(), TransitModel.getDetours()]);
  await TransitModel.getDetours();
  expect(trueTimeService.getDetours).toHaveBeenCalledTimes(2);
  expect(DAC.db.upsertTransitCache).toHaveBeenCalledTimes(1);
});

test.each([
  'Invalid API access key supplied',
  'Transaction limit for current day has been exceeded.'
])(
  'HTTP 200 metadata failure %s is not persisted and a later request retries',
  async (msg) => {
    jest.mocked(trueTimeService.getDetours).mockRestore();
    const fetchMock = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ 'bustime-response': { error: [{ msg }] } })
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            'bustime-response': {
              error: [{ msg: 'No data found for parameter(s)' }]
            }
          })
        )
      );
    expect(await TransitModel.getDetours()).toEqual([]);
    expect(DAC.db.upsertTransitCache).not.toHaveBeenCalled();
    expect(await TransitModel.getDetours()).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(DAC.db.upsertTransitCache).toHaveBeenCalledWith(
      expect.objectContaining({ data: [] })
    );
  }
);

test.each([
  'Invalid API access key supplied',
  'Transaction limit for current day has been exceeded.'
])(
  'HTTP 200 geometry failure %s retries while documented no-data is cached',
  async (msg) => {
    jest.mocked(trueTimeService.getDetourGeometry).mockRestore();
    const fetchMock = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ 'bustime-response': { error: [{ msg }] } })
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            'bustime-response': {
              error: [{ msg: 'No data found for parameter(s)' }]
            }
          })
        )
      );
    expect(await TransitModel.getDetoursWithGeometry('61C')).toEqual([]);
    expect(await TransitModel.getDetoursWithGeometry('61C')).toEqual([]);
    expect(await TransitModel.getDetoursWithGeometry('61C')).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  }
);

test('geometry cache evicts least recently used routes after 64 entries', async () => {
  for (let i = 0; i < 64; i++)
    await TransitModel.getDetoursWithGeometry(`R${i}`);
  await TransitModel.getDetoursWithGeometry('R0');
  await TransitModel.getDetoursWithGeometry('R64');
  await TransitModel.getDetoursWithGeometry('R0');
  expect(trueTimeService.getDetourGeometry).toHaveBeenCalledTimes(65);
  await TransitModel.getDetoursWithGeometry('R1');
  expect(trueTimeService.getDetourGeometry).toHaveBeenCalledTimes(66);
});

test('at most 64 distinct geometry requests can be pending simultaneously', async () => {
  const upstream = deferred<IDetourGeometry[]>();
  jest
    .mocked(trueTimeService.getDetourGeometry)
    .mockReturnValue(upstream.promise);
  const pending = Array.from({ length: 64 }, (_, i) =>
    TransitModel.getDetoursWithGeometry(`R${i}`)
  );
  expect(await TransitModel.getDetoursWithGeometry('R64')).toEqual([]);
  expect(trueTimeService.getDetourGeometry).toHaveBeenCalledTimes(64);
  upstream.resolve([]);
  await Promise.all(pending);
  await TransitModel.getDetoursWithGeometry('R64');
  expect(trueTimeService.getDetourGeometry).toHaveBeenCalledTimes(65);
});

test.each(['route,other', 'a'.repeat(65), ' '])(
  'invalid geometry route ID %j performs no provider or database work',
  async (routeId) => {
    await expect(
      TransitModel.getDetoursWithGeometry(routeId)
    ).rejects.toMatchObject({ name: 'RouteNotFound' });
    expect(trueTimeService.getDetourGeometry).not.toHaveBeenCalled();
    expect(DAC.db.getTransitCache).not.toHaveBeenCalled();
  }
);

test('an old pending geometry result cannot replace the result loaded after invalidation', async () => {
  jest.spyOn(TransitModel, 'getDetours').mockResolvedValue([]);
  const old = deferred<IDetourGeometry[]>();
  jest
    .mocked(trueTimeService.getDetourGeometry)
    .mockReturnValueOnce(old.promise)
    .mockResolvedValue(geometry('new'));
  const oldRequest = TransitModel.getDetoursWithGeometry('61C');
  await TransitModel.clearCache('detours');
  expect((await TransitModel.getDetoursWithGeometry('61C'))[0].id).toBe('new');
  old.resolve(geometry('old'));
  await oldRequest;
  expect((await TransitModel.getDetoursWithGeometry('61C'))[0].id).toBe('new');
  expect(trueTimeService.getDetourGeometry).toHaveBeenCalledTimes(2);
});

test('metadata invalidation does not permit an old provider response to repopulate Mongo cache', async () => {
  const old = deferred<IDetour[]>();
  const started = deferred<void>();
  jest
    .mocked(trueTimeService.getDetours)
    .mockImplementationOnce(() => {
      started.resolve();
      return old.promise;
    })
    .mockResolvedValue([]);
  const oldRequest = TransitModel.getDetours();
  await started.promise;
  const clearing = TransitModel.clearCache('detours');
  old.resolve([]);
  await Promise.all([oldRequest, clearing]);
  expect(DAC.db.upsertTransitCache).not.toHaveBeenCalled();
  await TransitModel.getDetours();
  expect(trueTimeService.getDetours).toHaveBeenCalledTimes(2);
  expect(DAC.db.upsertTransitCache).toHaveBeenCalledTimes(1);
});

test('invalidation waits for a Mongo write already in progress before clearing it', async () => {
  const writing = deferred<void>();
  const started = deferred<void>();
  jest.mocked(DAC.db.upsertTransitCache).mockImplementation(() => {
    started.resolve();
    return writing.promise;
  });
  jest.mocked(DAC.db.clearTransitCache).mockClear();
  const request = TransitModel.getDetours();
  await started.promise;
  const clearing = TransitModel.clearCache('detours');
  expect(DAC.db.clearTransitCache).not.toHaveBeenCalled();
  writing.resolve();
  await Promise.all([request, clearing]);
  expect(DAC.db.clearTransitCache).toHaveBeenCalledTimes(1);
});

test('oversized radius is rejected by the model before candidate route collection', async () => {
  const routes = jest.spyOn(TransitModel, 'getRoutes').mockResolvedValue([]);
  await expect(
    TransitModel.getNearbyStops(40.44, -79.94, 1e20, { system: 'PRT' })
  ).rejects.toMatchObject({ name: 'OutOfBounds' });
  expect(routes).not.toHaveBeenCalled();
});

test('oversized HTTP radius returns 400 before entering the model', async () => {
  const nearby = jest
    .spyOn(TransitModel, 'getNearbyStops')
    .mockResolvedValue({
      center: { lat: 40.44, lon: -79.94 },
      radiusMeters: 1e20,
      stops: [],
      expandedRadiusApplied: false
    });
  const res = { status: jest.fn(), json: jest.fn() };
  res.status.mockReturnValue(res);
  const controller = BusController.getInstance('/transit') as unknown as {
    getNearbyStops(req: Request, res: Response): Promise<void>;
  };
  await controller.getNearbyStops(
    {
      query: { lat: '40.44', lon: '-79.94', radiusMeters: '1e20' }
    } as unknown as Request,
    res as unknown as Response
  );
  expect(res.status).toHaveBeenCalledWith(400);
  expect(nearby).not.toHaveBeenCalled();
});

test.each([0, -1, 10_001, NaN, Infinity])(
  'invalid direct radius %s fails before candidate collection',
  async (radius) => {
    const routes = jest.spyOn(TransitModel, 'getRoutes').mockResolvedValue([]);
    await expect(
      TransitModel.getNearbyStops(40.44, -79.94, radius)
    ).rejects.toMatchObject({ name: 'OutOfBounds' });
    expect(routes).not.toHaveBeenCalled();
  }
);

test('10km boundary remains valid and does not trigger default radius expansion', async () => {
  jest.spyOn(TransitModel, 'getRoutes').mockResolvedValue([]);
  const result = await TransitModel.getNearbyStops(40.44, -79.94, 10_000, {
    system: 'PRT'
  });
  expect(result.radiusMeters).toBe(10_000);
  expect(result.expandedRadiusApplied).toBe(false);
});

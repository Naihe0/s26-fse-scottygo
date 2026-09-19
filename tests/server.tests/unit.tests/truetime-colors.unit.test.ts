import trueTimeService from '../../../server/services/truetime.service';

afterEach(() => jest.restoreAllMocks());

test.each([{ error: [{ msg: 'Invalid API access' }] }, { routes: [] }, {}])(
  'TrueTime rejects unavailable colors so the model can retain fallback colors and retry: %j',
  async (body) => {
    jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new Response(JSON.stringify({ 'bustime-response': body }))
      );
    await expect(trueTimeService.getRoutes()).rejects.toMatchObject({
      name: 'UpstreamError'
    });
  }
);

test('TrueTime preserves valid route colors', async () => {
  jest.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(
      JSON.stringify({
        'bustime-response': {
          routes: [{ rt: '61C', rtnm: 'Test route', rtclr: '#123456' }]
        }
      })
    )
  );
  await expect(trueTimeService.getRoutes()).resolves.toEqual([
    expect.objectContaining({ id: '61C', color: '#123456' })
  ]);
});

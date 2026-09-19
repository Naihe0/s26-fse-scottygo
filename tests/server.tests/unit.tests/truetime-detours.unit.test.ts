import trueTimeService from '../../../server/services/truetime.service';

afterEach(() => jest.restoreAllMocks());

describe.each([
  { name: 'metadata', request: () => trueTimeService.getDetours() },
  { name: 'geometry', request: () => trueTimeService.getDetourGeometry('61C') }
])('TrueTime detour $name response envelopes', ({ request }) => {
  test.each([
    'Invalid API access key supplied',
    'Transaction limit for current day has been exceeded.',
    'Internal server error - Unable to complete request at this time',
    'Unexpected provider error'
  ])('HTTP 200 with provider error %s is a retryable failure', async (msg) => {
    jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new Response(
          JSON.stringify({ 'bustime-response': { error: [{ msg }] } })
        )
      );
    await expect(request()).rejects.toMatchObject({ name: 'UpstreamError' });
  });

  test('the documented no-data envelope is a valid empty result', async () => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          'bustime-response': {
            error: [{ msg: 'No data found for parameter(s)' }]
          }
        })
      )
    );
    await expect(request()).resolves.toEqual([]);
  });

  test('no-data does not hide another provider error in the same response', async () => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          'bustime-response': {
            error: [
              { msg: 'No data found for parameter(s)' },
              { msg: 'No API access permitted' }
            ]
          }
        })
      )
    );
    await expect(request()).rejects.toMatchObject({ name: 'UpstreamError' });
  });

  test.each([{}, { dtrs: [], ptr: [] }])(
    'a successful zero-record response remains valid: %j',
    async (body) => {
      jest
        .spyOn(globalThis, 'fetch')
        .mockResolvedValue(
          new Response(JSON.stringify({ 'bustime-response': body }))
        );
      await expect(request()).resolves.toEqual([]);
    }
  );
});

test('ordinary route patterns without a detour ID are valid empty detour geometry', async () => {
  jest.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(
      JSON.stringify({
        'bustime-response': {
          ptr: [
            {
              pid: '123',
              rtdir: 'INBOUND',
              pt: [{ seq: 0, lat: 40.44, lon: -79.94, typ: 'S' }]
            }
          ]
        }
      })
    )
  );
  await expect(trueTimeService.getDetourGeometry('61C')).resolves.toEqual([]);
});

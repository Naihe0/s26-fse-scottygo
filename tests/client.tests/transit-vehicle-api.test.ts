/** @jest-environment jsdom */

import axios from 'axios';
import { transitApiService } from '../../client/scripts/services/transit-api.service';

jest.mock('axios', () => ({ get: jest.fn() }));
const get = jest.mocked(axios.get);

beforeEach(() => {
  get.mockReset();
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
  localStorage.setItem('token', 'test-token');
});
afterEach(() => jest.restoreAllMocks());

test('vehicle requests have a finite timeout and use caller cancellation', async () => {
  const request = new AbortController();
  get.mockResolvedValue({
    status: 200,
    data: { name: 'VehiclesLocated', payload: [] }
  });
  expect(
    await transitApiService.getVehicles('61C', undefined, request.signal)
  ).toEqual({ vehicles: [] });
  expect(get).toHaveBeenCalledWith(
    '/transit/vehicles/61C',
    expect.objectContaining({
      signal: request.signal,
      timeout: 15000,
      headers: { Authorization: 'Bearer test-token' }
    })
  );
});

test.each([
  { status: 503, data: { name: 'Unavailable' } },
  { status: 200, data: { name: 'VehiclesLocated' } },
  { status: 200, data: { name: 'VehiclesLocated', payload: {} } }
])(
  'unavailable or malformed results are distinct from a healthy empty list',
  async (response) => {
    get.mockResolvedValue(response);
    expect(await transitApiService.getVehicles('61C')).toBeNull();
  }
);

test('a cancelled or failed request cannot become a no-vehicles result', async () => {
  get.mockRejectedValue(new Error('cancelled'));
  expect(await transitApiService.getVehicles('61C')).toBeNull();
});

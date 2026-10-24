/** @jest-environment jsdom */

import axios from 'axios';
import { transitApiService } from '../../client/scripts/services/transit-api.service';

jest.mock('axios');
const http = jest.mocked(axios);

describe('Transit queries distinguish no service from a failed request', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  test('vehicle queries preserve feed health from the same response', async () => {
    const feed = {
      healthy: false,
      lastFetched: '2026-10-24T10:00:00Z',
      consecutiveFailures: 2
    };
    http.get.mockResolvedValue({
      status: 200,
      data: { name: 'VehiclesLocated', payload: [], feed }
    });
    expect(await transitApiService.getVehicles('61C')).toEqual({
      vehicles: [],
      feed
    });
  });

  test('vehicle queries remain compatible with older response envelopes', async () => {
    http.get.mockResolvedValue({
      status: 200,
      data: { name: 'VehiclesLocated', payload: [] }
    });
    expect(await transitApiService.getVehicles('61C')).toEqual({
      vehicles: []
    });
  });

  test.each(['stops', 'date/time'] as const)(
    '%s preserves successful empty data',
    async (kind) => {
      const request = kind === 'stops' ? http.get : http.post;
      request.mockResolvedValue({
        status: 200,
        data: {
          name: kind === 'stops' ? 'StopsRetrieved' : 'RoutesRetrieved',
          payload: []
        }
      });
      const result =
        kind === 'stops'
          ? await transitApiService.getStops('61A', 'OUTBOUND')
          : await transitApiService.filterRoutesByDateTime(
              '2026-09-21',
              '08:30'
            );
      expect(result).toEqual([]);
    }
  );

  test.each(['stops', 'date/time'] as const)(
    '%s returns a failure state for HTTP and network failures',
    async (kind) => {
      const request = kind === 'stops' ? http.get : http.post;
      request
        .mockResolvedValueOnce({ status: 503, data: { name: 'Unavailable' } })
        .mockRejectedValueOnce(new Error('Network failure'));
      const query = () =>
        kind === 'stops'
          ? transitApiService.getStops('61A', 'OUTBOUND')
          : transitApiService.filterRoutesByDateTime('2026-09-21', '08:30');
      expect(await query()).toBeNull();
      expect(await query()).toBeNull();
    }
  );
});

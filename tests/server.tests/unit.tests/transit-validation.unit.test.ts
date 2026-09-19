import type { Request, Response } from 'express';
import BusController from '../../../server/controllers/transit.controller';
import { TransitModel } from '../../../server/models/transit.model';
import gtfsService from '../../../server/services/gtfs.service';
import {
  parseTransitDate,
  validateTransitTime
} from '../../../server/services/transit-date';

function mockResponse() {
  const response = { status: jest.fn(), json: jest.fn() };
  response.status.mockReturnValue(response);
  return response;
}

const controller = BusController.getInstance('/transit') as unknown as {
  getNearbyStops(req: Request, res: Response): Promise<void>;
  getStops(req: Request, res: Response): Promise<void>;
  filterRoutesByDateTime(req: Request, res: Response): Promise<void>;
};

describe('transit request validation', () => {
  beforeEach(() => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  test.each(['not-a-date', '2026-02-30', '2026-13-01', ['2026-09-19'], 2026])(
    'rejects invalid schedule date %j',
    (value) => {
      expect(() => parseTransitDate(value)).toThrow();
    }
  );

  test('parses the requested date as local calendar components without UTC conversion', () => {
    const date = parseTransitDate('2026-09-19');
    expect([
      date.getFullYear(),
      date.getMonth(),
      date.getDate(),
      date.getHours()
    ]).toEqual([2026, 8, 19, 0]);
    expect(parseTransitDate('2024-02-29').getDate()).toBe(29);
  });

  test('keeps Pittsburgh calendar days on both daylight-saving transition dates', () => {
    const previousTimezone = process.env.TZ;
    process.env.TZ = 'America/New_York';
    try {
      for (const value of ['2026-03-08', '2026-11-01', '2026-09-19']) {
        const parsed = parseTransitDate(value);
        const [year, month, day] = value.split('-').map(Number);
        expect([
          parsed.getFullYear(),
          parsed.getMonth() + 1,
          parsed.getDate(),
          parsed.getHours()
        ]).toEqual([year, month, day, 0]);
      }
    } finally {
      if (previousTimezone === undefined) delete process.env.TZ;
      else process.env.TZ = previousTimezone;
    }
  });

  test.each(['24:00', '12:60', '7:30', '12:15Z', ['12:30']])(
    'rejects invalid schedule time %j',
    (value) => {
      expect(() => validateTransitTime(value)).toThrow();
    }
  );

  test('passes a validated calendar day and time to GTFS filtering', async () => {
    const filter = jest
      .spyOn(gtfsService, 'filterRoutesByDateTime')
      .mockReturnValue([]);
    const response = mockResponse();
    await controller.filterRoutesByDateTime(
      { body: { date: '2026-09-19', time: '12:30' } } as Request,
      response as unknown as Response
    );
    const date = filter.mock.calls[0][0];
    expect([date.getFullYear(), date.getMonth(), date.getDate()]).toEqual([
      2026, 8, 19
    ]);
    expect(filter.mock.calls[0][1]).toBe('12:30');
    expect(response.status).toHaveBeenCalledWith(200);
  });

  test.each([
    { direction: ['INBOUND', 'OUTBOUND'] },
    { date: ['2026-09-19'] },
    { system: { value: 'PRT' } },
    { direction: 'invalid' },
    { radiusMeters: '-1' },
    { radiusMeters: '100junk' },
    { lat: '40.44junk' }
  ])(
    'returns 400 for malformed nearby-stop input %j without reaching the model',
    async (query) => {
      const lookup = jest.spyOn(TransitModel, 'getNearbyStops');
      const response = mockResponse();
      await controller.getNearbyStops(
        {
          query: { lat: '40.44', lon: '-79.94', ...query }
        } as unknown as Request,
        response as unknown as Response
      );
      expect(response.status).toHaveBeenCalledWith(400);
      expect(lookup).not.toHaveBeenCalled();
    }
  );

  test('array-valued dir returns 400 instead of throwing outside the async error handler', async () => {
    const response = mockResponse();
    await expect(
      controller.getStops(
        {
          params: { routeId: '61C' },
          query: { dir: ['INBOUND'] }
        } as unknown as Request,
        response as unknown as Response
      )
    ).resolves.toBeUndefined();
    expect(response.status).toHaveBeenCalledWith(400);
  });
});

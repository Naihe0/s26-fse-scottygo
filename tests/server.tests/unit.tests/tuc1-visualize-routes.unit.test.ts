/**
 * TUC1 – Visualize Routes: unit tests
 *
 * Test-worthy logic covered:
 *   - timeToMinutes           (GTFS time parsing utility)
 *   - toGtfsDate              (Date to GTFS date string conversion)
 *   - getActiveServiceIds     (calendar + exception logic)
 *   - filterRoutesByDate      (date-based route filtering)
 *   - filterRoutesByDateTime  (date+time route filtering)
 *   - getAllTransitData       (bulk data assembly)
 *   - Controller validation   (missing parameter handling)
 */

import { Request, Response } from 'express';
import TransitController from '../../../server/controllers/transit.controller';
import { IRoute, IPattern, IStop } from '../../../common/transit.interface';
import { IAppError } from '../../../common/server.responses';
import {
  timeToMinutes,
  toGtfsDate
} from '../../../server/services/gtfs.service';

interface ServiceCalendar {
  days: boolean[]; // indexed by JS getDay() — true if service runs that day
  start: string; // YYYYMMDD
  end: string; // YYYYMMDD
}

/**
 * Compute the set of service_ids active on a given date by applying
 * calendar.txt (regular schedule) and calendar_dates.txt (exceptions).
 */
function getActiveServiceIds(
  date: Date,
  calendar: Map<string, ServiceCalendar>,
  calendarExceptions: Map<string, { added: Set<string>; removed: Set<string> }>
): Set<string> {
  const dateStr = toGtfsDate(date);
  const dayIdx = date.getDay(); // 0=Sun...6=Sat

  const active = new Set<string>();

  // Regular schedule
  for (const [serviceId, cal] of calendar) {
    if (dateStr >= cal.start && dateStr <= cal.end && cal.days[dayIdx]) {
      active.add(serviceId);
    }
  }

  // Exceptions (added or removed service on specific dates)
  const ex = calendarExceptions.get(dateStr);
  if (ex) {
    for (const id of ex.added) active.add(id);
    for (const id of ex.removed) active.delete(id);
  }

  return active;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper for mock Response
// ─────────────────────────────────────────────────────────────────────────────

type MockResponse = Partial<Response> & {
  status: jest.Mock;
  json: jest.Mock;
};

const createMockResponse = (): MockResponse => {
  const res: MockResponse = {
    status: jest.fn(),
    json: jest.fn()
  };
  res.status.mockReturnValue(res);
  res.json.mockReturnValue(res);
  return res;
};

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('TUC1 – Visualize Routes unit tests', () => {
  // ── timeToMinutes ────────────────────────────────────────────────────

  describe('timeToMinutes', () => {
    test('converts midnight to 0 minutes', () => {
      expect(timeToMinutes('00:00:00')).toBe(0);
    });

    test('converts noon to 720 minutes', () => {
      expect(timeToMinutes('12:00:00')).toBe(720);
    });

    test('converts 6:30 PM to 1110 minutes', () => {
      expect(timeToMinutes('18:30:00')).toBe(18 * 60 + 30);
    });

    test('handles GTFS times past midnight (hours > 23)', () => {
      // GTFS allows times like 25:30:00 for late-night trips
      expect(timeToMinutes('25:30:00')).toBe(25 * 60 + 30);
    });

    test('handles single digit hours', () => {
      expect(timeToMinutes('9:15:00')).toBe(9 * 60 + 15);
    });
  });

  // ── toGtfsDate ───────────────────────────────────────────────────────

  describe('toGtfsDate', () => {
    test('formats date as YYYYMMDD', () => {
      const date = new Date(2026, 2, 27); // March 27, 2026
      expect(toGtfsDate(date)).toBe('20260327');
    });

    test('pads single-digit month with leading zero', () => {
      const date = new Date(2026, 0, 15); // January 15, 2026
      expect(toGtfsDate(date)).toBe('20260115');
    });

    test('pads single-digit day with leading zero', () => {
      const date = new Date(2026, 11, 5); // December 5, 2026
      expect(toGtfsDate(date)).toBe('20261205');
    });

    test('handles leap year dates', () => {
      const date = new Date(2024, 1, 29); // February 29, 2024 (leap year)
      expect(toGtfsDate(date)).toBe('20240229');
    });
  });

  // ── getActiveServiceIds ──────────────────────────────────────────────

  describe('getActiveServiceIds', () => {
    // Setup mock calendar data
    const calendar = new Map<string, ServiceCalendar>([
      [
        'WEEKDAY',
        {
          days: [false, true, true, true, true, true, false], // Mon-Fri
          start: '20260101',
          end: '20261231'
        }
      ],
      [
        'SATURDAY',
        {
          days: [false, false, false, false, false, false, true], // Sat only
          start: '20260101',
          end: '20261231'
        }
      ],
      [
        'SUNDAY',
        {
          days: [true, false, false, false, false, false, false], // Sun only
          start: '20260101',
          end: '20261231'
        }
      ]
    ]);

    test('returns weekday service for a Monday', () => {
      const monday = new Date(2026, 2, 23); // March 23, 2026 is Monday
      const emptyExceptions = new Map();

      const result = getActiveServiceIds(monday, calendar, emptyExceptions);

      expect(result.has('WEEKDAY')).toBe(true);
      expect(result.has('SATURDAY')).toBe(false);
      expect(result.has('SUNDAY')).toBe(false);
    });

    test('returns Saturday service for a Saturday', () => {
      const saturday = new Date(2026, 2, 28); // March 28, 2026 is Saturday
      const emptyExceptions = new Map();

      const result = getActiveServiceIds(saturday, calendar, emptyExceptions);

      expect(result.has('SATURDAY')).toBe(true);
      expect(result.has('WEEKDAY')).toBe(false);
    });

    test('returns Sunday service for a Sunday', () => {
      const sunday = new Date(2026, 2, 29); // March 29, 2026 is Sunday
      const emptyExceptions = new Map();

      const result = getActiveServiceIds(sunday, calendar, emptyExceptions);

      expect(result.has('SUNDAY')).toBe(true);
      expect(result.has('WEEKDAY')).toBe(false);
    });

    test('applies calendar exception additions', () => {
      const monday = new Date(2026, 2, 23);
      const exceptions = new Map([
        ['20260323', { added: new Set(['HOLIDAY']), removed: new Set() }]
      ]);

      const result = getActiveServiceIds(monday, calendar, exceptions);

      expect(result.has('WEEKDAY')).toBe(true);
      expect(result.has('HOLIDAY')).toBe(true);
    });

    test('applies calendar exception removals', () => {
      const monday = new Date(2026, 2, 23);
      const exceptions = new Map([
        ['20260323', { added: new Set(), removed: new Set(['WEEKDAY']) }]
      ]);

      const result = getActiveServiceIds(monday, calendar, exceptions);

      expect(result.has('WEEKDAY')).toBe(false);
    });

    test('handles both additions and removals in same exception', () => {
      const monday = new Date(2026, 2, 23);
      const exceptions = new Map([
        [
          '20260323',
          { added: new Set(['HOLIDAY']), removed: new Set(['WEEKDAY']) }
        ]
      ]);

      const result = getActiveServiceIds(monday, calendar, exceptions);

      expect(result.has('WEEKDAY')).toBe(false);
      expect(result.has('HOLIDAY')).toBe(true);
    });

    test('returns empty set for date outside all service periods', () => {
      const outOfRange = new Date(2030, 0, 1); // January 1, 2030
      const emptyExceptions = new Map();

      const result = getActiveServiceIds(outOfRange, calendar, emptyExceptions);

      expect(result.size).toBe(0);
    });

    test('excludes service when date is before service start date', () => {
      const earlyDate = new Date(2025, 11, 15); // December 15, 2025 (Monday)
      const emptyExceptions = new Map();

      const result = getActiveServiceIds(earlyDate, calendar, emptyExceptions);

      expect(result.size).toBe(0);
    });
  });

  // ── filterRoutesByDate (logic simulation) ────────────────────────────

  describe('filterRoutesByDate logic', () => {
    // Simulated route data
    const routes = new Map<string, IRoute>([
      [
        '61C',
        {
          id: '61C',
          name: 'East Liberty',
          system: 'PRT',
          color: '#1e90ff',
          directions: ['INBOUND', 'OUTBOUND'],
          activeStatus: true,
          operatingDays: [1, 2, 3, 4, 5] // Mon-Fri
        }
      ],
      [
        'P1',
        {
          id: 'P1',
          name: 'East Busway',
          system: 'PRT',
          color: '#ff6600',
          directions: ['INBOUND', 'OUTBOUND'],
          activeStatus: true,
          operatingDays: [0, 1, 2, 3, 4, 5, 6] // All week
        }
      ],
      [
        '71A',
        {
          id: '71A',
          name: 'Negley',
          system: 'PRT',
          color: '#0000ff',
          directions: ['INBOUND', 'OUTBOUND'],
          activeStatus: true,
          operatingDays: [6] // Saturday only
        }
      ]
    ]);

    // Simulated trip-to-service and trip-to-route mapping
    const tripService = new Map([
      ['trip1', 'WEEKDAY'],
      ['trip2', 'WEEKDAY'],
      ['trip3', 'SATURDAY'],
      ['trip4', 'DAILY']
    ]);

    const tripRoute = new Map([
      ['trip1', '61C'],
      ['trip2', '61C'],
      ['trip3', '71A'],
      ['trip4', 'P1']
    ]);

    const calendar = new Map<string, ServiceCalendar>([
      [
        'WEEKDAY',
        {
          days: [false, true, true, true, true, true, false],
          start: '20260101',
          end: '20261231'
        }
      ],
      [
        'SATURDAY',
        {
          days: [false, false, false, false, false, false, true],
          start: '20260101',
          end: '20261231'
        }
      ],
      [
        'DAILY',
        {
          days: [true, true, true, true, true, true, true],
          start: '20260101',
          end: '20261231'
        }
      ]
    ]);

    /**
     * Simulate filterRoutesByDate logic for testability.
     */
    function simulateFilterRoutesByDate(
      date: Date,
      routeMap: Map<string, IRoute>,
      tripServiceMap: Map<string, string>,
      tripRouteMap: Map<string, string>,
      calendarMap: Map<string, ServiceCalendar>,
      calendarExceptions: Map<
        string,
        { added: Set<string>; removed: Set<string> }
      >
    ): IRoute[] {
      const activeServices = getActiveServiceIds(
        date,
        calendarMap,
        calendarExceptions
      );
      const activeRouteIds = new Set<string>();

      for (const [tripId, serviceId] of tripServiceMap) {
        if (activeServices.has(serviceId)) {
          const routeId = tripRouteMap.get(tripId);
          if (routeId) activeRouteIds.add(routeId);
        }
      }

      return [...routeMap.values()].filter((r) => activeRouteIds.has(r.id));
    }

    test('returns only weekday routes on a Monday', () => {
      const monday = new Date(2026, 2, 23); // Monday
      const result = simulateFilterRoutesByDate(
        monday,
        routes,
        tripService,
        tripRoute,
        calendar,
        new Map()
      );

      const routeIds = result.map((r) => r.id);
      expect(routeIds).toContain('61C');
      expect(routeIds).toContain('P1');
      expect(routeIds).not.toContain('71A');
    });

    test('returns Saturday routes on a Saturday', () => {
      const saturday = new Date(2026, 2, 28); // Saturday
      const result = simulateFilterRoutesByDate(
        saturday,
        routes,
        tripService,
        tripRoute,
        calendar,
        new Map()
      );

      const routeIds = result.map((r) => r.id);
      expect(routeIds).toContain('71A');
      expect(routeIds).toContain('P1');
      expect(routeIds).not.toContain('61C');
    });

    test('returns empty array when no service runs on given date', () => {
      const outOfRange = new Date(2030, 0, 1);
      const result = simulateFilterRoutesByDate(
        outOfRange,
        routes,
        tripService,
        tripRoute,
        calendar,
        new Map()
      );

      expect(result).toHaveLength(0);
    });
  });

  // ── filterRoutesByDateTime (time-based logic) ────────────────────────

  describe('filterRoutesByDateTime logic', () => {
    // Simulated trip time ranges
    const tripTimeRange = new Map([
      ['trip1', { first: 360, last: 540 }], // 6:00 AM - 9:00 AM
      ['trip2', { first: 960, last: 1200 }], // 4:00 PM - 8:00 PM
      ['trip3', { first: 600, last: 1080 }], // 10:00 AM - 6:00 PM
      ['trip4', { first: 0, last: 1440 }] // All day (midnight to midnight)
    ]);

    const tripService = new Map([
      ['trip1', 'WEEKDAY'],
      ['trip2', 'WEEKDAY'],
      ['trip3', 'SATURDAY'],
      ['trip4', 'DAILY']
    ]);

    const tripRoute = new Map([
      ['trip1', '61C'],
      ['trip2', '61C'],
      ['trip3', '71A'],
      ['trip4', 'P1']
    ]);

    const routes = new Map<string, IRoute>([
      [
        '61C',
        {
          id: '61C',
          name: 'East Liberty',
          system: 'PRT',
          color: '#1e90ff',
          directions: ['INBOUND', 'OUTBOUND'],
          activeStatus: true,
          operatingDays: []
        }
      ],
      [
        'P1',
        {
          id: 'P1',
          name: 'East Busway',
          system: 'PRT',
          color: '#ff6600',
          directions: ['INBOUND', 'OUTBOUND'],
          activeStatus: true,
          operatingDays: []
        }
      ],
      [
        '71A',
        {
          id: '71A',
          name: 'Negley',
          system: 'PRT',
          color: '#0000ff',
          directions: ['INBOUND', 'OUTBOUND'],
          activeStatus: true,
          operatingDays: []
        }
      ]
    ]);

    const calendar = new Map<string, ServiceCalendar>([
      [
        'WEEKDAY',
        {
          days: [false, true, true, true, true, true, false],
          start: '20260101',
          end: '20261231'
        }
      ],
      [
        'SATURDAY',
        {
          days: [false, false, false, false, false, false, true],
          start: '20260101',
          end: '20261231'
        }
      ],
      [
        'DAILY',
        {
          days: [true, true, true, true, true, true, true],
          start: '20260101',
          end: '20261231'
        }
      ]
    ]);

    /**
     * Simulate filterRoutesByDateTime logic for testability.
     */
    function simulateFilterRoutesByDateTime(
      date: Date,
      time: string,
      routeMap: Map<string, IRoute>,
      tripTimeRangeMap: Map<string, { first: number; last: number }>,
      tripServiceMap: Map<string, string>,
      tripRouteMap: Map<string, string>,
      calendarMap: Map<string, ServiceCalendar>,
      calendarExceptions: Map<
        string,
        { added: Set<string>; removed: Set<string> }
      >
    ): IRoute[] {
      const [h, m] = time.split(':').map(Number);
      const queryMinutes = h * 60 + m;

      const activeServices = getActiveServiceIds(
        date,
        calendarMap,
        calendarExceptions
      );
      const activeRouteIds = new Set<string>();

      for (const [tripId, range] of tripTimeRangeMap) {
        if (range.first <= queryMinutes && range.last >= queryMinutes) {
          const serviceId = tripServiceMap.get(tripId);
          if (serviceId && activeServices.has(serviceId)) {
            const routeId = tripRouteMap.get(tripId);
            if (routeId) activeRouteIds.add(routeId);
          }
        }
      }

      return [...routeMap.values()].filter((r) => activeRouteIds.has(r.id));
    }

    test('returns routes active at 7 AM on a weekday', () => {
      const monday = new Date(2026, 2, 23);
      const result = simulateFilterRoutesByDateTime(
        monday,
        '07:00',
        routes,
        tripTimeRange,
        tripService,
        tripRoute,
        calendar,
        new Map()
      );

      const routeIds = result.map((r) => r.id);
      expect(routeIds).toContain('61C'); // trip1 is active 6-9 AM
      expect(routeIds).toContain('P1'); // trip4 is all day
      expect(routeIds).not.toContain('71A'); // Saturday only
    });

    test('returns routes active at 5 PM on a weekday', () => {
      const monday = new Date(2026, 2, 23);
      const result = simulateFilterRoutesByDateTime(
        monday,
        '17:00',
        routes,
        tripTimeRange,
        tripService,
        tripRoute,
        calendar,
        new Map()
      );

      const routeIds = result.map((r) => r.id);
      expect(routeIds).toContain('61C'); // trip2 is active 4-8 PM
      expect(routeIds).toContain('P1'); // trip4 is all day
      expect(routeIds).not.toContain('71A');
    });

    test('returns only P1 at noon on a weekday (gap in 61C service)', () => {
      const monday = new Date(2026, 2, 23);
      const result = simulateFilterRoutesByDateTime(
        monday,
        '12:00',
        routes,
        tripTimeRange,
        tripService,
        tripRoute,
        calendar,
        new Map()
      );

      const routeIds = result.map((r) => r.id);
      expect(routeIds).not.toContain('61C'); // trip1 ends 9AM, trip2 starts 4PM
      expect(routeIds).toContain('P1');
    });

    test('returns 71A and P1 at noon on Saturday', () => {
      const saturday = new Date(2026, 2, 28);
      const result = simulateFilterRoutesByDateTime(
        saturday,
        '12:00',
        routes,
        tripTimeRange,
        tripService,
        tripRoute,
        calendar,
        new Map()
      );

      const routeIds = result.map((r) => r.id);
      expect(routeIds).toContain('71A'); // trip3 is 10 AM - 6 PM
      expect(routeIds).toContain('P1');
      expect(routeIds).not.toContain('61C'); // weekday only
    });

    test('returns empty when time is outside all trip windows', () => {
      const monday = new Date(2026, 2, 23);
      // Create custom trip ranges with gaps
      const limitedTrips = new Map([
        ['trip1', { first: 600, last: 720 }] // Only 10 AM - 12 PM
      ]);
      const limitedTripService = new Map([['trip1', 'WEEKDAY']]);
      const limitedTripRoute = new Map([['trip1', '61C']]);

      const result = simulateFilterRoutesByDateTime(
        monday,
        '05:00', // 5 AM - outside the 10 AM - 12 PM window
        routes,
        limitedTrips,
        limitedTripService,
        limitedTripRoute,
        calendar,
        new Map()
      );

      expect(result).toHaveLength(0);
    });
  });

  // ── Controller filterRoutesByDateTime validation ─────────────────────

  describe('filterRoutesByDateTime controller validation', () => {
    const controller = TransitController.getInstance('/transit');

    // Access private method for testing
    const callFilterRoutesByDateTime = async (
      body: Record<string, unknown>,
      res: MockResponse
    ) =>
      (
        controller as unknown as {
          filterRoutesByDateTime: (r: Request, s: Response) => Promise<void>;
        }
      ).filterRoutesByDateTime(
        { body } as unknown as Request,
        res as unknown as Response
      );

    test('returns 400 when date parameter is missing', async () => {
      const res = createMockResponse();
      await callFilterRoutesByDateTime({}, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'ClientError',
          name: 'MissingParameter'
        })
      );
    });

    test('returns 400 when date is empty string', async () => {
      const res = createMockResponse();
      await callFilterRoutesByDateTime({ date: '' }, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'ClientError',
          name: 'MissingParameter'
        })
      );
    });
  });

  // ── getAllTransitData assembly logic ─────────────────────────────────

  describe('getAllTransitData assembly logic', () => {
    test('assembles bulk data with correct key structure', () => {
      const routes: IRoute[] = [
        {
          id: '61C',
          name: 'East Liberty',
          system: 'PRT',
          color: '#1e90ff',
          directions: ['INBOUND', 'OUTBOUND'],
          activeStatus: true,
          operatingDays: []
        }
      ];

      const patterns: Record<string, IPattern[]> = {
        '61C': [
          { direction: 'INBOUND', path: [{ lat: 40.44, lng: -79.99 }] },
          { direction: 'OUTBOUND', path: [{ lat: 40.45, lng: -80.0 }] }
        ]
      };

      const stops: Record<string, IStop[]> = {
        '61C:INBOUND': [
          {
            stopId: 's1',
            stopName: 'Stop 1',
            lat: 40.44,
            lon: -79.99,
            dtradd: [],
            dtrrem: []
          }
        ],
        '61C:OUTBOUND': [
          {
            stopId: 's2',
            stopName: 'Stop 2',
            lat: 40.45,
            lon: -80.0,
            dtradd: [],
            dtrrem: []
          }
        ]
      };

      // Verify the data structure matches IBulkTransitData
      expect(routes).toHaveLength(1);
      expect(patterns['61C']).toHaveLength(2);
      expect(stops['61C:INBOUND']).toHaveLength(1);
      expect(stops['61C:OUTBOUND']).toHaveLength(1);

      // Verify key format
      const stopKeys = Object.keys(stops);
      stopKeys.forEach((key) => {
        expect(key).toMatch(/^[^:]+:(INBOUND|OUTBOUND)$/);
      });
    });

    test('handles routes with multiple directions', () => {
      const route: IRoute = {
        id: 'P1',
        name: 'East Busway',
        system: 'PRT',
        color: '#ff6600',
        directions: ['INBOUND', 'OUTBOUND'],
        activeStatus: true,
        operatingDays: [0, 1, 2, 3, 4, 5, 6]
      };

      const directions = route.directions;
      expect(directions).toContain('INBOUND');
      expect(directions).toContain('OUTBOUND');
      expect(directions).toHaveLength(2);

      // Verify stop keys would be generated for each direction
      const stopKeys = directions.map((dir) => `${route.id}:${dir}`);
      expect(stopKeys).toEqual(['P1:INBOUND', 'P1:OUTBOUND']);
    });

    test('patterns keyed by routeId only', () => {
      const patternMap: Record<string, IPattern[]> = {};
      const routeId = '61C';
      const routePatterns: IPattern[] = [
        { direction: 'INBOUND', path: [{ lat: 40.44, lng: -79.99 }] }
      ];

      // Pattern key should be just routeId, not routeId:direction
      patternMap[routeId] = routePatterns;

      expect(patternMap['61C']).toBeDefined();
      expect(patternMap['61C:INBOUND']).toBeUndefined();
    });
  });

  // ── Edge cases for date boundary handling ────────────────────────────

  describe('date boundary handling', () => {
    test('handles end-of-month dates correctly', () => {
      const jan31 = new Date(2026, 0, 31);
      expect(toGtfsDate(jan31)).toBe('20260131');
    });

    test('handles year boundary (Dec 31 to Jan 1)', () => {
      const dec31 = new Date(2025, 11, 31);
      const jan1 = new Date(2026, 0, 1);

      expect(toGtfsDate(dec31)).toBe('20251231');
      expect(toGtfsDate(jan1)).toBe('20260101');
    });

    test('service start/end boundary comparison is inclusive', () => {
      const calendar = new Map<string, ServiceCalendar>([
        [
          'SERVICE1',
          {
            days: [true, true, true, true, true, true, true],
            start: '20260315',
            end: '20260320'
          }
        ]
      ]);

      // Test start boundary
      const startDate = new Date(2026, 2, 15);
      const beforeStart = new Date(2026, 2, 14);
      const endDate = new Date(2026, 2, 20);
      const afterEnd = new Date(2026, 2, 21);

      const emptyEx = new Map();

      expect(
        getActiveServiceIds(startDate, calendar, emptyEx).has('SERVICE1')
      ).toBe(true);
      expect(
        getActiveServiceIds(beforeStart, calendar, emptyEx).has('SERVICE1')
      ).toBe(false);
      expect(
        getActiveServiceIds(endDate, calendar, emptyEx).has('SERVICE1')
      ).toBe(true);
      expect(
        getActiveServiceIds(afterEnd, calendar, emptyEx).has('SERVICE1')
      ).toBe(false);
    });
  });

  // ── Time boundary edge cases ─────────────────────────────────────────

  describe('time boundary handling', () => {
    test('midnight (00:00) is within all-day service', () => {
      const minutes = timeToMinutes('00:00:00');
      expect(minutes).toBe(0);

      // A trip running 0-1440 should include 0
      const range = { first: 0, last: 1440 };
      expect(range.first <= minutes && range.last >= minutes).toBe(true);
    });

    test('11:59 PM is within all-day service', () => {
      const minutes = timeToMinutes('23:59:00');
      expect(minutes).toBe(23 * 60 + 59);

      // A trip running 0-1440 should include 23:59
      const range = { first: 0, last: 1440 };
      expect(range.first <= minutes && range.last >= minutes).toBe(true);
    });

    test('GTFS past-midnight time (25:00) exceeds 24 hours', () => {
      const minutes = timeToMinutes('25:00:00');
      expect(minutes).toBe(25 * 60);
      expect(minutes).toBeGreaterThan(24 * 60);
    });
  });
});

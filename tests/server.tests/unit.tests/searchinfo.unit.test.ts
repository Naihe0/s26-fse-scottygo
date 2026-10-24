/**
 * SearchInfo UC — unit tests for Search Strategy Pattern
 *
 * Coverage goals:
 * - R2 Stopword Rule: at least 2 focused tests
 * - R1 Search Rules: focused tests across user, route, and transit contexts
 */

import type { IRoute, IStop } from '../../../common/transit.interface';

jest.mock('../../../server/models/transit.model', () => ({
  __esModule: true,
  TransitModel: {
    getRoutes: jest.fn()
  }
}));

jest.mock('../../../server/models/user.model', () => ({
  __esModule: true,
  User: {
    getAllUsernames: jest.fn()
  }
}));

jest.mock('../../../server/models/notification.model', () => ({
  __esModule: true,
  NotificationModel: {
    searchNotifications: jest.fn()
  }
}));

jest.mock('../../../server/services/gtfs.service', () => ({
  __esModule: true,
  default: {
    getAllStops: jest.fn()
  }
}));

jest.mock('../../../server/services/tripshot.service', () => ({
  __esModule: true,
  default: {
    getRoutes: jest.fn().mockResolvedValue([]),
    getStops: jest.fn().mockResolvedValue([])
  }
}));

jest.mock('../../../server/services/alerts.service', () => ({
  __esModule: true,
  default: {
    getAlerts: jest.fn().mockReturnValue([])
  }
}));

jest.mock('../../../server/services/vehicle-positions.service', () => ({
  __esModule: true,
  default: {
    getAllVehicles: jest.fn().mockReturnValue([])
  }
}));

import {
  filterStopWords,
  UserSearchStrategy,
  RouteSearchStrategy,
  TransitSearchStrategy
} from '../../../server/search/search-strategy';
import { TransitModel } from '../../../server/models/transit.model';
import { User } from '../../../server/models/user.model';
import gtfsService from '../../../server/services/gtfs.service';
import tripshotService from '../../../server/services/tripshot.service';

const mockTransitModel = TransitModel as jest.Mocked<typeof TransitModel>;
const mockUser = User as jest.Mocked<typeof User>;
const mockGtfs = gtfsService as jest.Mocked<typeof gtfsService>;

const sampleRoutes: IRoute[] = [
  {
    id: 'P1',
    name: 'East Busway All-Stops',
    system: 'PRT',
    color: '#00518B',
    directions: ['INBOUND', 'OUTBOUND'],
    activeStatus: true,
    operatingDays: [1, 2, 3, 4, 5]
  },
  {
    id: '61C',
    name: 'McKeesport - Homestead',
    system: 'PRT',
    color: '#FF6600',
    directions: ['INBOUND', 'OUTBOUND'],
    activeStatus: true,
    operatingDays: [0, 1, 2, 3, 4, 5, 6]
  }
];

const sampleStops: IStop[] = [
  {
    stopId: '7079',
    stopName: 'East Busway at Negley',
    lat: 40.45,
    lon: -79.93,
    dtradd: [],
    dtrrem: []
  },
  {
    stopId: '8192',
    stopName: 'Forbes Ave at Craig',
    lat: 40.44,
    lon: -79.95,
    dtradd: [],
    dtrrem: []
  },
  {
    stopId: '5005',
    stopName: 'NEGLEY AVE + ELLSWORTH',
    lat: 40.45,
    lon: -79.94,
    dtradd: [],
    dtrrem: []
  }
];

const sampleUsers: string[] = ['zeta', 'alpha', 'beta', 'adminUser'];

describe('SearchInfo unit tests (R1 + R2)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockTransitModel.getRoutes.mockResolvedValue(sampleRoutes);
    mockGtfs.getAllStops.mockReturnValue(sampleStops);
    mockUser.getAllUsernames.mockResolvedValue(sampleUsers);
  });

  // ---------------------------------------------------------------------------
  // R2 Stopword Rule — at least 2 tests
  // ---------------------------------------------------------------------------

  describe('R2 Stopword Rule', () => {
    test('removes stop words and keeps meaningful terms (case-insensitive)', () => {
      expect(filterStopWords('The East busway and route')).toBe(
        'east busway route'
      );
    });

    test('returns null when all query tokens are stop words', () => {
      expect(filterStopWords('the and to')).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // R1 Search Rules — at least 10 tests
  // ---------------------------------------------------------------------------

  describe('R1 contextual search rules', () => {
    test('UserSearchStrategy supports partial case-insensitive matching', async () => {
      const strategy = new UserSearchStrategy();
      const result = await strategy.search('ADMIN');

      expect(result).toEqual(['adminUser']);
    });

    test('UserSearchStrategy returns all usernames sorted alphabetically when query is empty', async () => {
      const strategy = new UserSearchStrategy();
      const result = await strategy.search('');

      expect(result).toEqual(['adminUser', 'alpha', 'beta', 'zeta']);
    });

    test('RouteSearchStrategy matches by route id', async () => {
      const strategy = new RouteSearchStrategy();
      const result = await strategy.search('61C');

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('61C');
    });

    test('RouteSearchStrategy matches by route name', async () => {
      const strategy = new RouteSearchStrategy();
      const result = await strategy.search('east busway');

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('P1');
    });

    test('RouteSearchStrategy caps results at 5 items', async () => {
      const manyRoutes: IRoute[] = Array.from({ length: 8 }, (_, i) => ({
        id: `R${i}`,
        name: `Route Alpha ${i}`,
        system: 'PRT',
        color: '#000000',
        directions: ['INBOUND'],
        activeStatus: true,
        operatingDays: [1]
      }));
      mockTransitModel.getRoutes.mockResolvedValue(manyRoutes);

      const strategy = new RouteSearchStrategy();
      const result = await strategy.search('alpha');

      expect(result).toHaveLength(5);
    });

    test('TransitSearchStrategy returns matching routes and stops for mixed context search', async () => {
      const strategy = new TransitSearchStrategy();
      const result = await strategy.search('east');

      expect(result.routes.map((r) => r.id)).toEqual(['P1']);
      expect(result.stops.map((s) => s.stopId)).toEqual(['7079']);
    });

    test('TransitSearchStrategy caps routes and stops to 5 each', async () => {
      const manyRoutes: IRoute[] = Array.from({ length: 7 }, (_, i) => ({
        id: `R${i}`,
        name: `East Line ${i}`,
        system: 'PRT',
        color: '#000000',
        directions: ['INBOUND'],
        activeStatus: true,
        operatingDays: [1]
      }));
      const manyStops: IStop[] = Array.from({ length: 8 }, (_, i) => ({
        stopId: `S${i}`,
        stopName: `East Stop ${i}`,
        lat: 40.4 + i * 0.001,
        lon: -79.9,
        dtradd: [],
        dtrrem: []
      }));
      mockTransitModel.getRoutes.mockResolvedValue(manyRoutes);
      mockGtfs.getAllStops.mockReturnValue(manyStops);

      const strategy = new TransitSearchStrategy();
      const result = await strategy.search('east');

      expect(result.routes).toHaveLength(5);
      expect(result.stops).toHaveLength(5);
    });

    test('TransitSearchStrategy matches intersection stops regardless of token order and separator', async () => {
      const strategy = new TransitSearchStrategy();
      const result = await strategy.search('Ellsworth and Negley');

      expect(result.stops.map((s) => s.stopId)).toContain('5005');
    });

    test('TransitSearchStrategy supports searching by stop ID token', async () => {
      const strategy = new TransitSearchStrategy();
      const result = await strategy.search('5005');

      expect(result.stops.map((s) => s.stopId)).toContain('5005');
    });

    test('TransitSearchStrategy keeps an exact stop ID ahead of five substring matches', async () => {
      const partial = Array.from({ length: 8 }, (_, index) => ({
        ...sampleStops[0],
        stopId: `5005${index}`,
        stopName: `Nearby stop ${index}`
      }));
      mockGtfs.getAllStops.mockReturnValue([...partial, sampleStops[2]]);
      const result = await new TransitSearchStrategy().search('5005');
      expect(result.stops).toHaveLength(5);
      expect(result.stops[0].stopId).toBe('5005');
      expect(result.stops.slice(1).map((stop) => stop.stopId)).toEqual(
        partial.slice(0, 4).map((stop) => stop.stopId)
      );
    });

    test('TransitSearchStrategy prioritizes a CMU exact ID and deduplicates shared stops', async () => {
      const cmuStop = {
        ...sampleStops[0],
        stopId: 'CMU-ABC',
        stopName: 'Campus stop'
      };
      mockGtfs.getAllStops.mockReturnValue(
        Array.from({ length: 8 }, (_, index) => ({
          ...sampleStops[0],
          stopId: `CMU-ABC-${index}`
        }))
      );
      jest.mocked(tripshotService.getRoutes).mockResolvedValueOnce([
        { ...sampleRoutes[0], id: 'CMU-1', system: 'CMU' },
        { ...sampleRoutes[0], id: 'CMU-2', system: 'CMU' }
      ]);
      jest
        .mocked(tripshotService.getStops)
        .mockResolvedValueOnce([cmuStop])
        .mockResolvedValueOnce([cmuStop]);
      const result = await new TransitSearchStrategy().search('cmu-abc');
      expect(result.stops[0]).toEqual(cmuStop);
      expect(
        result.stops.filter((stop) => stop.stopId === 'CMU-ABC')
      ).toHaveLength(1);
    });

    test('TransitSearchStrategy can resolve an exact ID even when it is a natural-language stop word', async () => {
      mockGtfs.getAllStops.mockReturnValue([
        { ...sampleStops[0], stopId: 'A' }
      ]);
      const result = await new TransitSearchStrategy().search('A');
      expect(result.stops[0].stopId).toBe('A');
      expect((await new TransitSearchStrategy().search('   ')).stops).toEqual(
        []
      );
    });
  });
});

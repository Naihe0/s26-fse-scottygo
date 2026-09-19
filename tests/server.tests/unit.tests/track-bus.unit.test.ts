/**
 * TUC2 – Track Bus in Real-Time: unit tests
 *
 * Test-worthy logic covered:
 *   - filterDetoursByRouteIds  (route-based filtering with edge cases)
 *   - parseLimit               (input clamping / NaN handling)
 *   - getDetoursWithGeometry   (detour + geometry merge logic)
 *   - handleError              (IAppError → HTTP status mapping)
 *   - getVehicles              (CMU vs PRT service dispatch)
 */

import { Request, Response } from 'express';
import { TransitModel } from '../../../server/models/transit.model';
import BusController, {
  parseLimit
} from '../../../server/controllers/transit.controller';
import trueTimeService from '../../../server/services/truetime.service';
import vehiclePositionsService from '../../../server/services/vehicle-positions.service';
import tripshotService from '../../../server/services/tripshot.service';
import {
  IDetour,
  IDetourGeometry,
  IVehicle
} from '../../../common/transit.interface';
import { IAppError } from '../../../common/server.responses';
import DAC, { type IDatabase } from '../../../server/db/dac';

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

describe('TUC2 – Track Bus in Real-Time unit tests', () => {
  const controller = BusController.getInstance('/transit');

  beforeEach(() => {
    jest.restoreAllMocks();
  });

  // ── filterDetoursByRouteIds ─────────────────────────────────────────

  describe('filterDetoursByRouteIds', () => {
    const detours: IDetour[] = [
      {
        id: 'd1',
        description: 'Detour 1',
        startdt: '',
        enddt: '',
        routeIds: ['61C', '71A']
      },
      {
        id: 'd2',
        description: 'Detour 2',
        startdt: '',
        enddt: '',
        routeIds: ['P1']
      },
      {
        id: 'd3',
        description: 'Detour 3',
        startdt: '',
        enddt: ''
        // routeIds intentionally omitted
      }
    ];

    test('returns all detours when routeIds is undefined', () => {
      const result = TransitModel.filterDetoursByRouteIds(detours, undefined);
      expect(result).toHaveLength(3);
    });

    test('returns all detours when routeIds is empty array', () => {
      const result = TransitModel.filterDetoursByRouteIds(detours, []);
      expect(result).toHaveLength(3);
    });

    test('filters to detours matching any of the given route IDs', () => {
      const result = TransitModel.filterDetoursByRouteIds(detours, ['61C']);
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('d1');
    });

    test('trims whitespace from filter values before matching', () => {
      const result = TransitModel.filterDetoursByRouteIds(detours, ['  P1  ']);
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('d2');
    });

    test('excludes detours whose routeIds field is absent', () => {
      const result = TransitModel.filterDetoursByRouteIds(detours, ['61C']);
      expect(result.some((d) => d.id === 'd3')).toBe(false);
    });

    test('returns all detours when filter array contains only blank strings', () => {
      const result = TransitModel.filterDetoursByRouteIds(detours, [
        '  ',
        '',
        ' '
      ]);
      expect(result).toHaveLength(3);
    });
  });

  // ── parseLimit ──────────────────────────────────────────────────────

  describe('parseLimit', () => {
    test('returns default when input is undefined', () => {
      expect(parseLimit(undefined, 120, 2000)).toBe(120);
    });

    test('returns default when input is non-numeric string', () => {
      expect(parseLimit('abc', 120, 2000)).toBe(120);
    });

    test('clamps to 1 when parsed value is zero or negative', () => {
      expect(parseLimit('0', 120, 2000)).toBe(1);
      expect(parseLimit('-5', 120, 2000)).toBe(1);
    });

    test('clamps to maxLimit when parsed value exceeds it', () => {
      expect(parseLimit('9999', 120, 2000)).toBe(2000);
    });

    test('returns parsed value when within bounds', () => {
      expect(parseLimit('50', 120, 2000)).toBe(50);
    });
  });

  // ── getDetoursWithGeometry ──────────────────────────────────────────

  describe('getDetoursWithGeometry', () => {
    beforeEach(async () => {
      DAC.db = {
        clearTransitCache: jest.fn().mockResolvedValue(undefined)
      } as unknown as IDatabase;
      await TransitModel.clearCache('detours');
    });
    const baseDetours: IDetour[] = [
      {
        id: 'det1',
        description: 'Main St closed',
        startdt: '2025-01-01',
        enddt: '2025-02-01',
        routeIds: ['61C']
      },
      {
        id: 'det2',
        description: 'Bridge work',
        startdt: '2025-01-15',
        enddt: '2025-03-01',
        routeIds: ['61C']
      }
    ];

    const geometry: IDetourGeometry[] = [
      {
        detourId: 'det1',
        direction: 'INBOUND',
        detourPath: [{ lat: 40.44, lng: -79.99 }],
        originalPath: [{ lat: 40.45, lng: -80.0 }]
      },
      {
        detourId: 'det1',
        direction: 'OUTBOUND',
        detourPath: [{ lat: 40.43, lng: -79.98 }]
      }
    ];

    test('merges geometry onto matching detours grouped by detourId', async () => {
      jest.spyOn(TransitModel, 'getDetours').mockResolvedValue(baseDetours);
      jest
        .spyOn(trueTimeService, 'getDetourGeometry')
        .mockResolvedValue(geometry);

      const result = await TransitModel.getDetoursWithGeometry('61C');

      const det1 = result.find((d) => d.id === 'det1');
      expect(det1?.geometry).toHaveLength(2);
      expect(det1?.geometry?.[0].direction).toBe('INBOUND');
      expect(det1?.geometry?.[1].direction).toBe('OUTBOUND');

      const det2 = result.find((d) => d.id === 'det2');
      expect(det2?.geometry).toEqual([]);
    });

    test('adds geometry-only detours not present in metadata', async () => {
      const orphanGeom: IDetourGeometry[] = [
        {
          detourId: 'det-orphan',
          direction: 'INBOUND',
          detourPath: [{ lat: 40.5, lng: -80.1 }]
        }
      ];

      jest.spyOn(TransitModel, 'getDetours').mockResolvedValue([]);
      jest
        .spyOn(trueTimeService, 'getDetourGeometry')
        .mockResolvedValue(orphanGeom);

      const result = await TransitModel.getDetoursWithGeometry('61C');

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('det-orphan');
      expect(result[0].routeIds).toEqual(['61C']);
      expect(result[0].description).toBe('Detour active');
    });

    test('returns detours unchanged when geometry fetch fails', async () => {
      jest.spyOn(TransitModel, 'getDetours').mockResolvedValue(baseDetours);
      jest
        .spyOn(trueTimeService, 'getDetourGeometry')
        .mockRejectedValue(new Error('network'));

      const result = await TransitModel.getDetoursWithGeometry('61C');

      expect(result).toEqual(baseDetours);
    });
  });

  // ── handleError ─────────────────────────────────────────────────────

  describe('handleError', () => {
    const callHandleError = (error: unknown, res: MockResponse) =>
      (
        controller as unknown as {
          handleError: (e: unknown, r: Response) => void;
        }
      ).handleError(error, res as unknown as Response);

    test('maps RouteNotFound IAppError to 404', () => {
      const res = createMockResponse();
      const err: IAppError = {
        type: 'ClientError',
        name: 'RouteNotFound',
        message: 'not found'
      };
      callHandleError(err, res);
      expect(res.status).toHaveBeenCalledWith(404);
      expect(res.json).toHaveBeenCalledWith(err);
    });

    test('maps StopNotFound IAppError to 404', () => {
      const res = createMockResponse();
      const err: IAppError = {
        type: 'ClientError',
        name: 'StopNotFound',
        message: 'not found'
      };
      callHandleError(err, res);
      expect(res.status).toHaveBeenCalledWith(404);
    });

    test('maps generic ClientError to 400', () => {
      const res = createMockResponse();
      const err: IAppError = {
        type: 'ClientError',
        name: 'InvalidInput',
        message: 'bad request'
      };
      callHandleError(err, res);
      expect(res.status).toHaveBeenCalledWith(400);
    });

    test('maps ServerError to 500', () => {
      const res = createMockResponse();
      const err: IAppError = {
        type: 'ServerError',
        name: 'InternalError',
        message: 'server failure'
      };
      callHandleError(err, res);
      expect(res.status).toHaveBeenCalledWith(500);
    });

    test('wraps plain Error as 500 with error message', () => {
      const res = createMockResponse();
      callHandleError(new Error('something broke'), res);
      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'ServerError',
          name: 'GetRequestFailure',
          message: 'something broke'
        })
      );
    });
  });

  // ── getVehicles dispatch ────────────────────────────────────────────

  describe('getVehicles dispatch', () => {
    const callGetVehicles = (routeId: string, res: MockResponse) =>
      (
        controller as unknown as {
          getVehicles: (r: Request, s: Response) => Promise<void>;
        }
      ).getVehicles(
        { params: { routeId } } as unknown as Request,
        res as unknown as Response
      );

    test('dispatches to tripshot service for CMU-prefixed route', async () => {
      const cmuVehicles: IVehicle[] = [
        {
          vid: 'cmu1',
          lat: 40.44,
          lon: -79.94,
          routeId: 'CMU-AB',
          heading: 90,
          source: 'live',
          lastUpdate: '',
          isDetoured: false
        }
      ];

      jest.spyOn(tripshotService, 'isConfigured').mockReturnValue(true);
      jest.spyOn(tripshotService, 'getVehicles').mockResolvedValue(cmuVehicles);
      const vpSpy = jest.spyOn(vehiclePositionsService, 'getVehicles');

      const res = createMockResponse();
      await callGetVehicles('CMU-AB', res);

      expect(tripshotService.getVehicles).toHaveBeenCalledWith('CMU-AB');
      expect(vpSpy).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'VehiclesLocated',
          payload: cmuVehicles
        })
      );
    });

    test('dispatches to GTFS-RT vehicle positions for PRT route', async () => {
      const prtVehicles: IVehicle[] = [
        {
          vid: 'v1',
          lat: 40.44,
          lon: -79.99,
          routeId: '61C',
          heading: 180,
          source: 'live',
          lastUpdate: '',
          isDetoured: false
        }
      ];

      jest
        .spyOn(vehiclePositionsService, 'getVehicles')
        .mockReturnValue(prtVehicles);
      const tsSpy = jest.spyOn(tripshotService, 'getVehicles');

      const res = createMockResponse();
      await callGetVehicles('61C', res);

      expect(vehiclePositionsService.getVehicles).toHaveBeenCalledWith('61C');
      expect(tsSpy).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'VehiclesLocated',
          payload: prtVehicles
        })
      );
    });
  });
});

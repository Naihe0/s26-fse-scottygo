// CMU Shuttle routes: static metadata and geometry from the exported CSVs,
// live vehicles and arrivals from the TripShot liveStatus poller.

import {
  IRoute,
  IPattern,
  IStop,
  IVehicle,
  IPrediction,
  IDirectionSchedule
} from '../../common/transit.interface';
import {
  CMU_ROUTE_METADATA,
  extractRouteIndex,
  findCmuRouteIdByTripshotRouteId
} from './tripshot-metadata';
import tripshotLiveStatusService from './tripshot-livestatus.service';
import cmuStaticDataService from './cmu-static-data.service';
import { createLogger } from '../logger';

const log = createLogger('Tripshot');
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** Compact label for a set of weekdays, e.g. [1,2,3,4,5] → "Mon–Fri". */
function formatDayRangeLabel(days: number[]): string {
  const key = [...days].sort((a, b) => a - b).join(',');
  const labels: Record<string, string> = {
    '0,1,2,3,4,5,6': 'Mon–Sun',
    '1,2,3,4,5': 'Mon–Fri',
    '0,6': 'Sat–Sun',
    '4,5,6': 'Thu–Sat'
  };
  return labels[key] ?? days.map((day) => DAY_NAMES[day]).join(', ');
}

class TripshotService {
  async getRoutes(): Promise<IRoute[]> {
    return Object.entries(CMU_ROUTE_METADATA).map(([index, metadata]) => {
      const cmuRouteId = `CMU-${index}`;
      return {
        id: cmuRouteId,
        name: cmuStaticDataService.getRouteName(cmuRouteId) ?? metadata.name,
        system: 'CMU',
        color: metadata.color,
        directions: ['OUTBOUND'], // CMU shuttles run as loops.
        activeStatus: true,
        operatingDays: metadata.operatingDays
      };
    });
  }

  /** Route geometry for a "CMU-{index}" route ID. */
  async getPatterns(routeId: string): Promise<IPattern[]> {
    const { metadata } = extractRouteIndex(routeId);
    const patterns = cmuStaticDataService.getPatternsForTripshotRoute(
      metadata.routeId
    );
    if (patterns.length === 0) {
      log.warn(
        `No static patterns found for ${routeId} (${metadata.routeId})`
      );
    }
    return patterns;
  }

  /** Load the static CMU geometry ahead of the first route selection. */
  async warmPatternCache(): Promise<void> {
    for (const index of Object.keys(CMU_ROUTE_METADATA)) {
      try {
        await this.getPatterns(`CMU-${index}`);
      } catch {
        // Non-fatal — static data may be incomplete for this route.
      }
    }
    log.info('Static pattern warm-up complete');
  }

  /** Ordered stops for a CMU route; loops only have an OUTBOUND direction. */
  async getStops(routeId: string, direction?: string): Promise<IStop[]> {
    const { metadata } = extractRouteIndex(routeId);
    if (direction?.toUpperCase() === 'INBOUND') return [];

    const stops = cmuStaticDataService.getStopsForTripshotRoute(
      metadata.routeId,
      routeId
    );
    if (stops.length === 0) {
      log.warn(`No static stops found for ${routeId} (${metadata.routeId})`);
    }
    return stops;
  }

  /** Live vehicles for a CMU route, reported under the "CMU-n" route ID. */
  async getVehicles(routeId: string): Promise<IVehicle[]> {
    const { metadata } = extractRouteIndex(routeId);
    return tripshotLiveStatusService
      .getVehiclesByTsRouteId(metadata.routeId)
      .map((vehicle) => ({ ...vehicle, routeId }));
  }

  /**
   * Arrivals at a TripShot stop UUID. With a "CMU-n" route filter, only that
   * route's arrivals are returned, labelled with the requested ID so aliases
   * sharing one TripShot UUID keep the rider's chosen route.
   */
  getPredictions(stopId: string, routeIdFilter?: string): IPrediction[] {
    let filterTripshotRouteId: string | null = null;
    if (routeIdFilter?.startsWith('CMU-')) {
      try {
        filterTripshotRouteId = extractRouteIndex(routeIdFilter)
          .metadata.routeId.trim()
          .toLowerCase();
      } catch {
        filterTripshotRouteId = null;
      }
    }

    return tripshotLiveStatusService
      .getPredictions(stopId)
      .filter(
        (p) =>
          !filterTripshotRouteId ||
          p.routeId.trim().toLowerCase() === filterTripshotRouteId
      )
      .map((p) => {
        const routeId = filterTripshotRouteId
          ? routeIdFilter!
          : findCmuRouteIdByTripshotRouteId(p.routeId);
        return routeId ? { ...p, routeId } : p;
      });
  }

  /**
   * Operating days and first/last trips for a CMU route. Routes with a
   * published timetable use it; others (NightSafe, CCL) fall back to today's
   * rides from the liveStatus feed.
   */
  getRouteSchedule(routeId: string): {
    operatingDays: number[];
    directions: IDirectionSchedule[];
  } | null {
    const { metadata } = extractRouteIndex(routeId);

    if (metadata.schedule?.length) {
      return {
        operatingDays: metadata.operatingDays,
        directions: metadata.schedule.map((window) => ({
          direction: formatDayRangeLabel(window.days),
          firstTrip: window.firstTrip,
          lastTrip: window.lastTrip
        }))
      };
    }

    const liveSchedule = tripshotLiveStatusService.getScheduleByTsRouteId(
      metadata.routeId
    );
    if (!liveSchedule) return null;
    return {
      operatingDays: metadata.operatingDays,
      directions: [
        {
          direction: 'OUTBOUND',
          firstTrip: liveSchedule.firstTrip,
          lastTrip: liveSchedule.lastTrip
        }
      ]
    };
  }
}

const tripshotService = new TripshotService();
export default tripshotService;

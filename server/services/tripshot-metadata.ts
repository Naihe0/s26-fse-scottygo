// CMU Shuttle route metadata and route-ID validation helpers.

import { clientError } from '../errors';
import { createLogger } from '../logger';

/**
 * One service-window entry: the days it applies to and the first/last trip
 * times (HH:MM in Eastern time, matching the CMU shuttle website).
 */
export interface CMUScheduleWindow {
  /** Weekdays this window applies to (0=Sun…6=Sat). */
  days: number[];
  /** HH:MM of the first trip in Eastern time. */
  firstTrip: string;
  /** HH:MM of the last trip in Eastern time. */
  lastTrip: string;
}

export interface CMURouteMetadata {
  name: string;
  shortName: string;
  color: string;
  routeId: string; // Tripshot UUID
  /** Weekdays (0=Sun…6=Sat) on which this route operates. */
  operatingDays: number[];
  /**
   * Static service-hour windows sourced from cmu.edu/transportation.
   * Routes without a known timetable (NightSafe, CCL) leave this undefined
   * and fall back to the TripShot liveStatus feed.
   */
  schedule?: CMUScheduleWindow[];
}

// Source: https://www.cmu.edu/transportation/transport/shuttle.html
export const CMU_ROUTE_METADATA: Record<number, CMURouteMetadata> = {
  1: {
    name: 'A Route- N. Oakland / W. Shadyside',
    shortName: 'A',
    color: '#C41230',
    routeId: 'D493D9EF-7628-4116-BBEC-ADB2D208BBE5',
    operatingDays: [0, 1, 2, 3, 4, 5, 6], // Mon–Sun
    schedule: [
      { days: [1, 2, 3, 4, 5], firstTrip: '07:00', lastTrip: '22:45' },
      { days: [0, 6], firstTrip: '07:00', lastTrip: '23:00' }
    ]
  },
  2: {
    name: 'AB Route- N. Oak & Shadyside Comb.',
    shortName: 'AB',
    color: '#8E44AD',
    routeId: '967E607E-34FD-4451-A33F-01D4B8157CD3',
    operatingDays: [0, 1, 2, 3, 4, 5, 6], // Mon–Sun
    schedule: [
      { days: [1, 2, 3, 4, 5], firstTrip: '09:15', lastTrip: '22:45' },
      { days: [0, 6], firstTrip: '07:00', lastTrip: '23:00' }
    ]
  },
  3: {
    name: 'B Route- E. Shadyside',
    shortName: 'B',
    color: '#006AB3',
    routeId: '825C4CAF-C531-4DBC-B11B-F90580ABB70A',
    operatingDays: [0, 1, 2, 3, 4, 5, 6], // Mon–Sun
    schedule: [
      { days: [1, 2, 3, 4, 5], firstTrip: '07:00', lastTrip: '22:45' },
      { days: [0, 6], firstTrip: '07:00', lastTrip: '23:00' }
    ]
  },
  4: {
    name: 'Bakery Square (Long)',
    shortName: 'BKL',
    color: '#FF6B35',
    routeId: 'AF900FBF-8D7B-4F7C-B8BD-D0FE1453BC19',
    operatingDays: [1, 2, 3, 4, 5], // Mon–Fri
    schedule: [{ days: [1, 2, 3, 4, 5], firstTrip: '08:30', lastTrip: '18:00' }]
  },
  5: {
    name: 'Bakery Square (Short)',
    shortName: 'BKS',
    color: '#FFA630',
    routeId: '07C26A10-420F-4324-8F36-C91BC1630E9F',
    operatingDays: [1, 2, 3, 4, 5], // Mon–Fri
    schedule: [{ days: [1, 2, 3, 4, 5], firstTrip: '08:30', lastTrip: '18:00' }]
  },
  6: {
    name: 'C Route- Squirrel Hill',
    shortName: 'C',
    color: '#2ECC71',
    routeId: 'A9E22E1E-A366-4FE4-973C-871EB78E2349',
    operatingDays: [1, 2, 3, 4, 5], // Mon–Fri
    schedule: [{ days: [1, 2, 3, 4, 5], firstTrip: '07:00', lastTrip: '21:15' }]
  },
  7: {
    // No timetable published on cmu.edu/transportation — falls back to liveStatus
    name: 'Contemporary Craft - Lawrenceville',
    shortName: 'CCL',
    color: '#9B59B6',
    routeId: 'BFF8598D-6782-4B41-8C62-D3A1E4F4B4DB',
    operatingDays: [1, 2, 3, 4, 5] // Mon–Fri (best-effort)
  },
  // Source: https://www.cmu.edu/transportation/transport/nightsafe.html
  // All NightSafe routes run every day; service window 6:30 PM – 4:15 AM,
  // last departure 3:30 AM, cycling every 45 minutes.
  8: {
    name: 'NightSafe Transit Blue Zone (Shadyside)',
    shortName: 'NSB',
    color: '#3498DB',
    routeId: '38C552F5-A569-446F-97E1-2F72C06EB0AD',
    operatingDays: [0, 1, 2, 3, 4, 5, 6], // Mon–Sun
    schedule: [
      { days: [0, 1, 2, 3, 4, 5, 6], firstTrip: '18:30', lastTrip: '03:30' }
    ]
  },
  9: {
    name: 'NightSafe Transit Blue/Green Combined',
    shortName: 'NSBG',
    color: '#1ABC9C',
    routeId: '7F7F4951-FD17-49F4-A129-1551B04F063E',
    operatingDays: [0, 1, 2, 3, 4, 5, 6], // Mon–Sun
    schedule: [
      { days: [0, 1, 2, 3, 4, 5, 6], firstTrip: '18:30', lastTrip: '03:30' }
    ]
  },
  10: {
    name: 'NightSafe Transit Green Zone (Oakland)',
    shortName: 'NSG',
    color: '#27AE60',
    routeId: 'B90432CE-5B11-4C6E-BC09-431F54ED5970',
    operatingDays: [0, 1, 2, 3, 4, 5, 6], // Mon–Sun
    schedule: [
      { days: [0, 1, 2, 3, 4, 5, 6], firstTrip: '18:30', lastTrip: '03:30' }
    ]
  },
  11: {
    name: 'NightSafe Transit Red Zone (Sq. Hill 2)',
    shortName: 'NSR',
    color: '#E74C3C',
    routeId: '00A55A76-231F-4CF2-8B89-F6DBD518C117',
    operatingDays: [0, 1, 2, 3, 4, 5, 6], // Mon–Sun
    schedule: [
      { days: [0, 1, 2, 3, 4, 5, 6], firstTrip: '18:30', lastTrip: '03:30' }
    ]
  },
  12: {
    name: 'NightSafe Transit Red/Yellow Combined',
    shortName: 'NSRY',
    color: '#F39C12',
    routeId: 'CB8AD8C3-6F50-4CD5-888E-84DD11A1E95B',
    operatingDays: [0, 1, 2, 3, 4, 5, 6], // Mon–Sun
    schedule: [
      { days: [0, 1, 2, 3, 4, 5, 6], firstTrip: '18:30', lastTrip: '03:30' }
    ]
  },
  13: {
    name: 'NightSafe Transit Yellow Zone (Sq. Hill 1)',
    shortName: 'NSY',
    color: '#F1C40F',
    routeId: 'D156D457-473E-405F-AF31-22E9A44AD2F2',
    operatingDays: [0, 1, 2, 3, 4, 5, 6], // Mon–Sun
    schedule: [
      { days: [0, 1, 2, 3, 4, 5, 6], firstTrip: '18:30', lastTrip: '03:30' }
    ]
  },
  14: {
    name: 'PTC',
    shortName: 'PTC',
    color: '#34495E',
    routeId: 'D2DBA04E-C0EA-4BDD-BFEE-4A89612087FD',
    operatingDays: [0, 1, 2, 3, 4, 5, 6], // Mon–Sun
    schedule: [
      { days: [1, 2, 3, 4, 5], firstTrip: '08:30', lastTrip: '23:00' },
      { days: [0, 6], firstTrip: '09:15', lastTrip: '18:15' }
    ]
  },
  15: {
    name: 'PTC & Mill 19',
    shortName: 'PTC19',
    color: '#7F8C8D',
    routeId: 'D73A82B6-627D-405B-9431-421535F4E021',
    operatingDays: [0, 1, 2, 3, 4, 5, 6], // Mon–Sun
    schedule: [
      { days: [1, 2, 3, 4, 5], firstTrip: '07:30', lastTrip: '19:00' },
      { days: [0, 6], firstTrip: '08:45', lastTrip: '18:15' }
    ]
  }
};

const tripshotRouteToCmuRouteId = new Map<string, string>();
const duplicateTripshotRouteIds = new Map<string, string[]>();

for (const [index, metadata] of Object.entries(CMU_ROUTE_METADATA)) {
  const cmuRouteId = `CMU-${index}`;
  const normalizedTripshotRouteId = metadata.routeId.trim().toLowerCase();
  const existing = tripshotRouteToCmuRouteId.get(normalizedTripshotRouteId);

  if (existing) {
    const aliases = duplicateTripshotRouteIds.get(
      normalizedTripshotRouteId
    ) ?? [existing];
    aliases.push(cmuRouteId);
    duplicateTripshotRouteIds.set(normalizedTripshotRouteId, aliases);
    continue;
  }

  tripshotRouteToCmuRouteId.set(normalizedTripshotRouteId, cmuRouteId);
}

if (duplicateTripshotRouteIds.size > 0) {
  const duplicateSummary = [...duplicateTripshotRouteIds.entries()]
    .map(
      ([tripshotRouteId, cmuRouteIds]) =>
        `${tripshotRouteId}=>${cmuRouteIds.join('/')}`
    )
    .join(', ');
  createLogger('Tripshot').warn(
    `Duplicate TripShot route IDs configured in CMU_ROUTE_METADATA: ${duplicateSummary}`
  );
}

/**
 * Extract and validate the numeric route index from a "CMU-{n}" route ID.
 * Returns the index and its metadata, or throws an IAppError if invalid.
 */
export function extractRouteIndex(routeId: string): {
  index: number;
  metadata: CMURouteMetadata;
} {
  const match = routeId.match(/^CMU-(\d+)$/);
  if (!match) {
    throw clientError(
      'RouteNotFound',
      `Invalid CMU route ID format: ${routeId}`
    );
  }

  const index = parseInt(match[1], 10);
  const metadata = CMU_ROUTE_METADATA[index];
  if (!metadata) {
    throw clientError('RouteNotFound', `CMU route ${routeId} not found`);
  }

  return { index, metadata };
}

/**
 * Resolve a TripShot route UUID to our public CMU route ID format (CMU-{n}).
 * Returns null when the UUID is unknown.
 */
export function findCmuRouteIdByTripshotRouteId(
  tripshotRouteId: string
): string | null {
  const normalized = tripshotRouteId.trim().toLowerCase();
  return tripshotRouteToCmuRouteId.get(normalized) ?? null;
}

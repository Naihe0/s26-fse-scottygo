// TripShot shared API layer: type definitions, constants, and utilities used by
// both tripshot.service.ts (routeSummary) and tripshot-livestatus.service.ts (liveStatus).
// Extracted from tripshot.service.ts to reduce unit size.

const TIMEOUT_MS = 5000; // 5 seconds timeout for API requests

export const TRIPSHOT_BASE_URL = 'https://cmu.tripshot.com/v2/p';

/** liveStatus endpoint — returns all active vehicles and rides for the CMU region. */
export const TRIPSHOT_LIVE_STATUS_URL =
  'https://cmu.tripshot.com/v1/p/liveStatus?regionId=CA558DDC-D7F2-4B48-9CAC-DEEA1134F820';

// Interfaces for Tripshot API responses

export interface TripshotLocation {
  lt: number; // latitude
  lg: number; // longitude
}

export interface TripshotStop {
  stopId: string;
  name: string;
  location: TripshotLocation;
  terminal?: boolean;
  onDemand?: boolean;
  gtfsId?: string;
}

export interface TripshotViaStop {
  ViaStop: {
    stop: TripshotStop;
  };
}

export interface TripshotStep {
  polyline: string; // Google encoded polyline
  distanceMeters: number;
  durationSec: number;
}

export interface TripshotLeg {
  startPoint: { NavViaStop: { stopId: string } };
  endPoint: { NavViaStop: { stopId: string } };
  steps: TripshotStep[];
}

export interface TripshotRide {
  /** Mix of ViaStop and ViaWaypoint objects — always guard with isTsViaStop(). */
  vias: unknown[];
}

/**
 * Type guard: true when `via` is a ViaStop (has a nested stop with coordinates).
 * Use this before accessing `via.ViaStop.stop` — waypoints lack the ViaStop key.
 */
export function isTsViaStop(via: unknown): via is TripshotViaStop {
  return (
    typeof via === 'object' &&
    via !== null &&
    'ViaStop' in via &&
    typeof (via as TripshotViaStop).ViaStop?.stop?.stopId === 'string'
  );
}

export interface TripshotServiceData {
  legs: TripshotLeg[];
}

export interface TripshotRouteResponse {
  rides: TripshotRide[];
  services: TripshotServiceData[];
}

/**
 * Decode Google's encoded polyline algorithm to lat/lng coordinates
 * Ported from Python implementation provided by user
 */

function decodeNextValue(
  str: string,
  index: number
): { value: number; index: number } {
  let shift = 0;
  let result = 0;
  while (index < str.length && shift < 30) {
    const b = str.charCodeAt(index) - 63;
    if (b < 0 || b > 63) throw new Error('Invalid encoded polyline');
    index += 1;
    result |= (b & 0x1f) << shift;
    shift += 5;
    if (b < 0x20) {
      const value = result & 1 ? ~(result >> 1) : result >> 1;
      return { value, index };
    }
  }
  throw new Error('Invalid encoded polyline');
}

export function decodePolyline(
  polylineStr: string
): Array<{ lat: number; lng: number }> {
  let index = 0;
  let lat = 0;
  let lng = 0;
  const coordinates: Array<{ lat: number; lng: number }> = [];

  while (index < polylineStr.length) {
    const latDecode = decodeNextValue(polylineStr, index);
    lat += latDecode.value;
    index = latDecode.index;

    const lngDecode = decodeNextValue(polylineStr, index);
    lng += lngDecode.value;
    index = lngDecode.index;

    coordinates.push({
      lat: lat / 1e5,
      lng: lng / 1e5
    });
  }

  return coordinates;
}

// ── liveStatus interfaces ───────────────────────────────────────────────
// Returned by GET /v1/p/liveStatus — real-time vehicle and ride data.

export interface TsLiveVehicle {
  vehicleId: string;
  name: string;
  capacity: number;
  vehicleType: string;
  wheelchairCapacity: number;
}

export interface TsLiveVehicleStatus {
  vehicleId: string;
  name: string;
  location: TripshotLocation;
  accuracy: number;
  /** ISO timestamp of last GPS ping */
  when: string;
  bearing: number | null;
  /** Speed in m/s */
  speed: number;
  liveDataAvailable: boolean;
}

export type TsStopState =
  | {
      Awaiting: {
        expectedArrivalTime: string;
        stopId: string;
        viaIdx: number;
        scheduledAt: string;
        /** Full ISO UTC timestamp equivalent of scheduledAt — present in liveStatus feed. */
        scheduledDepartureTime?: string;
      };
    }
  | {
      Departed: {
        arrivalTime: string;
        departureTime: string;
        stopId: string;
        viaIdx: number;
      };
    }
  | { Skipped: { stopId: string; viaIdx: number } };

export interface TsLiveRide {
  rideId: string;
  /** TripShot route UUID — matches CMURouteMetadata.routeId */
  routeId: string;
  routeName: string;
  vehicleId: string | null;
  vehicleName: string | null;
  /** Shape: { Active: {...} } | { Completed: {...} } | { Scheduled: {...} } etc. */
  state: Record<string, unknown>;
  stopStatus: TsStopState[];
  vias: unknown[];
  riderCount: number;
  liveDataAvailable: boolean;
  scheduledStart: string;
  scheduledEnd: string;
  color: string;
}

export interface TsLiveStatus {
  timestamp: string;
  vehicles: TsLiveVehicle[];
  vehicleStatuses: TsLiveVehicleStatus[];
  rides: TsLiveRide[];
}

/**
 * Fetch with timeout to prevent hanging requests
 */
export async function fetchWithTimeout(
  url: string,
  options: RequestInit = {}
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal
    });
    clearTimeout(timeout);
    return response;
  } catch (error) {
    clearTimeout(timeout);
    throw error;
  }
}

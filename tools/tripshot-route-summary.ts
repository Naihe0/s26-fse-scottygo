// TripShot routeSummary API shapes and helpers used by the offline CMU static
// data export (tools/export-cmu-static-from-tripshot.ts). The running server
// reads the exported CSVs instead of calling this API.

import type { TripshotLocation } from '../server/services/tripshot-api';

export const TRIPSHOT_BASE_URL = 'https://cmu.tripshot.com/v2/p';

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

export interface TripshotRouteResponse {
  rides: TripshotRide[];
  services: { legs: TripshotLeg[] }[];
}

/** True when `via` is a ViaStop; waypoints lack the ViaStop key. */
export function isTsViaStop(via: unknown): via is TripshotViaStop {
  return (
    typeof via === 'object' &&
    via !== null &&
    'ViaStop' in via &&
    typeof (via as TripshotViaStop).ViaStop?.stop?.stopId === 'string'
  );
}

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

/** Decode a Google encoded polyline into lat/lng coordinates. */
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

    coordinates.push({ lat: lat / 1e5, lng: lng / 1e5 });
  }

  return coordinates;
}

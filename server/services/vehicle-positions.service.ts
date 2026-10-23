/**
 * GTFS-RT Vehicle Positions Service
 *
 * Polls the PRT GTFS-RT vehicle positions protobuf feed every 30 seconds and
 * keeps the decoded vehicles in memory, indexed by route ID.
 */

import { transit_realtime } from 'gtfs-realtime-bindings';
import { IVehicle } from '../../common/transit.interface';
import { PollingFeed } from './polling-feed';

const GTFSRT_VEHICLE_URL =
  'https://truetime.portauthority.org/gtfsrt-bus/vehicles';

const { VehicleStopStatus } = transit_realtime.VehiclePosition;
const STOP_STATUS_NAMES = new Map<number, IVehicle['currentStatus']>([
  [VehicleStopStatus.INCOMING_AT, 'INCOMING_AT'],
  [VehicleStopStatus.STOPPED_AT, 'STOPPED_AT'],
  [VehicleStopStatus.IN_TRANSIT_TO, 'IN_TRANSIT_TO']
]);

/** Protobuf prototype defaults are not supplied sensor observations. */
function observedNumber(
  message: object,
  field: string,
  minimum = -Infinity,
  maximum = Infinity
): number | undefined {
  if (!Object.prototype.hasOwnProperty.call(message, field)) return undefined;
  const value = (message as Record<string, unknown>)[field];
  return typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= minimum &&
    value <= maximum
    ? value
    : undefined;
}

function measurementTimestamp(vp: transit_realtime.IVehiclePosition): string {
  if (
    !Object.prototype.hasOwnProperty.call(vp, 'timestamp') ||
    vp.timestamp == null
  )
    return '';
  const seconds =
    typeof vp.timestamp === 'number' ? vp.timestamp : vp.timestamp.toNumber();
  if (!Number.isSafeInteger(seconds) || seconds < 0) return '';
  const date = new Date(seconds * 1000);
  // Feed creation/receipt time is not the time the GPS position was measured.
  // An unknown or invalid observation must never become a fresh moving bus.
  return Number.isFinite(date.getTime()) ? date.toISOString() : '';
}

/** Decode one GTFS-RT entity, or return null when it has no usable position. */
function decodeVehicleEntity(
  entity: transit_realtime.IFeedEntity
): IVehicle | null {
  const vp = entity.vehicle;
  if (!vp?.position) return null;
  const latitude = observedNumber(vp.position, 'latitude', -90, 90);
  const longitude = observedNumber(vp.position, 'longitude', -180, 180);
  if (latitude === undefined || longitude === undefined) return null;

  const sequence = observedNumber(vp, 'currentStopSequence', 0, 0xffffffff);
  const stopSequence =
    sequence !== undefined && Number.isInteger(sequence) ? sequence : undefined;
  // GTFS current_status is only meaningful with a current_stop_sequence.
  const status =
    stopSequence !== undefined ? observedNumber(vp, 'currentStatus') : undefined;

  return {
    vid: vp.vehicle?.id || entity.id,
    lat: latitude,
    lon: longitude,
    routeId: vp.trip?.routeId ?? '',
    heading: observedNumber(vp.position, 'bearing', 0, 360),
    speed: observedNumber(vp.position, 'speed', 0),
    source: 'live',
    lastUpdate: measurementTimestamp(vp),
    isDetoured: false,
    tripId: vp.trip?.tripId || undefined,
    currentStatus:
      status === undefined ? undefined : STOP_STATUS_NAMES.get(status),
    currentStopSequence: stopSequence,
    currentStopId: vp.stopId || undefined
  };
}

export class VehiclePositionsService extends PollingFeed<IVehicle[]> {
  private vehiclesByRoute = new Map<string, IVehicle[]>();
  private allVehicles: IVehicle[] = [];

  constructor() {
    super({
      name: 'VehiclePositions',
      intervalMs: 30_000,
      timeoutMs: 15_000,
      maxAgeMs: 90_000
    });
  }

  /** Vehicles on a route; empty before the first fetch or when none run. */
  getVehicles(routeId: string): IVehicle[] {
    return this.vehiclesByRoute.get(routeId) ?? [];
  }

  getAllVehicles(): IVehicle[] {
    return this.allVehicles;
  }

  protected async fetchSnapshot(signal: AbortSignal): Promise<IVehicle[]> {
    const response = await this.fetchOk(GTFSRT_VEHICLE_URL, signal, {
      headers: { Accept: 'application/x-protobuf' }
    });
    const feed = transit_realtime.FeedMessage.decode(
      new Uint8Array(await response.arrayBuffer())
    );
    return feed.entity
      .map(decodeVehicleEntity)
      .filter((vehicle): vehicle is IVehicle => vehicle !== null);
  }

  protected applySnapshot(vehicles: IVehicle[]): void {
    const byRoute = new Map<string, IVehicle[]>();
    for (const vehicle of vehicles) {
      if (!vehicle.routeId) continue;
      const list = byRoute.get(vehicle.routeId);
      if (list) list.push(vehicle);
      else byRoute.set(vehicle.routeId, [vehicle]);
    }
    this.vehiclesByRoute = byRoute;
    this.allVehicles = vehicles;
    this.log.info(
      `Updated: ${vehicles.length} vehicles across ${byRoute.size} routes`
    );
  }
}

const vehiclePositionsService = new VehiclePositionsService();
export default vehiclePositionsService;

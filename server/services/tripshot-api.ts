// Response shapes for TripShot's public liveStatus endpoint (CMU shuttles).

/** Returns all active vehicles and rides for the CMU region. */
export const TRIPSHOT_LIVE_STATUS_URL =
  'https://cmu.tripshot.com/v1/p/liveStatus?regionId=CA558DDC-D7F2-4B48-9CAC-DEEA1134F820';

export interface TripshotLocation {
  lt: number; // latitude
  lg: number; // longitude
}

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
        /** Full ISO UTC equivalent of scheduledAt, when supplied. */
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

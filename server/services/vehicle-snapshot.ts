import type { IVehicle } from '../../common/transit.interface';

/** A faulty future clock must not prevent the next real GPS fix being used. */
function measuredAt(vehicle: IVehicle): number {
  const time = Date.parse(vehicle.lastUpdate);
  return time <= Date.now() + 5_000 ? time : NaN;
}

function newerObservation(previous: IVehicle, incoming: IVehicle): IVehicle {
  const previousTime = measuredAt(previous);
  const incomingTime = measuredAt(incoming);
  if (!Number.isFinite(previousTime)) return incoming;
  if (!Number.isFinite(incomingTime) || incomingTime < previousTime)
    return previous;
  if (incomingTime !== previousTime) return incoming;
  if (
    incoming.routeId !== previous.routeId ||
    incoming.tripId !== previous.tripId
  )
    return previous;

  // Repeated GPS timestamps do not describe a new position. Keep geometry
  // stable while allowing fresh stop/status information to halt prediction.
  return {
    ...incoming,
    lat: previous.lat,
    lon: previous.lon,
    heading: previous.heading,
    speed: incoming.speed === 0 ? 0 : previous.speed,
    lastUpdate: previous.lastUpdate
  };
}

/**
 * One observation per physical bus, never older than its last accepted fix.
 * Only buses present in this snapshot remain: disappearance is still visible
 * to the browser's bounded stale-marker policy, without an unbounded server cache.
 */
export function reconcileVehicleSnapshot(
  incoming: IVehicle[],
  previous: IVehicle[]
): IVehicle[] {
  const previousById = new Map(
    previous.map((vehicle) => [vehicle.vid, vehicle])
  );
  const next = new Map<string, IVehicle>();
  for (const vehicle of incoming) {
    if (
      !vehicle.vid ||
      !Number.isFinite(vehicle.lat) ||
      !Number.isFinite(vehicle.lon) ||
      Math.abs(vehicle.lat) > 90 ||
      Math.abs(vehicle.lon) > 180
    )
      continue;
    const accepted = next.get(vehicle.vid) ?? previousById.get(vehicle.vid);
    next.set(
      vehicle.vid,
      accepted ? newerObservation(accepted, vehicle) : vehicle
    );
  }
  return [...next.values()];
}

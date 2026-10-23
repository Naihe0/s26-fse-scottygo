/**
 * GTFS-RT Trip Updates Service
 *
 * Polls the PRT GTFS-RT trip updates protobuf feed every 30 seconds and keeps
 * arrival predictions in memory, indexed by stop ID and sorted soonest first.
 */

import { transit_realtime } from 'gtfs-realtime-bindings';
import { IPrediction } from '../../common/transit.interface';
import { PollingFeed } from './polling-feed';

const GTFSRT_TRIPS_URL = 'https://truetime.portauthority.org/gtfsrt-bus/trips';

type ProtobufTime = number | { toNumber(): number } | null | undefined;

function toSeconds(time: ProtobufTime): number | null {
  if (time == null) return null;
  return typeof time === 'number' ? time : time.toNumber();
}

/** Arrival time in seconds, falling back to departure time. */
function arrivalSeconds(
  update: transit_realtime.TripUpdate.IStopTimeUpdate
): number | null {
  return toSeconds(update.arrival?.time) ?? toSeconds(update.departure?.time);
}

function decodePredictions(
  feed: transit_realtime.IFeedMessage,
  nowSec: number
): Map<string, IPrediction[]> {
  const byStop = new Map<string, IPrediction[]>();
  for (const entity of feed.entity ?? []) {
    const tripUpdate = entity.tripUpdate;
    if (!tripUpdate?.trip || !tripUpdate.stopTimeUpdate) continue;
    const routeId = tripUpdate.trip.routeId ?? '';
    const vid = tripUpdate.vehicle?.id || undefined;

    for (const update of tripUpdate.stopTimeUpdate) {
      const arrivalSec = arrivalSeconds(update);
      if (!update.stopId || !arrivalSec || arrivalSec < nowSec) continue;
      const prediction: IPrediction = {
        stopId: update.stopId,
        routeId,
        vid,
        predictedArrivalTime: arrivalSec * 1000,
        isDelayed: false, // GTFS-RT has no simple delay flag.
        minutes: Math.round((arrivalSec - nowSec) / 60)
      };
      const list = byStop.get(update.stopId);
      if (list) list.push(prediction);
      else byStop.set(update.stopId, [prediction]);
    }
  }
  for (const predictions of byStop.values()) {
    predictions.sort((a, b) => a.predictedArrivalTime - b.predictedArrivalTime);
  }
  return byStop;
}

export class TripUpdatesService extends PollingFeed<
  Map<string, IPrediction[]>
> {
  private predictionsByStop = new Map<string, IPrediction[]>();

  constructor() {
    super({
      name: 'TripUpdates',
      intervalMs: 30_000,
      timeoutMs: 15_000,
      maxAgeMs: 90_000
    });
  }

  /** Upcoming arrivals at a stop, with minutes recomputed for the current time. */
  getPredictions(stopId: string): IPrediction[] {
    const now = Date.now();
    return (this.predictionsByStop.get(stopId) ?? [])
      .filter((prediction) => prediction.predictedArrivalTime >= now)
      .map((prediction) => ({
        ...prediction,
        minutes: Math.round((prediction.predictedArrivalTime - now) / 60_000)
      }));
  }

  protected async fetchSnapshot(
    signal: AbortSignal
  ): Promise<Map<string, IPrediction[]>> {
    const response = await this.fetchOk(GTFSRT_TRIPS_URL, signal, {
      headers: { Accept: 'application/x-protobuf' }
    });
    const feed = transit_realtime.FeedMessage.decode(
      new Uint8Array(await response.arrayBuffer())
    );
    return decodePredictions(feed, Math.floor(Date.now() / 1000));
  }

  protected applySnapshot(predictionsByStop: Map<string, IPrediction[]>): void {
    this.predictionsByStop = predictionsByStop;
    let total = 0;
    for (const list of predictionsByStop.values()) total += list.length;
    this.log.info(
      `Updated: ${total} predictions across ${predictionsByStop.size} stops`
    );
  }
}

const tripUpdatesService = new TripUpdatesService();
export default tripUpdatesService;

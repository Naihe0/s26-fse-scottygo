/**
 * TripShot liveStatus Analyzer
 *
 * Polls the TripShot /v1/p/liveStatus endpoint, joins vehicle GPS positions
 * to active rides, and measures how frequently the data actually changes.
 * Intended to validate the data model before integrating into the app (TUC 2).
 *
 *   npx ts-node trials/tripshot-livestatus-analysis.ts
 *
 * Optional flags:
 *   --duration <minutes>   How long to poll (default: 5)
 *   --poll <seconds>       Poll interval (default: 10)
 *   --snapshot             Print one snapshot and exit (skips polling loop)
 *   --stops                Print all stops for each active ride, then exit
 *   ----all-stops          Print all unique stops across all rides, then exit
 */

// ── Configuration ──────────────────────────────────────────────────────

const LIVE_STATUS_URL =
  'https://cmu.tripshot.com/v1/p/liveStatus?regionId=CA558DDC-D7F2-4B48-9CAC-DEEA1134F820';

const args = process.argv.slice(2);
function argVal(flag: string, fallback: number): number {
  const idx = args.indexOf(flag);
  return idx >= 0 && args[idx + 1] ? Number(args[idx + 1]) : fallback;
}
const SNAPSHOT_MODE = args.includes('--snapshot');
const STOPS_MODE = args.includes('--stops');
const ALL_STOPS_MODE = args.includes('--all-stops');
const DURATION_MIN = argVal('--duration', 5);
const POLL_SEC = argVal('--poll', 10);
const DURATION_MS = DURATION_MIN * 60 * 1000;
const POLL_MS = POLL_SEC * 1000;

import type { TripshotLocation } from '../server/services/tripshot-api';
import type { TripshotViaStop } from '../tools/tripshot-route-summary';

// ── Types ──────────────────────────────────────────────────────────────

interface TsVehicle {
  vehicleId: string;
  name: string;
  capacity: number;
  vehicleType: string;
  wheelchairCapacity: number;
}

interface TsVehicleStatus {
  vehicleId: string;
  name: string;
  location: TripshotLocation;
  accuracy: number;
  when: string; // ISO timestamp of last GPS ping
  bearing: number | null;
  speed: number; // m/s
  liveDataAvailable: boolean;
}

type StopState =
  | {
      Awaiting: {
        expectedArrivalTime: string;
        stopId: string;
        viaIdx: number;
        scheduledAt: string;
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

// TripshotViaStop from tripshot-api covers the ViaStop shape;
// visitType is an additional field present in liveStatus vias.
type TsVia = TripshotViaStop & { ViaStop: { visitType: string } };

interface TsRide {
  rideId: string;
  routeId: string;
  routeName: string;
  vehicleId: string | null;
  vehicleName: string | null;
  state: Record<string, unknown>;
  stopStatus: StopState[];
  vias: (TsVia | Record<string, unknown>)[]; // non-ViaStop entries (e.g. ViaWaypoint) are plain objects
  riderCount: number;
  liveDataAvailable: boolean;
  scheduledStart: string;
  scheduledEnd: string;
  color: string;
}

interface TsLiveStatus {
  timestamp: string;
  vehicles: TsVehicle[];
  vehicleStatuses: TsVehicleStatus[];
  rides: TsRide[];
}

// ── Fetch ──────────────────────────────────────────────────────────────

async function fetchLiveStatus(): Promise<TsLiveStatus> {
  const res = await fetch(LIVE_STATUS_URL, {
    signal: AbortSignal.timeout(10_000)
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json() as Promise<TsLiveStatus>;
}

// ── Helpers ────────────────────────────────────────────────────────────

function isActive(ride: TsRide): boolean {
  return 'Active' in ride.state;
}

function nextAwaitingStop(
  ride: TsRide
): { stopId: string; viaIdx: number; eta: string; scheduled: string } | null {
  for (const ss of ride.stopStatus) {
    if ('Awaiting' in ss) {
      const a = ss.Awaiting;
      return {
        stopId: a.stopId,
        viaIdx: a.viaIdx,
        eta: a.expectedArrivalTime,
        scheduled: a.scheduledAt
      };
    }
  }
  return null;
}

function isTsVia(via: unknown): via is TsVia {
  return typeof via === 'object' && via !== null && 'ViaStop' in via;
}

function fmtTime(iso: string): string {
  // Convert UTC ISO to local HH:MM:SS
  return new Date(iso).toLocaleTimeString('en-US', { hour12: false });
}

function fmtSpeed(mps: number): string {
  return `${(mps * 2.237).toFixed(1)} mph`;
}

function etaDeltaSec(etaIso: string): number {
  return (new Date(etaIso).getTime() - Date.now()) / 1000;
}

// ── Snapshot printer ───────────────────────────────────────────────────

function printSnapshot(data: TsLiveStatus, label = 'Snapshot'): void {
  const active = data.rides.filter(isActive);
  const vsMap = new Map(data.vehicleStatuses.map((v) => [v.vehicleId, v]));

  console.log(`\n${'─'.repeat(72)}`);
  console.log(`  ${label}  |  API time: ${fmtTime(data.timestamp)}`);
  console.log(
    `  Fleet: ${data.vehicles.length} vehicles | Rides today: ${data.rides.length} | Active now: ${active.length}`
  );
  console.log(`${'─'.repeat(72)}`);

  if (active.length === 0) {
    console.log('  (no active rides)');
    return;
  }

  for (const ride of active) {
    const vs = ride.vehicleId ? vsMap.get(ride.vehicleId) : null;
    const next = nextAwaitingStop(ride);
    const departed = ride.stopStatus.filter((ss) => 'Departed' in ss).length;
    const total = ride.stopStatus.length;

    const locStr = vs
      ? `(${vs.location.lt.toFixed(5)}, ${vs.location.lg.toFixed(5)})`
      : '(no GPS)';
    const bearingStr =
      vs?.bearing != null ? `${vs.bearing.toFixed(0)}°` : 'n/a';
    const speedStr = vs ? fmtSpeed(vs.speed) : 'n/a';
    const gpsAge = vs
      ? `${Math.round((Date.now() - new Date(vs.when).getTime()) / 1000)}s ago`
      : 'n/a';

    console.log(`\n  Route: ${ride.routeName}`);
    console.log(
      `    Vehicle : ${ride.vehicleName ?? '?'}  |  Riders: ${ride.riderCount}  |  Live: ${ride.liveDataAvailable}`
    );
    console.log(
      `    Position: ${locStr}  bearing=${bearingStr}  speed=${speedStr}  (${gpsAge})`
    );
    console.log(`    Progress: ${departed}/${total} stops departed`);

    if (next) {
      const deltaSec = etaDeltaSec(next.eta);
      const sign = deltaSec >= 0 ? '+' : '';
      console.log(
        `    Next stop viaIdx=${next.viaIdx}: ETA ${fmtTime(next.eta)} (${sign}${deltaSec.toFixed(0)}s from now)`
      );
    } else {
      console.log(`    Next stop: all stops departed`);
    }
  }
  console.log();
}

// ── Stops printer ─────────────────────────────────────────────────────

function printStops(data: TsLiveStatus): void {
  const active = data.rides.filter(isActive);
  console.log(
    `\nActive rides: ${active.length}  |  API time: ${fmtTime(data.timestamp)}\n`
  );

  for (const ride of active) {
    console.log(`${'═'.repeat(72)}`);
    console.log(
      `  ${ride.routeName}  (vehicle: ${ride.vehicleName ?? '?'}, riders: ${ride.riderCount})`
    );
    console.log(`${'═'.repeat(72)}`);

    // Build a map from stopId → stopStatus for quick lookup
    const statusByStopId = new Map<string, string>();
    for (const ss of ride.stopStatus) {
      if ('Departed' in ss) statusByStopId.set(ss.Departed.stopId, 'DEPARTED');
      else if ('Awaiting' in ss)
        statusByStopId.set(ss.Awaiting.stopId, 'NEXT    ');
      else if ('Skipped' in ss)
        statusByStopId.set(ss.Skipped.stopId, 'SKIPPED ');
    }

    // Print each via (ordered by viaIdx = array index)
    ride.vias.forEach((via, idx) => {
      if (!isTsVia(via)) {
        console.log(
          `  [${String(idx).padStart(3)}]           (non-stop via: ${JSON.stringify(Object.keys(via))})`
        );
        return;
      }
      const s = via.ViaStop.stop;
      const status = statusByStopId.get(s.stopId) ?? '        ';
      const flags = [
        s.terminal ? 'terminal' : '',
        s.onDemand ? 'on-demand' : '',
        s.gtfsId ? `gtfs:${s.gtfsId}` : ''
      ]
        .filter(Boolean)
        .join(' ');
      console.log(
        `  [${String(idx).padStart(3)}] ${status}  ${s.name.padEnd(42)}  (${s.location.lt.toFixed(5)}, ${s.location.lg.toFixed(5)})  ${flags}`
      );
    });
    console.log();
  }
}

// ── All-stops printer ──────────────────────────────────────────────────

function printAllStops(data: TsLiveStatus): void {
  // Collect unique stops across all rides, tracking which routes serve each
  const stopMap = new Map<
    string,
    { stop: TripshotViaStop['ViaStop']['stop']; routes: Set<string> }
  >();

  for (const ride of data.rides) {
    for (const via of ride.vias) {
      if (!isTsVia(via)) continue;
      const s = via.ViaStop.stop;
      if (!stopMap.has(s.stopId)) {
        stopMap.set(s.stopId, { stop: s, routes: new Set() });
      }
      stopMap.get(s.stopId)!.routes.add(ride.routeName);
    }
  }

  const entries = [...stopMap.values()].sort((a, b) =>
    a.stop.name.localeCompare(b.stop.name)
  );

  console.log(
    `\nAll stops across ${data.rides.length} rides  |  Unique stops: ${entries.length}  |  API time: ${fmtTime(data.timestamp)}\n`
  );
  console.log(`${'─'.repeat(72)}`);
  console.log(
    `  ${'Name'.padEnd(44)} ${'Lat'.padEnd(11)} ${'Lng'.padEnd(12)} Routes`
  );
  console.log(`${'─'.repeat(72)}`);

  for (const { stop: s, routes } of entries) {
    const flags = [
      s.terminal ? '[terminal]' : '',
      s.onDemand ? '[on-demand]' : '',
      s.gtfsId ?? ''
    ]
      .filter(Boolean)
      .join(' ');
    console.log(
      `  ${s.name.padEnd(44)} ${s.location.lt.toFixed(5).padEnd(11)} ${s.location.lg.toFixed(5).padEnd(12)} ${[...routes].join(', ')}  ${flags}`
    );
  }
  console.log(`\n  Total: ${entries.length} unique stops`);
}

// ── Change tracking ────────────────────────────────────────────────────

interface PositionSample {
  when: Date;
  lat: number;
  lng: number;
}

interface VehicleTrack {
  vehicleId: string;
  name: string;
  samples: PositionSample[];
  changeIntervals: number[]; // seconds between GPS position changes
  totalDistanceM: number;
}

function haversineM(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number
): number {
  const R = 6_371_000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function updateTracks(
  tracks: Map<string, VehicleTrack>,
  data: TsLiveStatus
): void {
  for (const vs of data.vehicleStatuses) {
    if (!vs.liveDataAvailable) continue;

    let track = tracks.get(vs.vehicleId);
    if (!track) {
      track = {
        vehicleId: vs.vehicleId,
        name: vs.name,
        samples: [],
        changeIntervals: [],
        totalDistanceM: 0
      };
      tracks.set(vs.vehicleId, track);
    }

    const prev = track.samples[track.samples.length - 1];
    const { lt, lg } = vs.location;
    const moved = !prev || prev.lat !== lt || prev.lng !== lg;

    if (moved) {
      if (prev) {
        const intervalSec = (Date.now() - prev.when.getTime()) / 1000;
        track.changeIntervals.push(intervalSec);
        track.totalDistanceM += haversineM(prev.lat, prev.lng, lt, lg);
      }
      track.samples.push({ when: new Date(), lat: lt, lng: lg });
    }
  }
}

// ── Summary ────────────────────────────────────────────────────────────

function printSummary(
  tracks: Map<string, VehicleTrack>,
  totalPolls: number
): void {
  console.log(`\n${'═'.repeat(72)}`);
  console.log('  GPS UPDATE ANALYSIS');
  console.log(`  Total polls: ${totalPolls}`);
  console.log(`${'═'.repeat(72)}`);

  const active = [...tracks.values()].filter(
    (t) => t.changeIntervals.length > 0
  );

  if (active.length === 0) {
    console.log('  No position changes observed.');
    return;
  }

  // Aggregate intervals across all vehicles
  const allIntervals = active.flatMap((t) => t.changeIntervals);
  allIntervals.sort((a, b) => a - b);
  const mean = allIntervals.reduce((s, v) => s + v, 0) / allIntervals.length;
  const median =
    allIntervals.length % 2 === 0
      ? (allIntervals[allIntervals.length / 2 - 1] +
          allIntervals[allIntervals.length / 2]) /
        2
      : allIntervals[Math.floor(allIntervals.length / 2)];

  console.log(`\n  Across ${active.length} vehicles with position updates:`);
  console.log(
    `    Intervals (s): min=${allIntervals[0].toFixed(1)}  median=${median.toFixed(1)}  mean=${mean.toFixed(1)}  max=${allIntervals[allIntervals.length - 1].toFixed(1)}`
  );
  console.log(
    `    Suggested poll interval: ${Math.max(5, Math.floor(median * 0.8)).toFixed(0)}s  (80% of median, floor 5s)`
  );

  console.log(`\n  Per-vehicle breakdown:`);
  for (const t of [...active].sort(
    (a, b) => b.changeIntervals.length - a.changeIntervals.length
  )) {
    const avg =
      t.changeIntervals.reduce((s, v) => s + v, 0) / t.changeIntervals.length;
    console.log(
      `    ${t.name.padEnd(6)} updates=${t.changeIntervals.length}  avg=${avg.toFixed(1)}s  dist=${(t.totalDistanceM / 1000).toFixed(2)}km`
    );
  }

  // ETA accuracy assessment note
  console.log(`\n  ETA accuracy:`);
  console.log(`    TripShot provides 'expectedArrivalTime' per awaiting stop.`);
  console.log(
    `    To validate accuracy, compare vs actual 'arrivalTime' in Departed entries.`
  );
  console.log(
    `    Run with a longer --duration to collect before/after pairs.`
  );
  console.log();
}

// ── Main ───────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  if (ALL_STOPS_MODE) {
    console.log('Fetching all stops across all rides...');
    const data = await fetchLiveStatus();
    printAllStops(data);
    return;
  }

  if (STOPS_MODE) {
    console.log('Fetching stop lists for active rides...');
    const data = await fetchLiveStatus();
    printStops(data);
    return;
  }

  if (SNAPSHOT_MODE) {
    console.log('Fetching single snapshot...');
    const data = await fetchLiveStatus();
    printSnapshot(data, 'Single Snapshot');
    return;
  }

  console.log(
    '┌──────────────────────────────────────────────────────────────────┐'
  );
  console.log(
    '│  TripShot liveStatus Analyzer                                    │'
  );
  console.log(
    `│  Duration: ${String(DURATION_MIN).padEnd(4)} min  |  Poll: every ${String(POLL_SEC).padEnd(3)} s                    │`
  );
  console.log(
    '│  Ctrl-C to stop early (prints summary on exit)                   │'
  );
  console.log(
    '└──────────────────────────────────────────────────────────────────┘'
  );

  const tracks = new Map<string, VehicleTrack>();
  let totalPolls = 0;
  let errors = 0;
  const startTime = Date.now();

  // Print summary on Ctrl-C
  process.on('SIGINT', () => {
    console.log('\n\n[interrupted]');
    printSummary(tracks, totalPolls);
    process.exit(0);
  });

  while (Date.now() - startTime < DURATION_MS) {
    const pollStart = Date.now();
    totalPolls++;

    try {
      const data = await fetchLiveStatus();
      updateTracks(tracks, data);
      const elapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
      printSnapshot(
        data,
        `Poll #${totalPolls} (${elapsed}/${DURATION_MIN} min, ${errors} errors)`
      );
    } catch (e) {
      errors++;
      console.error(
        `  [poll #${totalPolls}] fetch error: ${e instanceof Error ? e.message : e}`
      );
    }

    const remaining = POLL_MS - (Date.now() - pollStart);
    if (remaining > 0 && Date.now() - startTime + remaining < DURATION_MS) {
      await new Promise((r) => setTimeout(r, remaining));
    }
  }

  console.log(`\n[${new Date().toISOString()}] Collection complete.`);
  printSummary(tracks, totalPolls);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});

import type { IPrediction } from '../../../common/transit.interface';

/** ETA is mutable. Prefer the agency's visit ID, then an unambiguous real bus.
 * Two visits by the same bus must remain separately selectable on a loop. */
export function keyArrivalRows(rows: IPrediction[]): Map<IPrediction, string> {
  const base = (p: IPrediction) =>
    JSON.stringify([
      p.stopId,
      p.routeId,
      p.occurrenceId
        ? ['visit', p.occurrenceId]
        : p.vid && p.vid !== 'Scheduled'
          ? ['bus', p.vid]
          : ['time', p.predictedArrivalTime]
    ]);
  const counts = new Map<string, number>();
  for (const p of rows) {
    const id = base(p);
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  const seen = new Map<string, number>();
  return new Map(
    rows.map((p) => {
      const id = base(p);
      if (counts.get(id) === 1) return [p, id];
      const timed = JSON.stringify([id, p.predictedArrivalTime]);
      const index = seen.get(timed) ?? 0;
      seen.set(timed, index + 1);
      return [p, JSON.stringify([timed, index])];
    })
  );
}

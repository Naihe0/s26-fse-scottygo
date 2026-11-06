export const validShortcutStopId = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,119}$/.test(value);

/** Stable, shareable address for a public platform. */
export function publicStopPath(stopId: string): string | null {
  return validShortcutStopId(stopId) ? '/#/map?stop=' + encodeURIComponent(stopId) : null;
}

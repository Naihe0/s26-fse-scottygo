/** Authentication carries filter data, never a user-controlled redirect URL. */
export function sanitizeMapViewHash(hash: string): string | null {
  if (hash !== '#/map' && !hash.startsWith('#/map?')) return null;
  const source = new URLSearchParams(hash.slice(6));
  const filters = new URLSearchParams();
  const route = source.get('r');
  if (route && /^[A-Za-z0-9_-]{1,80}$/.test(route)) filters.set('r', route);
  const date = source.get('d');
  if (date && /^\d{8}$/.test(date)) {
    const year = Number(date.slice(0, 4));
    const month = Number(date.slice(4, 6));
    const day = Number(date.slice(6, 8));
    const value = new Date(year, month - 1, day);
    if (
      value.getFullYear() === year &&
      value.getMonth() === month - 1 &&
      value.getDate() === day
    )
      filters.set('d', date);
  }
  const time = source.get('t');
  if (time && /^([01]\d|2[0-3])[0-5]\d$/.test(time)) filters.set('t', time);
  for (const [key, allowed] of [
    ['s', ['PRT', 'CMU']],
    ['dir', ['IB', 'OB']]
  ] as const) {
    if (!source.has(key)) continue;
    const values = source.get(key)!.split(',');
    filters.set(
      key,
      allowed.filter((value) => values.includes(value)).join(',')
    );
  }
  const query = filters.toString();
  return query ? `#/map?${query}` : '#/map';
}

export function mapSignInPath(hash = window.location.hash): string {
  return `/auth${sanitizeMapViewHash(hash) ?? ''}`;
}

export function mapReturnPath(hash = window.location.hash): string {
  return `/${sanitizeMapViewHash(hash) ?? ''}`;
}

export function returnToMapView(): void {
  window.location.replace(mapReturnPath());
}

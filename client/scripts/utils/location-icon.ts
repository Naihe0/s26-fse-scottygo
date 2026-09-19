/** Geographic markers and map-key samples share the same artwork. */
export function createLocationIcon(kind: 'gps' | 'planned'): {
  url: string;
  anchor: { x: number; y: number };
  size: { width: number; height: number };
} {
  const gps = kind === 'gps';
  const svg = gps
    ? `<svg xmlns="http://www.w3.org/2000/svg" width="44" height="44" viewBox="0 0 44 44">
        <circle cx="22" cy="22" r="20" fill="#2563eb" fill-opacity=".14" stroke="#2563eb" stroke-opacity=".24"/>
        <circle cx="22" cy="23" r="12" fill="#0f172a" fill-opacity=".18"/>
        <circle cx="22" cy="22" r="10.5" fill="#2563eb" stroke="#fff" stroke-width="3.5"/>
        <circle cx="22" cy="22" r="4" fill="#60a5fa"/>
      </svg>`
    : `<svg xmlns="http://www.w3.org/2000/svg" width="34" height="44" viewBox="0 0 34 44">
        <path d="M17 42S2 26 2 17a15 15 0 0 1 30 0c0 9-15 25-15 25Z" fill="#be123c" stroke="#fff" stroke-width="2"/>
        <circle cx="17" cy="17" r="6" fill="#fff"/>
        <circle cx="17" cy="17" r="2.5" fill="#be123c"/>
      </svg>`;
  return {
    url: 'data:image/svg+xml;charset=UTF-8,' + encodeURIComponent(svg),
    anchor: gps ? { x: 22, y: 22 } : { x: 17, y: 42 },
    size: gps ? { width: 44, height: 44 } : { width: 34, height: 44 }
  };
}

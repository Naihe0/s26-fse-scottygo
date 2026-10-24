/** Compact, centered station dots with a stable touch and keyboard target. */
export const STOP_ICON_SIZE = 28;

export function stopDotSize(zoom: number): number {
  return zoom >= 16 ? 12 : zoom >= 14 ? 10 : 8;
}

export function createStopIcon(
  color: string,
  zoom: number,
  options: { shared?: boolean; selected?: boolean } = {}
) {
  const routeColor = /^#[\da-f]{3}(?:[\da-f]{3})?$/i.test(color)
    ? color
    : '#c41230';
  const diameter = stopDotSize(zoom) + (options.selected ? 4 : 0);
  const center = STOP_ICON_SIZE / 2;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 28 28">
    <rect width="28" height="28" fill="transparent"/>
    ${options.selected ? '<circle cx="14" cy="14" r="12" fill="#c41230" fill-opacity="0.16"/>' : ''}
    <circle cx="14" cy="14" r="${diameter / 2 + 0.65}" fill="#172033" fill-opacity="0.28"/>
    <circle cx="14" cy="14" r="${diameter / 2 - 1}" fill="#ffffff" stroke="${options.selected ? '#c41230' : options.shared ? '#64748b' : routeColor}" stroke-width="2"/>
    ${options.shared ? '<circle cx="14" cy="14" r="1.5" fill="#64748b"/>' : ''}
  </svg>`;
  return {
    url: 'data:image/svg+xml;charset=UTF-8,' + encodeURIComponent(svg),
    anchor: { x: center, y: center },
    size: { width: STOP_ICON_SIZE, height: STOP_ICON_SIZE }
  };
}

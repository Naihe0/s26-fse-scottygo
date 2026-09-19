/**
 * Bus icon SVG generator.
 * Extracted from VehicleTracker so icon appearance can change independently
 * of polling/state logic.
 */

import type { IVehicle } from '../../../common/transit.interface';

/**
 * Build a data-URI SVG bus icon for a given vehicle and map zoom level.
 *
 * @param vehicle    - The vehicle whose heading and detour status drive the icon.
 * @param zoom       - Current map zoom level (used to scale the icon).
 * @param routeColor - The route's display colour (hex). Detoured buses override
 *                     this with amber automatically.
 */
export function createBusIcon(
  vehicle: IVehicle,
  zoom: number,
  routeColor: string
): {
  url: string;
  anchor: { x: number; y: number };
  size: { width: number; height: number };
} {
  // Only hex colors may enter SVG markup; feed-supplied metadata stays out.
  const routeHex = typeof routeColor === 'string' ? routeColor.trim() : '';
  const safeColor = /^#?(?:[\da-f]{3}|[\da-f]{6})$/i.test(routeHex)
    ? `#${routeHex.replace(/^#/, '')}`
    : '#2563eb';
  const color = vehicle.isDetoured ? '#d97706' : safeColor;

  const safeZoom = Number.isFinite(zoom) ? zoom : 14;
  const sz = Math.round(Math.max(32, Math.min(44, 32 + (safeZoom - 10) * 2)));
  const heading =
    typeof vehicle.heading === 'number' && Number.isFinite(vehicle.heading)
      ? ((vehicle.heading % 360) + 360) % 360
      : null;

  // The pointer starts north. SVG's clockwise rotation matches compass bearing;
  // only the pointer rotates, so the bus pictogram stays upright in every direction.
  const pointer =
    heading === null
      ? ''
      : `<g data-part="heading" transform="rotate(${heading} 24 24)">` +
        `<path d="M24 2.5 19.5 8.5 28.5 8.5Z" fill="${color}" stroke="#0f172a" stroke-opacity="0.2" stroke-width="3" stroke-linejoin="round"/>` +
        `<path d="M24 2.5 19.5 8.5 28.5 8.5Z" fill="${color}" stroke="#fff" stroke-width="1.75" stroke-linejoin="round"/>` +
        `</g>`;

  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${sz}" height="${sz}" viewBox="0 0 48 48">` +
    pointer +
    `<circle cx="24" cy="24.5" r="15.5" fill="#0f172a" fill-opacity="0.18"/>` +
    `<circle data-part="badge" cx="24" cy="24" r="13.5" fill="${color}" stroke="#fff" stroke-width="3"/>` +
    `<g data-part="bus" fill="#fff" stroke="#0f172a" stroke-opacity="0.2" stroke-width="0.7">` +
    `<rect x="18" y="16" width="12" height="15" rx="3"/>` +
    `<path d="M19.5 30v2M28.5 30v2" stroke="#fff" stroke-opacity="1" stroke-width="2" stroke-linecap="round"/>` +
    `</g>` +
    `<rect x="20" y="18.5" width="8" height="5.5" rx="1" fill="#0f172a" fill-opacity="0.72"/>` +
    `<circle cx="20.5" cy="27.5" r="1" fill="#0f172a" fill-opacity="0.72"/>` +
    `<circle cx="27.5" cy="27.5" r="1" fill="#0f172a" fill-opacity="0.72"/>` +
    `</svg>`;

  return {
    url: 'data:image/svg+xml;charset=UTF-8,' + encodeURIComponent(svg),
    anchor: { x: sz / 2, y: sz / 2 },
    size: { width: sz, height: sz }
  };
}

import type { ILatLng, IMapProvider } from '../../../common/map.interface';

const EARTH_CIRCUMFERENCE_METERS = 40_075_016.686;
const TILE_SIZE = 256;
const EDGE_PADDING = 24;
const MAX_MERCATOR_LATITUDE = 85.05112878;

function visibleViewport(): {
  height: number;
  width: number;
  top: number;
  bottom: number;
} {
  const mapElement =
    document.getElementById('map') ?? document.querySelector('.map-container');
  const rect = mapElement?.getBoundingClientRect();
  const width = rect?.width || window.innerWidth || 390;
  const height = rect?.height || window.innerHeight || 600;
  let top = EDGE_PADDING;
  let bottom = height - EDGE_PADDING;

  // The app header is outside the map. Reserve only overlays inside its bounds.
  if (rect?.height && rect.width) {
    // The custom-element host has no box: its visible search bar is absolute.
    const search =
      document.querySelector('transit-search .search-bar') ??
      document.querySelector('transit-search');
    const searchRect = search?.getBoundingClientRect();
    if (searchRect?.height && searchRect.top < rect.top + height / 2) {
      top = Math.max(top, searchRect.bottom - rect.top + 16);
    }
    for (const overlay of document.querySelectorAll<HTMLElement>(
      '#map-popup, #directions-panel, #planned-location-popup'
    )) {
      const overlayRect = overlay.getBoundingClientRect();
      if (
        !overlay.hidden &&
        overlayRect.height > 0 &&
        overlayRect.width > 0 &&
        overlayRect.left < rect.right &&
        overlayRect.right > rect.left &&
        overlayRect.bottom > rect.top + height / 2
      ) {
        bottom = Math.min(bottom, overlayRect.top - rect.top - 16);
      }
    }
  }

  // Do not invent extra free height on a short landscape screen: that would
  // put the selected point back under the popup. Keep its actual visible gap.
  bottom = Math.max(0, Math.min(height, bottom));
  top = Math.max(0, Math.min(top, bottom));
  return { height, width, top, bottom };
}

/**
 * Focus a roughly 200m radius around a point, keeping it above an open popup.
 * A closer existing zoom is preserved. This is for explicit focus actions, not
 * routine GPS/bus samples: incoming observations must not move the rider's map.
 */
export function focusNearby(
  map: Pick<IMapProvider, 'getZoom' | 'setZoom' | 'setCenter'>,
  position: ILatLng,
  radiusMeters = 200
): void {
  if (
    !Number.isFinite(position.lat) ||
    !Number.isFinite(position.lng) ||
    Math.abs(position.lat) > 90 ||
    Math.abs(position.lng) > 180
  )
    return;

  const radius =
    Number.isFinite(radiusMeters) && radiusMeters > 0 ? radiusMeters : 200;
  const viewport = visibleViewport();
  const latitude = Math.max(
    -MAX_MERCATOR_LATITUDE,
    Math.min(MAX_MERCATOR_LATITUDE, position.lat)
  );
  const latitudeRadians = (latitude * Math.PI) / 180;
  const usablePixels = Math.max(
    80,
    Math.min(viewport.width - EDGE_PADDING * 2, viewport.bottom - viewport.top)
  );
  const nearbyZoom = Math.max(
    1,
    Math.min(
      20,
      Math.round(
        Math.log2(
          (EARTH_CIRCUMFERENCE_METERS *
            Math.cos(latitudeRadians) *
            usablePixels) /
            (TILE_SIZE * radius * 2)
        )
      )
    )
  );
  const currentZoom = map.getZoom();
  const zoom = Number.isFinite(currentZoom)
    ? Math.max(currentZoom, nearbyZoom)
    : nearbyZoom;
  if (zoom !== currentZoom) map.setZoom(zoom);

  const pixelOffset = (viewport.top + viewport.bottom - viewport.height) / 2;
  if (pixelOffset === 0) {
    map.setCenter(position);
    return;
  }
  // Shift the map's center, not the geographic marker, into the uncovered area.
  const worldY =
    (1 - Math.log(Math.tan(Math.PI / 4 + latitudeRadians / 2)) / Math.PI) / 2;
  const centerY = worldY - pixelOffset / (TILE_SIZE * 2 ** zoom);
  const centerLatitude =
    (Math.atan(Math.sinh(Math.PI * (1 - 2 * centerY))) * 180) / Math.PI;
  map.setCenter({ lat: centerLatitude, lng: position.lng });
}

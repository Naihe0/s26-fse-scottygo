/** Renders routes and stops independently of the map SDK. */
import type {
  IMapProvider,
  IMapPolyline,
  IMapMarker,
  ILatLng,
  IMapPolylineOptions
} from '../../../common/map.interface';
import type { IStop, IDetour } from '../../../common/transit.interface';
import { createStopIcon, stopDotSize } from '../utils/stop-icon';

const SELECTED_STOP_ROUTE = '__selected_stop__';
const SELECTED_STOP_DIRECTION = 'SELECTED';

interface GeoJSONGeometry {
  type: string;
  coordinates: number[][];
}

interface GeoJSONFeature {
  type: string;
  geometry?: GeoJSONGeometry;
  properties?: Record<string, unknown>;
}

interface GeoJSONFeatureCollection {
  type: 'FeatureCollection';
  features: GeoJSONFeature[];
}

type GeoJSON = GeoJSONFeature | GeoJSONFeatureCollection;

export interface RoutePathSegment {
  direction: string;
  path: ILatLng[];
}

export type RouteData = GeoJSON | RoutePathSegment[];

interface RenderedSegment {
  direction: string | null;
  path: ILatLng[];
  polylines: IMapPolyline[];
  color: string;
  detour: boolean;
}

interface RenderedStops {
  routeId: string;
  direction: string;
  stopKeys: Set<string>;
}

interface StopOwner {
  routeId: string;
  direction: string;
  stop: IStop;
  onClick?: (stop: IStop) => void;
}

interface SharedStop {
  marker: IMapMarker;
  position: ILatLng;
  owners: Map<string, StopOwner>;
  iconKey: string;
  visible: boolean;
}

function isPosition(point: ILatLng): boolean {
  return (
    !!point &&
    Number.isFinite(point.lat) &&
    Math.abs(point.lat) <= 90 &&
    Number.isFinite(point.lng) &&
    Math.abs(point.lng) <= 180
  );
}

export class RouteRenderer {
  private static instance: RouteRenderer;
  private mapProvider: IMapProvider | null = null;
  // Route ownership is explicit: underscores and custom direction names are safe.
  private routePolylines = new Map<string, RenderedSegment[]>();
  private detourPolylines = new Map<string, RenderedSegment[]>();
  private stopMarkers = new Map<string, RenderedStops>();
  private sharedStops = new Map<string, SharedStop>();
  private routeColors = new Map<string, string>();
  private hiddenRoutes = new Set<string>();
  private hiddenDirections = new Map<string, Set<string>>();
  private zoomProviders = new WeakSet<IMapProvider>();
  private focusedRoute: string | null = null;
  private focusedStop: string | null = null;
  private onRouteClickCallback:
    | ((routeIds: string[], position: ILatLng) => void)
    | null = null;

  private constructor() {}

  static getInstance(): RouteRenderer {
    if (!RouteRenderer.instance) RouteRenderer.instance = new RouteRenderer();
    return RouteRenderer.instance;
  }

  initialize(mapProvider: IMapProvider): void {
    if (this.mapProvider !== mapProvider) this.clearAllRoutes();
    this.mapProvider = mapProvider;
    if (this.zoomProviders.has(mapProvider)) return;
    this.zoomProviders.add(mapProvider);
    mapProvider.onZoomChanged(() => {
      if (this.mapProvider !== mapProvider) return;
      this.refreshStops();
      this.refreshRouteStyles();
    });
  }

  /** Emphasize a selected route without concealing its surrounding network. */
  setFocusedRoute(routeId: string | null): void {
    if (this.focusedRoute === routeId) return;
    this.focusedRoute = routeId;
    this.refreshRouteStyles();
    this.refreshStops();
  }

  /** Keep a selected platform visible while the user zooms out. */
  setFocusedStop(stopId: string | null): void {
    if (this.focusedStop === stopId) return;
    this.focusedStop = stopId;
    this.refreshStops();
  }

  /** Keep an explicitly chosen stop visible even outside the currently drawn routes. */
  setSelectedStop(
    stop: IStop | null,
    onStopClick?: (stop: IStop) => void
  ): void {
    this.focusedStop = stop?.stopId ?? null;
    if (stop) {
      this.renderStopMarkers(
        SELECTED_STOP_ROUTE,
        [stop],
        SELECTED_STOP_DIRECTION,
        onStopClick
      );
    } else {
      this.clearStopMarkers(
        `${SELECTED_STOP_ROUTE}_${SELECTED_STOP_DIRECTION}`
      );
    }
    this.refreshStops();
  }

  setRouteClickCallback(
    cb: (routeIds: string[], position: ILatLng) => void
  ): void {
    this.onRouteClickCallback = cb;
  }

  getRouteColor(routeId: string): string {
    return this.routeColors.get(routeId) || '#c41230';
  }

  /** Include only visible geometry; test complete segments, not just vertices. */
  getRoutesAtPosition(position: ILatLng, radiusPixels = 24): string[] {
    if (!isPosition(position)) return [];
    const hits = new Set<string>();
    const scale = Math.cos((position.lat * Math.PI) / 180);
    // Match a finger-sized target at the current scale, rather than a fixed
    // geographic radius that becomes too broad when zoomed into a street.
    const zoom = this.mapProvider?.getZoom() ?? 14;
    const thresholdSquared =
      ((360 * Math.max(0, radiusPixels) * scale) / (256 * 2 ** zoom)) ** 2;
    for (const overlays of [this.routePolylines, this.detourPolylines]) {
      for (const [routeId, segments] of overlays) {
        if (hits.has(routeId)) continue;
        for (const segment of segments) {
          if (!this.segmentVisible(routeId, segment)) continue;
          for (let i = 1; i < segment.path.length; i++) {
            const a = segment.path[i - 1];
            const b = segment.path[i];
            const ax = (a.lng - position.lng) * scale;
            const ay = a.lat - position.lat;
            const dx = (b.lng - a.lng) * scale;
            const dy = b.lat - a.lat;
            const lengthSquared = dx * dx + dy * dy;
            const t = lengthSquared
              ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / lengthSquared))
              : 0;
            if ((ax + t * dx) ** 2 + (ay + t * dy) ** 2 <= thresholdSquared) {
              hits.add(routeId);
              break;
            }
          }
          if (hits.has(routeId)) break;
        }
      }
    }
    return [...hits];
  }

  private segmentVisible(routeId: string, segment: RenderedSegment): boolean {
    return (
      !this.hiddenRoutes.has(routeId) &&
      !(
        segment.direction &&
        this.hiddenDirections.get(routeId)?.has(segment.direction)
      )
    );
  }

  private routeStyles(
    routeId: string,
    color: string,
    detour: boolean
  ): Array<Omit<IMapPolylineOptions, 'path'>> {
    const zoom = this.mapProvider?.getZoom() ?? 14;
    const selected = this.focusedRoute === routeId;
    const dimmed = this.focusedRoute !== null && !selected;
    const weight = selected
      ? 4.5
      : dimmed
        ? 1.75
        : zoom < 14
          ? 2
          : zoom < 16
            ? 2.75
            : 3.25;
    const opacity = selected ? 1 : dimmed ? 0.23 : zoom < 14 ? 0.62 : 0.82;
    const zIndex = selected ? 24 : detour ? 20 : 10;
    return [
      {
        color: '#ffffff',
        weight: (detour ? Math.max(weight, 4.5) : weight) + 2,
        opacity: dimmed ? 0.25 : 0.85,
        zIndex
      },
      {
        color,
        weight: detour ? Math.max(weight, 4.5) : weight,
        opacity: detour && !dimmed ? 1 : opacity,
        zIndex: zIndex + 1
      }
    ];
  }

  private refreshRouteStyles(): void {
    for (const overlays of [this.routePolylines, this.detourPolylines]) {
      for (const [routeId, segments] of overlays) {
        for (const segment of segments) {
          const styles = this.routeStyles(
            routeId,
            segment.color,
            segment.detour
          );
          segment.polylines.forEach((polyline, index) =>
            polyline.setStyle?.(styles[index])
          );
        }
      }
    }
  }

  /** Both strokes are clickable, so the casing remains a useful hit area. */
  private renderSegment(
    routeId: string,
    direction: string | null,
    path: ILatLng[],
    color: string,
    detour = false
  ): RenderedSegment | null {
    if (!Array.isArray(path) || path.length < 2 || !path.every(isPosition))
      return null;
    const points = path.map((point) => ({ lat: point.lat, lng: point.lng }));
    const polylines = this.routeStyles(routeId, color, detour).map((style) =>
      this.mapProvider!.addPolyline({
        path: points,
        ...style,
        selection: {
          id: `route:${routeId}`,
          kind: 'route',
          label: `Route ${routeId}`
        }
      })
    );
    for (const polyline of polylines) {
      polyline.onClick((position) => {
        if (!this.onRouteClickCallback) return;
        this.onRouteClickCallback([routeId], position);
      });
    }
    const segment = { direction, path: points, polylines, color, detour };
    if (!this.segmentVisible(routeId, segment)) {
      polylines.forEach((polyline) => polyline.setVisible(false));
    }
    return segment;
  }

  renderRouteGeometry(
    routeId: string,
    routeData: RouteData,
    color: string
  ): void {
    if (!this.mapProvider) return;
    // A color/geometry refresh must preserve the user's active visibility.
    this.removeRouteGeometry(routeId);
    this.routeColors.set(routeId, color);
    this.refreshStops();
    const segments: RenderedSegment[] = [];
    for (const { direction, path } of this.readPaths(routeData)) {
      const segment = this.renderSegment(routeId, direction, path, color);
      if (segment) segments.push(segment);
    }
    if (segments.length) this.routePolylines.set(routeId, segments);
  }

  private readPaths(
    routeData: RouteData
  ): Array<{ direction: string | null; path: ILatLng[] }> {
    if (!routeData || typeof routeData !== 'object') return [];
    if (Array.isArray(routeData))
      return routeData.filter((segment) => !!segment);
    const features =
      routeData.type === 'FeatureCollection'
        ? (routeData as GeoJSONFeatureCollection).features
        : [routeData as GeoJSONFeature];
    if (!Array.isArray(features)) return [];
    return features.flatMap((feature) => {
      if (
        feature?.geometry?.type !== 'LineString' ||
        !Array.isArray(feature.geometry.coordinates)
      )
        return [];
      return [
        {
          direction: null,
          path: feature.geometry.coordinates.map((coord) => ({
            lat: coord?.[1],
            lng: coord?.[0]
          }))
        }
      ];
    });
  }

  renderDetourGeometry(routeId: string, detours: IDetour[]): void {
    if (!this.mapProvider) return;
    this.clearDetourPolylines(routeId);
    const segments: RenderedSegment[] = [];
    for (const detour of Array.isArray(detours) ? detours : []) {
      const geometries = Array.isArray(detour?.geometry) ? detour.geometry : [];
      for (const geometry of geometries) {
        if (!geometry || typeof geometry.direction !== 'string') continue;
        for (const path of this.extractImpactedSegments(
          geometry.detourPath,
          geometry.originalPath ?? []
        )) {
          const segment = this.renderSegment(
            routeId,
            geometry.direction,
            path,
            '#e9462f',
            true
          );
          if (segment) segments.push(segment);
        }
      }
    }
    if (segments.length) this.detourPolylines.set(routeId, segments);
  }

  private extractImpactedSegments(
    detourPath: ILatLng[],
    originalPath: ILatLng[]
  ): ILatLng[][] {
    if (
      !Array.isArray(detourPath) ||
      detourPath.length < 2 ||
      !detourPath.every(isPosition) ||
      !Array.isArray(originalPath) ||
      !originalPath.every(isPosition)
    )
      return [];
    if (originalPath.length < 2) return [detourPath];
    const toleranceDeg = 0.00025;
    const segments: ILatLng[][] = [];
    let current: ILatLng[] = [];
    for (const point of detourPath) {
      const isShared = originalPath.some(
        (orig) =>
          Math.abs(point.lat - orig.lat) <= toleranceDeg &&
          Math.abs(point.lng - orig.lng) <= toleranceDeg
      );
      if (!isShared) current.push(point);
      else if (current.length) {
        if (current.length > 1) segments.push(current);
        current = [];
      }
    }
    if (current.length > 1) segments.push(current);
    return segments.length ? segments : [detourPath];
  }

  renderStopMarkers(
    routeId: string,
    stops: IStop[],
    direction: string,
    onStopClick?: (stop: IStop) => void
  ): void {
    if (!this.mapProvider) return;
    const key = `${routeId}_${direction}`;
    const previous = this.stopMarkers.get(key);
    const stopKeys = new Set<string>();
    for (const stop of Array.isArray(stops) ? stops : []) {
      if (!stop) continue;
      const position = { lat: stop.lat, lng: stop.lon };
      if (!isPosition(position)) continue;
      // Keep opposite platforms separate even when they have the same name.
      const stopKey = `${stop.stopId}:${stop.lat.toFixed(5)}:${stop.lon.toFixed(5)}`;
      if (stopKeys.has(stopKey)) continue;
      stopKeys.add(stopKey);
      let shared = this.sharedStops.get(stopKey);
      if (!shared) {
        const detail =
          (routeId === 'NEARBY' || routeId === SELECTED_STOP_ROUTE
            ? (stop.routes ?? [])
            : [routeId]
          ).join(' · ') || 'Bus stop';
        const icon = createStopIcon(
          this.getRouteColor(routeId),
          this.mapProvider.getZoom()
        );
        const marker = this.mapProvider.addMarker({
          position,
          title: `${stop.stopName} · ${detail}`,
          icon: icon.url,
          iconAnchor: icon.anchor,
          iconSize: icon.size,
          zIndex: 30,
          selection: {
            id: `stop:${stopKey}`,
            kind: 'stop',
            label: stop.stopName,
            detail
          }
        });
        shared = {
          marker,
          position,
          owners: new Map(),
          iconKey: `${this.getRouteColor(routeId)}:${stopDotSize(this.mapProvider.getZoom())}:false:false`,
          visible: true
        };
        this.sharedStops.set(stopKey, shared);
        marker.onClick(() => {
          const current = this.sharedStops.get(stopKey);
          if (!current?.visible) return;
          const owners = this.visibleStopOwners(current);
          const owner =
            owners.find(
              (entry) => entry.routeId === this.focusedRoute && entry.onClick
            ) ?? owners.find((entry) => entry.onClick);
          owner?.onClick?.(this.stopWithRoutes(owner.stop, owners));
        });
      }
      shared.owners.set(key, {
        routeId,
        direction,
        stop,
        onClick: onStopClick
      });
    }
    for (const stopKey of previous?.stopKeys ?? []) {
      if (!stopKeys.has(stopKey)) this.releaseStopOwner(stopKey, key);
    }
    this.stopMarkers.set(key, { routeId, direction, stopKeys });
    this.refreshStops();
  }

  private visibleStopOwners(shared: SharedStop): StopOwner[] {
    return [...shared.owners.values()].filter(
      (owner) =>
        owner.routeId === SELECTED_STOP_ROUTE ||
        (!this.hiddenRoutes.has(owner.routeId) &&
          !this.hiddenDirections.get(owner.routeId)?.has(owner.direction))
    );
  }

  private routesForOwners(owners: StopOwner[]): string[] {
    return [
      ...new Set(
        owners.flatMap((owner) => [
          ...(owner.routeId !== 'NEARBY' &&
          owner.routeId !== SELECTED_STOP_ROUTE
            ? [owner.routeId]
            : []),
          ...(owner.direction === 'NEARBY' ||
          owner.routeId === SELECTED_STOP_ROUTE
            ? (owner.stop.routes ?? [])
            : [])
        ])
      )
    ].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  }

  private stopWithRoutes(stop: IStop, owners: StopOwner[]): IStop {
    const routes = this.routesForOwners(owners);
    return {
      ...stop,
      routes: [...new Set([...(stop.routes ?? []), ...routes])]
    };
  }

  private refreshStops(): void {
    if (!this.mapProvider) return;
    const zoom = this.mapProvider.getZoom();
    for (const [key, shared] of this.sharedStops) {
      const owners = this.visibleStopOwners(shared);
      const owner = owners[0] ?? shared.owners.values().next().value;
      if (!owner) continue;
      const routes = this.routesForOwners(owners);
      const focused = owner.stop.stopId === this.focusedStop;
      const visible = owners.length > 0 && (zoom >= 14 || focused);
      if (visible !== shared.visible) {
        shared.visible = visible;
        shared.marker.setVisible(visible);
      }
      const color =
        routes.length === 1 ? this.getRouteColor(routes[0]) : '#64748b';
      const iconKey = `${color}:${stopDotSize(zoom)}:${routes.length > 1}:${focused}`;
      if (iconKey !== shared.iconKey) {
        shared.marker.setIcon(
          createStopIcon(color, zoom, {
            shared: routes.length > 1,
            selected: focused
          })
        );
        shared.iconKey = iconKey;
      }
      const detail = routes.length ? routes.join(' · ') : 'Bus stop';
      shared.marker.setTitle?.(`${owner.stop.stopName} · ${detail}`);
      shared.marker.setSelection?.({
        id: `stop:${key}`,
        kind: 'stop',
        label: owner.stop.stopName,
        detail
      });
    }
  }

  private releaseStopOwner(stopKey: string, ownerKey: string): void {
    const shared = this.sharedStops.get(stopKey);
    if (!shared) return;
    shared.owners.delete(ownerKey);
    if (!shared.owners.size) {
      shared.marker.remove();
      this.sharedStops.delete(stopKey);
    }
  }

  hideRoute(routeId: string): void {
    this.hiddenRoutes.add(routeId);
    this.applyRouteVisibility(routeId);
  }

  showRoute(routeId: string): void {
    this.hiddenRoutes.delete(routeId);
    this.applyRouteVisibility(routeId);
  }

  hideDirectionPolylines(routeId: string, direction: string): void {
    if (!this.hiddenDirections.has(routeId))
      this.hiddenDirections.set(routeId, new Set());
    this.hiddenDirections.get(routeId)!.add(direction);
    this.applyRouteVisibility(routeId);
  }

  showDirectionPolylines(routeId: string, direction: string): void {
    this.hiddenDirections.get(routeId)?.delete(direction);
    this.applyRouteVisibility(routeId);
  }

  private applyRouteVisibility(routeId: string): void {
    for (const overlays of [this.routePolylines, this.detourPolylines]) {
      for (const segment of overlays.get(routeId) ?? []) {
        const visible = this.segmentVisible(routeId, segment);
        segment.polylines.forEach((polyline) => polyline.setVisible(visible));
      }
    }
    this.refreshStops();
  }

  hasRouteGeometry(routeId: string): boolean {
    return this.routePolylines.has(routeId);
  }

  clearRoutePolylines(routeId: string): void {
    this.removeRouteGeometry(routeId);
    this.hiddenRoutes.delete(routeId);
    this.hiddenDirections.delete(routeId);
  }

  private removeRouteGeometry(routeId: string): void {
    this.removeSegments(this.routePolylines.get(routeId));
    this.routePolylines.delete(routeId);
    this.clearDetourPolylines(routeId);
  }

  clearDetourPolylines(routeId: string): void {
    this.removeSegments(this.detourPolylines.get(routeId));
    this.detourPolylines.delete(routeId);
  }

  private removeSegments(segments: RenderedSegment[] | undefined): void {
    segments?.forEach(({ polylines }) =>
      polylines.forEach((polyline) => polyline.remove())
    );
  }

  clearStopMarkers(key: string): void {
    for (const stopKey of this.stopMarkers.get(key)?.stopKeys ?? []) {
      this.releaseStopOwner(stopKey, key);
    }
    this.stopMarkers.delete(key);
    this.refreshStops();
  }

  clearAllRoutes(): void {
    this.routePolylines.forEach((segments) => this.removeSegments(segments));
    this.routePolylines.clear();
    this.detourPolylines.forEach((segments) => this.removeSegments(segments));
    this.detourPolylines.clear();
    this.sharedStops.forEach(({ marker }) => marker.remove());
    this.sharedStops.clear();
    this.stopMarkers.clear();
    this.routeColors.clear();
    this.hiddenRoutes.clear();
    this.hiddenDirections.clear();
    this.focusedRoute = null;
    this.focusedStop = null;
  }

  private boundsOf(
    points: ILatLng[]
  ): { north: number; south: number; east: number; west: number } | null {
    let bounds: {
      north: number;
      south: number;
      east: number;
      west: number;
    } | null = null;
    for (const point of points) {
      if (!isPosition(point)) continue;
      if (!bounds)
        bounds = {
          north: point.lat,
          south: point.lat,
          east: point.lng,
          west: point.lng
        };
      else {
        bounds.north = Math.max(bounds.north, point.lat);
        bounds.south = Math.min(bounds.south, point.lat);
        bounds.east = Math.max(bounds.east, point.lng);
        bounds.west = Math.min(bounds.west, point.lng);
      }
    }
    return bounds;
  }

  fitToRouteData(routeData: RouteData): void {
    if (!this.mapProvider) return;
    const bounds = this.boundsOf(
      this.readPaths(routeData).flatMap(({ path }) =>
        Array.isArray(path) ? path : []
      )
    );
    if (bounds) this.mapProvider.fitBounds(bounds);
  }

  /** Fit only the route and detour directions currently visible to the rider. */
  fitToVisibleRoute(routeId: string): boolean {
    if (!this.mapProvider) return false;
    const points = [this.routePolylines, this.detourPolylines].flatMap(
      (overlays) =>
        (overlays.get(routeId) ?? [])
          .filter((segment) => this.segmentVisible(routeId, segment))
          .flatMap((segment) => segment.path)
    );
    const bounds = this.boundsOf(points);
    if (!bounds) return false;
    this.mapProvider.fitBounds(bounds);
    return true;
  }
}

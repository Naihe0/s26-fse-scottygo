/** Renders routes and stops independently of the map SDK. */
import type {
  IMapProvider,
  IMapPolyline,
  IMapMarker,
  ILatLng
} from '../../../common/map.interface';
import type { IStop, IDetour } from '../../../common/transit.interface';
import { createStopIcon, stopDotSize } from '../utils/stop-icon';

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
}

interface RenderedStops {
  markers: IMapMarker[];
  color: string;
  positions: ILatLng[];
  routeId: string;
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
  private routeColors = new Map<string, string>();
  private hiddenRoutes = new Set<string>();
  private hiddenDirections = new Map<string, Set<string>>();
  private zoomProviders = new WeakSet<IMapProvider>();
  private dotSize = 10;
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
    this.dotSize = stopDotSize(mapProvider.getZoom());
    if (this.zoomProviders.has(mapProvider)) return;
    this.zoomProviders.add(mapProvider);
    mapProvider.onZoomChanged((zoom) => {
      if (
        this.mapProvider !== mapProvider ||
        this.dotSize === stopDotSize(zoom)
      )
        return;
      this.dotSize = stopDotSize(zoom);
      for (const { markers, color } of this.stopMarkers.values()) {
        const icon = createStopIcon(color, zoom);
        markers.forEach((marker) => marker.setIcon(icon));
      }
    });
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
  getRoutesAtPosition(position: ILatLng): string[] {
    if (!isPosition(position)) return [];
    const hits = new Set<string>();
    const scale = Math.cos((position.lat * Math.PI) / 180);
    const thresholdSquared = 0.0003 ** 2; // About 33 m, adjusted for longitude.
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
    const polylines = [
      this.mapProvider!.addPolyline({
        path: points,
        color: '#ffffff',
        weight: detour ? 7 : 6,
        opacity: 0.95,
        zIndex: detour ? 20 : 10
      }),
      this.mapProvider!.addPolyline({
        path: points,
        color,
        weight: detour ? 4.5 : 3.5,
        opacity: 1,
        zIndex: detour ? 21 : 11
      })
    ];
    for (const polyline of polylines) {
      polyline.onClick((position) => {
        if (!this.onRouteClickCallback) return;
        const overlapping = this.getRoutesAtPosition(position);
        if (!overlapping.includes(routeId)) overlapping.unshift(routeId);
        this.onRouteClickCallback(overlapping, position);
      });
    }
    const segment = { direction, path: points, polylines };
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
    for (const stops of this.stopMarkers.values()) {
      if (stops.routeId !== routeId || stops.color === color) continue;
      stops.color = color;
      const icon = createStopIcon(color, this.mapProvider.getZoom());
      stops.markers.forEach((marker) => marker.setIcon(icon));
    }
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
    this.clearStopMarkers(key);
    const color = this.getRouteColor(routeId);
    const icon = createStopIcon(color, this.mapProvider.getZoom());
    const markers: IMapMarker[] = [];
    const positions: ILatLng[] = [];
    const seen = new Set<string>();
    for (const stop of stops) {
      const position = { lat: stop.lat, lng: stop.lon };
      if (!isPosition(position) || seen.has(stop.stopId)) continue;
      seen.add(stop.stopId);
      const marker = this.mapProvider.addMarker({
        position,
        title: `${stop.stopName} (Stop #${markers.length + 1})`,
        icon: icon.url,
        iconAnchor: icon.anchor,
        iconSize: icon.size,
        zIndex: 30
      });
      if (onStopClick) marker.onClick(() => onStopClick(stop));
      markers.push(marker);
      positions.push(position);
    }
    this.stopMarkers.set(key, { markers, color, positions, routeId });
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
    this.stopMarkers.get(key)?.markers.forEach((marker) => marker.remove());
    this.stopMarkers.delete(key);
  }

  clearAllRoutes(): void {
    this.routePolylines.forEach((segments) => this.removeSegments(segments));
    this.routePolylines.clear();
    this.detourPolylines.forEach((segments) => this.removeSegments(segments));
    this.detourPolylines.clear();
    this.stopMarkers.forEach(({ markers }) =>
      markers.forEach((marker) => marker.remove())
    );
    this.stopMarkers.clear();
    this.routeColors.clear();
    this.hiddenRoutes.clear();
    this.hiddenDirections.clear();
  }

  updateVisibleRoutes(visibleRouteIds: string[]): void {
    const visibleSet = new Set(visibleRouteIds);
    for (const routeId of new Set([
      ...this.routePolylines.keys(),
      ...this.detourPolylines.keys()
    ])) {
      if (visibleSet.has(routeId)) this.showRoute(routeId);
      else this.hideRoute(routeId);
    }
  }

  getRenderedRouteIds(): string[] {
    return [...this.routePolylines.keys()];
  }

  getRouteBounds(
    routeId: string
  ): { north: number; south: number; east: number; west: number } | null {
    const points = (this.routePolylines.get(routeId) ?? []).flatMap(
      ({ path }) => path
    );
    for (const stops of this.stopMarkers.values()) {
      if (stops.routeId === routeId) points.push(...stops.positions);
    }
    return this.boundsOf(points);
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

  zoomToPosition(lat: number, lng: number, zoom = 16): void {
    this.mapProvider?.setCenter({ lat, lng });
    this.mapProvider?.setZoom(zoom);
  }
}

// Map configuration and the map-provider abstraction, which decouples the
// app from a specific map SDK (Google Maps today).

export interface IConfig {
  apiKey: string;
  lat: number; // Default center latitude
  lon: number; // Default center longitude
  defaultZoom: number;
}

export interface ILatLng {
  lat: number;
  lng: number;
}

/** Human-readable identity used when several map objects share a tap target. */
export interface IMapSelectionMetadata {
  id: string;
  kind: 'bus' | 'stop' | 'route';
  label: string;
  detail?: string;
}

export interface IMapMarkerOptions {
  position: ILatLng;
  title?: string;
  icon?: string;
  iconAnchor?: { x: number; y: number };
  iconSize?: { width: number; height: number };
  zIndex?: number;
  draggable?: boolean;
  clickable?: boolean;
  selection?: IMapSelectionMetadata;
}

export interface IMapPolylineOptions {
  path: ILatLng[];
  color?: string;
  weight?: number;
  opacity?: number;
  zIndex?: number;
  selection?: IMapSelectionMetadata;
}

export interface IMapMarker {
  id: string;
  setPosition(position: ILatLng): void;
  animatePosition(position: ILatLng, durationMs?: number): void;
  setIcon(
    icon:
      | string
      | {
          url: string;
          anchor: { x: number; y: number };
          size: { width: number; height: number };
        }
  ): void;
  setVisible(visible: boolean): void;
  setTitle?(title: string): void;
  setSelection?(selection: IMapSelectionMetadata): void;
  onClick(callback: () => void): void;
  remove(): void;
}

export interface IMapPolyline {
  id: string;
  setVisible(visible: boolean): void;
  setStyle?(
    style: Partial<
      Pick<IMapPolylineOptions, 'color' | 'weight' | 'opacity' | 'zIndex'>
    >
  ): void;
  onClick(callback: (position: ILatLng) => void): void;
  remove(): void;
}

export interface IMapProvider {
  initialize(container: HTMLElement, config: IConfig): Promise<void>;
  setCenter(position: ILatLng): void;
  setZoom(level: number): void;
  getCenter(): ILatLng;
  getZoom(): number;
  addMarker(options: IMapMarkerOptions): IMapMarker;
  addPolyline(options: IMapPolylineOptions): IMapPolyline;
  clearMarkers(): void;
  clearPolylines(): void;
  clearAll(): void;
  onMapClick(callback: (position: ILatLng) => void): void;
  onZoomChanged(callback: (zoom: number) => void): void;
  fitBounds(bounds: {
    north: number;
    south: number;
    east: number;
    west: number;
  }): void;
  toggleLayers(): string;
}

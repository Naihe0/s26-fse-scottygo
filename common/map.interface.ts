// Interfaces for Google Maps API configuration and transit response wrapper

export interface IConfig {
  apiKey: string;
  lat: number; // Default center latitude
  lon: number; // Default center longitude
  defaultZoom: number;
}

// Generic success response for transit endpoints
// Extends the base success pattern with a source field for live/static data
export interface ITransitSuccess<T> {
  name: string;
  desc?: string;
  source: 'live' | 'static'; // Indicates if data is real-time or from local cache
  payload: T | null;
}

// Map abstraction layer interfaces
// These decouple the app from any specific map SDK (Google Maps, Leaflet, etc.)

export interface ILatLng {
  lat: number;
  lng: number;
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
}

export interface IMapPolylineOptions {
  path: ILatLng[];
  color?: string;
  weight?: number;
  opacity?: number;
  zIndex?: number;
}

export interface IMapMarker {
  id: string;
  setPosition(position: ILatLng): void;
  animatePosition(position: ILatLng, durationMs?: number): void;
  setIcon(icon: string): void;
  setVisible(visible: boolean): void;
  setTitle?(title: string): void;
  setIcon(
    icon:
      | string
      | {
          url: string;
          anchor: { x: number; y: number };
          size: { width: number; height: number };
        }
  ): void;
  onClick(callback: () => void): void;
  remove(): void;
}

export interface IMapPolyline {
  id: string;
  setVisible(visible: boolean): void;
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

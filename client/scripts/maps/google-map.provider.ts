import {
  IMapProvider,
  IMapMarker,
  IMapPolyline,
  IMapMarkerOptions,
  IMapPolylineOptions,
  ILatLng,
  IConfig
} from '../../../common/map.interface';

// Keep geographic context legible without competing with ScottyGo's overlays.
// Embedded styles deliberately avoid a map ID or cloud-style configuration.
const BASE_MAP_STYLES: google.maps.MapTypeStyle[] = [
  { elementType: 'geometry', stylers: [{ color: '#f3f5f7' }] },
  { elementType: 'labels.text.fill', stylers: [{ color: '#697586' }] },
  { elementType: 'labels.text.stroke', stylers: [{ color: '#ffffff' }] },
  {
    featureType: 'landscape.man_made',
    elementType: 'geometry',
    stylers: [{ color: '#eef1f4' }]
  },
  {
    featureType: 'road',
    elementType: 'geometry.fill',
    stylers: [{ color: '#ffffff' }]
  },
  {
    featureType: 'road',
    elementType: 'geometry.stroke',
    stylers: [{ color: '#e3e8ee' }]
  },
  {
    featureType: 'road.highway',
    elementType: 'geometry.fill',
    stylers: [{ color: '#e0e6ed' }]
  },
  {
    featureType: 'poi.park',
    elementType: 'geometry',
    stylers: [{ color: '#e0ece3' }]
  },
  {
    featureType: 'water',
    elementType: 'geometry',
    stylers: [{ color: '#cddfe9' }]
  },
  {
    featureType: 'poi.business',
    elementType: 'labels.icon',
    stylers: [{ visibility: 'off' }]
  },
  {
    featureType: 'transit',
    elementType: 'labels.icon',
    stylers: [{ visibility: 'off' }]
  }
];

interface MarkerAnimation {
  frameId?: number;
}

/**
 * Google Maps implementation of IMapProvider.
 *
 * All feature code (route overlays, bus markers, stop markers) should depend
 * on IMapProvider, not on this class directly. To swap providers, create a new
 * class implementing IMapProvider and change the instantiation site.
 */
export class GoogleMapProvider implements IMapProvider {
  private map!: google.maps.Map;
  private markers: Map<string, google.maps.Marker> = new Map();
  private markerAnimations = new Map<string, MarkerAnimation>();
  private motionPreference: MediaQueryList | null = null;
  private polylines: Map<string, google.maps.Polyline> = new Map();
  private transitLayer!: google.maps.TransitLayer;
  private trafficLayer!: google.maps.TrafficLayer;
  private bikeLayer!: google.maps.BicyclingLayer;
  private layerModeIndex = 0;
  private markerIdCounter = 0;
  private polylineIdCounter = 0;

  async initialize(container: HTMLElement, config: IConfig): Promise<void> {
    await this.loadScript(config.apiKey);
    this.map = new google.maps.Map(container, {
      center: { lat: config.lat, lng: config.lon },
      zoom: config.defaultZoom,
      gestureHandling: 'greedy', // Allow single-finger drag on mobile
      zoomControl: false, // Disable default zoom controls (we have custom ones)
      mapTypeControl: false, // Disable map type selector
      streetViewControl: false, // Disable street view pegman
      fullscreenControl: false, // Disable fullscreen button
      rotateControl: false, // Disable rotate/tilt diamond control
      tilt: 0, // Prevent 45° imagery which also triggers the rotate control
      styles: BASE_MAP_STYLES,
      zoomControlOptions: {
        position: google.maps.ControlPosition.RIGHT_BOTTOM
      }
    });

    this.transitLayer = new google.maps.TransitLayer();
    this.trafficLayer = new google.maps.TrafficLayer();
    this.bikeLayer = new google.maps.BicyclingLayer();
    this.applyLayerMode('none');
  }

  setCenter(position: ILatLng): void {
    this.map.setCenter(position);
  }

  setZoom(level: number): void {
    this.map.setZoom(level);
  }

  getCenter(): ILatLng {
    const center = this.map.getCenter()!;
    return { lat: center.lat(), lng: center.lng() };
  }

  getZoom(): number {
    return this.map.getZoom()!;
  }

  addMarker(options: IMapMarkerOptions): IMapMarker {
    const id = `marker-${this.markerIdCounter++}`;

    let iconOption: google.maps.Icon | string | undefined = options.icon;
    if (options.icon && options.iconAnchor && options.iconSize) {
      iconOption = {
        url: options.icon,
        scaledSize: new google.maps.Size(
          options.iconSize.width,
          options.iconSize.height
        ),
        anchor: new google.maps.Point(
          options.iconAnchor.x,
          options.iconAnchor.y
        )
      };
    }

    const marker = new google.maps.Marker({
      position: options.position,
      map: this.map,
      title: options.title,
      draggable: options.draggable,
      clickable: options.clickable,
      icon: iconOption,
      zIndex: options.zIndex
    });
    this.markers.set(id, marker);

    return {
      id,
      setPosition: (pos: ILatLng) => {
        this.cancelMarkerAnimation(id);
        if (this.markers.get(id) === marker) marker.setPosition(pos);
      },
      animatePosition: (pos: ILatLng, durationMs = 1000) => {
        this.cancelMarkerAnimation(id);
        if (this.markers.get(id) !== marker) return;
        const target = { ...pos };
        const start = marker.getPosition();
        if (
          !start ||
          !Number.isFinite(durationMs) ||
          durationMs <= 0 ||
          this.prefersReducedMotion()
        ) {
          marker.setPosition(target);
          return;
        }
        const startLat = start.lat();
        const startLng = start.lng();
        const dLat = target.lat - startLat;
        const dLng = target.lng - startLng;
        // Skip animation for tiny moves or teleports (> ~5 km)
        if (
          (Math.abs(dLat) < 0.00001 && Math.abs(dLng) < 0.00001) ||
          Math.abs(dLat) > 0.05 ||
          Math.abs(dLng) > 0.05
        ) {
          marker.setPosition(target);
          return;
        }
        const t0 = performance.now();
        const animation: MarkerAnimation = {};
        this.markerAnimations.set(id, animation);
        const step = (now: number) => {
          // Ownership also rejects callbacks already dispatched before cancel.
          if (
            this.markerAnimations.get(id) !== animation ||
            this.markers.get(id) !== marker
          )
            return;
          const elapsed = now - t0;
          const progress = Math.max(0, Math.min(elapsed / durationMs, 1));
          if (progress === 1 || this.prefersReducedMotion()) {
            marker.setPosition(target);
            this.markerAnimations.delete(id);
            return;
          }
          // Ease-out cubic for a natural deceleration feel
          const ease = 1 - Math.pow(1 - progress, 3);
          marker.setPosition({
            lat: startLat + dLat * ease,
            lng: startLng + dLng * ease
          });
          animation.frameId = requestAnimationFrame(step);
        };
        animation.frameId = requestAnimationFrame(step);
      },
      setVisible: (visible: boolean) => marker.setVisible(visible),
      setTitle: (title: string) => {
        if (this.markers.get(id) === marker) marker.setTitle(title);
      },
      setIcon: (
        icon:
          | string
          | {
              url: string;
              anchor: { x: number; y: number };
              size: { width: number; height: number };
            }
      ) => {
        if (typeof icon === 'string') {
          marker.setIcon(icon);
        } else {
          marker.setIcon({
            url: icon.url,
            scaledSize: new google.maps.Size(icon.size.width, icon.size.height),
            anchor: new google.maps.Point(icon.anchor.x, icon.anchor.y)
          });
        }
      },
      onClick: (callback: () => void) => {
        google.maps.event.addListener(marker, 'click', callback);
      },
      remove: () => {
        this.cancelMarkerAnimation(id);
        marker.setMap(null);
        this.markers.delete(id);
      }
    };
  }

  addPolyline(options: IMapPolylineOptions): IMapPolyline {
    const id = `polyline-${this.polylineIdCounter++}`;
    const polyline = new google.maps.Polyline({
      path: options.path,
      strokeColor: options.color ?? '#0000FF',
      strokeWeight: options.weight ?? 3,
      strokeOpacity: options.opacity ?? 1.0,
      zIndex: options.zIndex,
      map: this.map
    });
    this.polylines.set(id, polyline);

    return {
      id,
      setVisible: (visible: boolean) => polyline.setVisible(visible),
      onClick: (callback: (position: ILatLng) => void) => {
        google.maps.event.addListener(
          polyline,
          'click',
          (e: google.maps.PolyMouseEvent) => {
            if (e.latLng)
              callback({ lat: e.latLng.lat(), lng: e.latLng.lng() });
          }
        );
      },
      remove: () => {
        polyline.setMap(null);
        this.polylines.delete(id);
      }
    };
  }

  clearMarkers(): void {
    this.markerAnimations.forEach((_animation, id) => {
      this.cancelMarkerAnimation(id);
    });
    this.markers.forEach((m) => m.setMap(null));
    this.markers.clear();
  }

  clearPolylines(): void {
    this.polylines.forEach((p) => p.setMap(null));
    this.polylines.clear();
  }

  clearAll(): void {
    this.clearMarkers();
    this.clearPolylines();
  }

  private cancelMarkerAnimation(id: string): void {
    const animation = this.markerAnimations.get(id);
    this.markerAnimations.delete(id);
    if (animation?.frameId !== undefined) {
      cancelAnimationFrame(animation.frameId);
    }
  }

  private prefersReducedMotion(): boolean {
    if (!this.motionPreference && typeof window.matchMedia === 'function') {
      this.motionPreference = window.matchMedia(
        '(prefers-reduced-motion: reduce)'
      );
    }
    return this.motionPreference?.matches ?? false;
  }

  onMapClick(callback: (position: ILatLng) => void): void {
    this.map.addListener('click', (e: google.maps.MapMouseEvent) => {
      if (e.latLng) {
        callback({ lat: e.latLng.lat(), lng: e.latLng.lng() });
      }
    });
  }

  onZoomChanged(callback: (zoom: number) => void): void {
    this.map.addListener('zoom_changed', () => {
      callback(this.map.getZoom()!);
    });
  }

  fitBounds(bounds: {
    north: number;
    south: number;
    east: number;
    west: number;
  }): void {
    const googleBounds = new google.maps.LatLngBounds(
      { lat: bounds.south, lng: bounds.west },
      { lat: bounds.north, lng: bounds.east }
    );
    this.map.fitBounds(googleBounds);
  }

  toggleLayers(): string {
    const modes: Array<'none' | 'transit' | 'traffic' | 'bike' | 'satellite'> =
      ['none', 'transit', 'traffic', 'bike', 'satellite'];
    this.layerModeIndex = (this.layerModeIndex + 1) % modes.length;
    const nextMode = modes[this.layerModeIndex];
    this.applyLayerMode(nextMode);

    switch (nextMode) {
      case 'transit':
        return 'Transit';
      case 'traffic':
        return 'Traffic';
      case 'bike':
        return 'Bicycling';
      case 'satellite':
        return 'Satellite';
      default:
        return 'Off';
    }
  }

  private applyLayerMode(
    mode: 'none' | 'transit' | 'traffic' | 'bike' | 'satellite'
  ): void {
    this.transitLayer.setMap(null);
    this.trafficLayer.setMap(null);
    this.bikeLayer.setMap(null);
    this.map.setMapTypeId(google.maps.MapTypeId.ROADMAP);

    if (mode === 'transit') {
      this.transitLayer.setMap(this.map);
      return;
    }
    if (mode === 'traffic') {
      this.trafficLayer.setMap(this.map);
      return;
    }
    if (mode === 'bike') {
      this.bikeLayer.setMap(this.map);
      return;
    }
    if (mode === 'satellite') {
      this.map.setMapTypeId(google.maps.MapTypeId.SATELLITE);
    }
  }

  /**
   * Expose the underlying google.maps.Map instance for widgets that
   * need direct SDK access (e.g. Places Autocomplete).
   */
  getNativeMap(): google.maps.Map {
    return this.map;
  }

  /**
   * Dynamically loads the Google Maps JavaScript SDK into the page.
   * Resolves immediately if already loaded.
   */
  private loadScript(apiKey: string): Promise<void> {
    return new Promise((resolve, reject) => {
      if (typeof google !== 'undefined' && google.maps) {
        resolve();
        return;
      }
      const script = document.createElement('script');
      script.src = `https://maps.googleapis.com/maps/api/js?key=${apiKey}&libraries=places`;
      script.async = true;
      script.onload = () => resolve();
      script.onerror = () =>
        reject(new Error('Failed to load Google Maps SDK'));
      document.head.appendChild(script);
    });
  }
}

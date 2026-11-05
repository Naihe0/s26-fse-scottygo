/** Browser-only double for the commercial Maps SDK. App controllers and DOM run unmodified. */
export function installMapFixture() {
  const point = ({ lat, lng }) => ({ lat: () => lat, lng: () => lng });
  class Events {
    constructor() {
      this.events = {};
    }
    addListener(type, handler) {
      (this.events[type] ??= []).push(handler);
      return {
        remove: () => {
          this.events[type] = this.events[type].filter((f) => f !== handler);
        }
      };
    }
    emit(type, payload) {
      for (const fn of this.events[type] ?? []) fn(payload);
    }
  }
  class MapFixture extends Events {
    constructor(element, { center, zoom }) {
      super();
      this.center = center;
      this.zoom = zoom;
      this.element = element;
      element.dataset.zoom = String(zoom);
      element.dataset.ready = 'true';
      element.addEventListener('click', () =>
        this.emit('click', { latLng: point({ lat: 40.443, lng: -79.944 }) })
      );
    }
    setZoom(zoom) {
      this.zoom = zoom;
      this.element.dataset.zoom = String(zoom);
      this.emit('zoom_changed');
    }
    getZoom() {
      return this.zoom;
    }
    setCenter(center) {
      this.center = center;
    }
    getCenter() {
      return point(this.center);
    }
    fitBounds() {}
    setMapTypeId() {}
  }
  class Overlay extends Events {
    constructor(options = {}) {
      super();
      this.position = options.position;
    }
    getPosition() {
      return this.position && point(this.position);
    }
    setPosition(position) {
      this.position = position;
    }
    setVisible() {}
    setMap() {}
    setIcon() {}
    setTitle() {}
    setOptions() {}
  }
  class Autocomplete extends Events {
    constructor(input) {
      super();
      input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' && input.value) this.emit('place_changed');
      });
    }
    bindTo() {}
    getPlace() {
      return {
        name: 'Campus Library',
        geometry: { location: point({ lat: 40.444, lng: -79.943 }) }
      };
    }
  }
  window.google = {
    maps: {
      Map: MapFixture,
      Marker: Overlay,
      Polyline: Overlay,
      TransitLayer: Overlay,
      TrafficLayer: Overlay,
      BicyclingLayer: Overlay,
      ControlPosition: {},
      MapTypeId: {},
      Size: class {},
      Point: class {},
      LatLngBounds: class {},
      places: { Autocomplete },
      event: {
        addListener: (object, type, fn) => object.addListener(type, fn),
        addListenerOnce: (object, type, fn) => object.addListener(type, fn)
      },
      importLibrary: async () => ({
        Route: {
          computeRoutes: async ({ origin, destination, fields }) => ({
            routes: [
              {
                path: [origin, destination],
                durationMillis: 180000,
                distanceMeters: 210,
                legs: fields.includes('legs') ? [{ steps: [
                  { instructions: 'Walk east on Forbes', distanceMeters: 150 },
                  { instructions: 'Turn toward the platform', distanceMeters: 60 }
                ] }] : undefined,
                warnings: []
              }
            ]
          })
        }
      })
    }
  };
  Object.defineProperty(navigator, 'share', {
    configurable: true,
    value: async (data) => {
      window.sharedPublicLink = data.url;
    }
  });
}

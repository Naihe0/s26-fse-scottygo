/** @jest-environment jsdom */

import { GoogleMapProvider } from '../../client/scripts/maps/google-map.provider';
import type { ILatLng } from '../../common/map.interface';

class MockMarker {
  static instances: MockMarker[] = [];
  position?: ILatLng;
  options: google.maps.MarkerOptions;
  setPosition = jest.fn((position: ILatLng) => {
    this.position = position;
  });
  getPosition = jest.fn(
    () =>
      this.position && {
        lat: () => this.position!.lat,
        lng: () => this.position!.lng
      }
  );
  setMap = jest.fn();
  setVisible = jest.fn();
  setIcon = jest.fn();
  setTitle = jest.fn();

  constructor(options: google.maps.MarkerOptions) {
    this.options = options;
    this.position = options.position as ILatLng;
    MockMarker.instances.push(this);
  }
}

describe('Google Maps marker movement ownership', () => {
  let provider: GoogleMapProvider;
  let clock: number;
  let nextFrameId: number;
  let reducedMotion: boolean;
  let frames: Map<number, FrameRequestCallback>;
  const originalGoogle = Object.getOwnPropertyDescriptor(globalThis, 'google');
  const originalMatchMedia = Object.getOwnPropertyDescriptor(
    window,
    'matchMedia'
  );
  const mapOptions: google.maps.MapOptions[] = [];
  const nativeMap = { setMapTypeId: jest.fn() };
  const polyline = { setMap: jest.fn() };
  const initial = { lat: 40.44, lng: -79.94 };
  const destination = { lat: 40.45, lng: -79.95 };

  function runFrame(elapsed: number) {
    clock += elapsed;
    const pending = [...frames];
    for (const [id, callback] of pending) {
      frames.delete(id);
      callback(clock);
    }
  }

  function addMarker() {
    const handle = provider.addMarker({ position: initial });
    return { handle, marker: MockMarker.instances.at(-1)! };
  }

  test('accessible marker titles update only while the marker is owned', () => {
    const { handle, marker } = addMarker();
    handle.setTitle?.('Bus 12 — delayed position, 2m ago');
    expect(marker.setTitle).toHaveBeenCalledWith(
      'Bus 12 — delayed position, 2m ago'
    );
    handle.remove();
    handle.setTitle?.('Late update');
    expect(marker.setTitle).toHaveBeenCalledTimes(1);
  });

  beforeEach(() => {
    clock = 0;
    nextFrameId = 0;
    reducedMotion = false;
    frames = new Map();
    mapOptions.length = 0;
    MockMarker.instances = [];
    jest.clearAllMocks();
    jest.spyOn(performance, 'now').mockImplementation(() => clock);
    jest
      .spyOn(window, 'requestAnimationFrame')
      .mockImplementation((callback) => {
        const id = ++nextFrameId;
        frames.set(id, callback);
        return id;
      });
    jest.spyOn(window, 'cancelAnimationFrame').mockImplementation((id) => {
      frames.delete(id);
    });
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: jest.fn(() => ({
        get matches() {
          return reducedMotion;
        }
      }))
    });
    Object.defineProperty(globalThis, 'google', {
      configurable: true,
      value: {
        maps: {
          Marker: MockMarker,
          Map: jest.fn((_: HTMLElement, options: google.maps.MapOptions) => {
            mapOptions.push(options);
            return nativeMap;
          }),
          Polyline: jest.fn(() => polyline),
          Size: class {
            constructor(
              public width: number,
              public height: number
            ) {}
          },
          Point: class {
            constructor(
              public x: number,
              public y: number
            ) {}
          },
          TransitLayer: class {
            setMap = jest.fn();
          },
          TrafficLayer: class {
            setMap = jest.fn();
          },
          BicyclingLayer: class {
            setMap = jest.fn();
          },
          ControlPosition: { RIGHT_BOTTOM: 'right-bottom' },
          MapTypeId: { ROADMAP: 'roadmap', SATELLITE: 'satellite' }
        }
      }
    });
    provider = new GoogleMapProvider();
  });

  afterEach(() => {
    provider.clearAll();
    expect(frames.size).toBe(0);
    jest.restoreAllMocks();
    if (originalGoogle)
      Object.defineProperty(globalThis, 'google', originalGoogle);
    else Reflect.deleteProperty(globalThis, 'google');
    if (originalMatchMedia)
      Object.defineProperty(window, 'matchMedia', originalMatchMedia);
    else Reflect.deleteProperty(window, 'matchMedia');
  });

  test('new movement owns the marker and rejects an already dispatched old frame', () => {
    const { handle, marker } = addMarker();
    handle.animatePosition(destination, 1000);
    runFrame(250);
    const intermediate = { ...marker.position! };
    const staleFrame = [...frames.values()][0];
    const latest = { lat: 40.443, lng: -79.942 };
    handle.animatePosition(latest, 1000);
    expect(cancelAnimationFrame).toHaveBeenCalledTimes(1);
    expect(frames.size).toBe(1);
    staleFrame(clock + 1000);
    expect(marker.position).toEqual(intermediate);
    runFrame(500);
    expect(marker.position!.lat).toBeCloseTo(
      intermediate.lat + (latest.lat - intermediate.lat) * 0.875
    );
    runFrame(500);
    expect(marker.position).toEqual(latest);
    expect(frames.size).toBe(0);
  });

  test('a direct position update cancels interpolated movement', () => {
    const { handle, marker } = addMarker();
    handle.animatePosition(destination);
    const staleFrame = [...frames.values()][0];
    const exact = { lat: 40.46, lng: -79.93 };
    handle.setPosition(exact);
    staleFrame(1000);
    expect(marker.position).toEqual(exact);
    expect(frames.size).toBe(0);
  });

  test('removal cancels work and retained handles cannot move removed markers', () => {
    const { handle, marker } = addMarker();
    handle.animatePosition(destination);
    const staleFrame = [...frames.values()][0];
    handle.remove();
    staleFrame(1000);
    handle.animatePosition(destination);
    handle.setPosition(destination);
    expect(marker.setPosition).not.toHaveBeenCalled();
    expect(marker.setMap).toHaveBeenCalledWith(null);
    expect(frames.size).toBe(0);
  });

  test.each(['clearMarkers', 'clearAll'] as const)(
    '%s cancels every marker and blocks stale callbacks',
    (method) => {
      const first = addMarker();
      const second = addMarker();
      first.handle.animatePosition(destination);
      second.handle.animatePosition(destination);
      const staleFrames = [...frames.values()];
      provider[method]();
      staleFrames.forEach((frame) => frame(1000));
      first.handle.animatePosition(destination);
      second.handle.setPosition(destination);
      expect(first.marker.setPosition).not.toHaveBeenCalled();
      expect(second.marker.setPosition).not.toHaveBeenCalled();
      expect(cancelAnimationFrame).toHaveBeenCalledTimes(2);
      expect(frames.size).toBe(0);
    }
  );

  test('reduced motion updates immediately without scheduling a frame', () => {
    reducedMotion = true;
    const { handle, marker } = addMarker();
    handle.animatePosition(destination);
    expect(marker.position).toEqual(destination);
    expect(requestAnimationFrame).not.toHaveBeenCalled();
    expect(window.matchMedia).toHaveBeenCalledWith(
      '(prefers-reduced-motion: reduce)'
    );
  });

  test('a motion preference change finishes a running animation on the next frame', () => {
    const { handle, marker } = addMarker();
    handle.animatePosition(destination);
    runFrame(100);
    reducedMotion = true;
    runFrame(100);
    expect(marker.position).toEqual(destination);
    expect(frames.size).toBe(0);
  });

  test('movement still works when matchMedia is unavailable', () => {
    Reflect.deleteProperty(window, 'matchMedia');
    const { handle, marker } = addMarker();
    handle.animatePosition(destination);
    runFrame(1000);
    expect(marker.position).toEqual(destination);
  });

  test.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    'invalid animation duration %s sets the exact endpoint',
    (duration) => {
      const { handle, marker } = addMarker();
      handle.animatePosition(destination, duration);
      expect(marker.position).toEqual(destination);
      expect(frames.size).toBe(0);
    }
  );

  test.each([
    { lat: 40.440001, lng: -79.940001 },
    { lat: 41, lng: -80 }
  ])('tiny moves and teleports end at their exact coordinate: %j', (target) => {
    const { handle, marker } = addMarker();
    handle.animatePosition(target);
    expect(marker.position).toEqual(target);
    expect(frames.size).toBe(0);
  });

  test('a missing initial coordinate updates immediately', () => {
    const { handle, marker } = addMarker();
    marker.position = undefined;
    handle.animatePosition(destination);
    expect(marker.position).toEqual(destination);
    expect(frames.size).toBe(0);
  });

  test('icon updates preserve explicit centered anchors and scaled sizes', () => {
    const handle = provider.addMarker({
      position: initial,
      icon: 'bus.svg',
      iconAnchor: { x: 24, y: 24 },
      iconSize: { width: 48, height: 48 }
    });
    const marker = MockMarker.instances[0];
    expect(marker.options.icon).toEqual({
      url: 'bus.svg',
      anchor: { x: 24, y: 24 },
      scaledSize: { width: 48, height: 48 }
    });
    handle.setIcon({
      url: 'bus-east.svg',
      anchor: { x: 20, y: 20 },
      size: { width: 40, height: 40 }
    });
    expect(marker.setIcon).toHaveBeenLastCalledWith({
      url: 'bus-east.svg',
      anchor: { x: 20, y: 20 },
      scaledSize: { width: 40, height: 40 }
    });
  });

  test('noninteractive location markers pass pointer input through to transit markers', () => {
    provider.addMarker({ position: initial, clickable: false });
    expect(MockMarker.instances[0].options.clickable).toBe(false);
    provider.addMarker({ position: destination });
    expect(MockMarker.instances[1].options.clickable).toBeUndefined();
  });

  test('the base map quiets competing icons and still supports all layer modes', async () => {
    await provider.initialize(document.createElement('div'), {
      apiKey: 'mock-key',
      lat: initial.lat,
      lon: initial.lng,
      defaultZoom: 14
    });
    const styles = mapOptions[0].styles!;
    expect(styles).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          featureType: 'poi.park',
          elementType: 'geometry'
        }),
        expect.objectContaining({
          featureType: 'water',
          elementType: 'geometry'
        }),
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
      ])
    );
    // Street, neighborhood, park and medical labels are never disabled.
    expect(
      styles.filter((style) =>
        style.stylers.some((styler) => styler.visibility === 'off')
      )
    ).toHaveLength(2);
    expect(mapOptions[0].mapId).toBeUndefined();
    expect([
      provider.toggleLayers(),
      provider.toggleLayers(),
      provider.toggleLayers(),
      provider.toggleLayers()
    ]).toEqual(['Transit', 'Traffic', 'Bicycling', 'Satellite']);
    expect(nativeMap.setMapTypeId).toHaveBeenLastCalledWith('satellite');
    expect(provider.toggleLayers()).toBe('Off');
    expect(nativeMap.setMapTypeId).toHaveBeenLastCalledWith('roadmap');
  });
});

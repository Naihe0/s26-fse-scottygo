/** @jest-environment jsdom */
import { GoogleMapProvider } from '../../client/scripts/maps/google-map.provider';
import type { ILatLng } from '../../common/map.interface';

type Listener = (event: {
  latLng: { lat: () => number; lng: () => number };
}) => void;

describe('provider map selection lifecycle', () => {
  const originalGoogle = Object.getOwnPropertyDescriptor(globalThis, 'google');
  const origin = { lat: 40.44, lng: -79.94 };
  let provider: GoogleMapProvider;
  let events: Map<object, Map<string, Listener>>;
  const markerInstances: MockMarker[] = [];
  const lineInstances: MockPolyline[] = [];
  const map = {
    getZoom: () => 16,
    setMapTypeId: jest.fn(),
    addListener: (type: string, listener: Listener) =>
      addListener(map, type, listener)
  };
  const addListener = (object: object, type: string, listener: Listener) => {
    const listeners = events.get(object) ?? new Map();
    listeners.set(type, listener);
    events.set(object, listeners);
  };
  class MockMarker {
    position: ILatLng;
    constructor(options: google.maps.MarkerOptions) {
      this.position = options.position as ILatLng;
      markerInstances.push(this);
    }
    getPosition() {
      return { lat: () => this.position.lat, lng: () => this.position.lng };
    }
    setPosition(position: ILatLng) {
      this.position = position;
    }
    setMap = jest.fn();
    setVisible = jest.fn();
  }
  class MockPolyline {
    constructor() {
      lineInstances.push(this);
    }
    setMap = jest.fn();
    setVisible = jest.fn();
    setOptions = jest.fn();
  }
  function click(object: object, position = origin) {
    events.get(object)?.get('click')?.({
      latLng: { lat: () => position.lat, lng: () => position.lng }
    });
  }
  function marker(id: string, kind: 'bus' | 'stop' = 'bus', position = origin) {
    const handle = provider.addMarker({
      position,
      selection: { id, kind, label: id }
    });
    const callback = jest.fn();
    handle.onClick(callback);
    return { handle, callback, sdk: markerInstances.at(-1)! };
  }
  function route() {
    const handle = provider.addPolyline({
      path: [
        { ...origin, lng: origin.lng - 0.001 },
        { ...origin, lng: origin.lng + 0.001 }
      ],
      selection: { id: 'route:61', kind: 'route', label: 'Route 61' }
    });
    const callback = jest.fn();
    handle.onClick(callback);
    return { handle, callback, sdk: lineInstances.at(-1)! };
  }
  beforeEach(async () => {
    events = new Map();
    markerInstances.length = 0;
    lineInstances.length = 0;
    document.body.innerHTML = '<div id="map"></div>';
    Object.defineProperty(globalThis, 'google', {
      configurable: true,
      value: {
        maps: {
          Map: jest.fn(() => map),
          Marker: MockMarker,
          Polyline: MockPolyline,
          event: { addListener },
          ControlPosition: { RIGHT_BOTTOM: 0 },
          MapTypeId: { ROADMAP: 'roadmap' },
          TransitLayer: class {
            setMap() {}
          },
          TrafficLayer: class {
            setMap() {}
          },
          BicyclingLayer: class {
            setMap() {}
          }
        }
      }
    });
    provider = new GoogleMapProvider();
    await provider.initialize(document.getElementById('map')!, {
      apiKey: 'test',
      lat: origin.lat,
      lon: origin.lng,
      defaultZoom: 16
    });
  });
  afterEach(() => {
    provider.clearAll();
    if (originalGoogle)
      Object.defineProperty(globalThis, 'google', originalGoogle);
    else Reflect.deleteProperty(globalThis, 'google');
  });

  test('a bus click discovers stops and deduplicated route strokes underneath', () => {
    const bus = marker('Bus 61');
    marker('Forbes stop', 'stop');
    const line = route();
    route();
    click(bus.sdk);
    expect(document.querySelectorAll('.map-selection__choice')).toHaveLength(3);
    const choices = [
      ...document.querySelectorAll<HTMLButtonElement>('.map-selection__choice')
    ];
    choices.find((choice) => choice.textContent?.includes('Route 61'))!.click();
    expect(line.callback).toHaveBeenCalledWith(origin);
    expect(bus.callback).not.toHaveBeenCalled();
  });

  test('base map taps near a marker select it before dispatching generic map clicks', () => {
    const bus = marker('Bus 61');
    const mapClick = jest.fn();
    provider.onMapClick(mapClick);
    click(map, { ...origin, lng: origin.lng + 0.0001 });
    expect(bus.callback).toHaveBeenCalledTimes(1);
    expect(mapClick).not.toHaveBeenCalled();
    click(map, { ...origin, lng: origin.lng + 0.01 });
    expect(mapClick).toHaveBeenCalledTimes(1);
  });

  test('base map hit testing works without a generic map click subscriber', () => {
    const bus = marker('Bus 61');
    click(map, { ...origin, lng: origin.lng + 0.0001 });
    expect(bus.callback).toHaveBeenCalledTimes(1);
  });

  test('multiple map subscribers receive only unhandled clicks and do not repeat selections', () => {
    const bus = marker('Bus 61');
    const first = jest.fn();
    const second = jest.fn();
    provider.onMapClick(first);
    provider.onMapClick(second);
    click(map);
    expect(bus.callback).toHaveBeenCalledTimes(1);
    expect(first).not.toHaveBeenCalled();
    expect(second).not.toHaveBeenCalled();
    click(map, { ...origin, lng: origin.lng + 0.01 });
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
  });

  test('hidden and removed overlays do not appear in map choices', () => {
    const bus = marker('Bus 61');
    const stop = marker('Stop', 'stop');
    const line = route();
    stop.handle.setVisible(false);
    line.handle.remove();
    click(bus.sdk);
    expect(bus.callback).toHaveBeenCalledTimes(1);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  test('moving bus hit targets follow the current SDK position', () => {
    const bus = marker('Bus 61');
    const mapClick = jest.fn();
    provider.onMapClick(mapClick);
    const moved = { ...origin, lng: origin.lng + 0.01 };
    bus.handle.setPosition(moved);
    click(map);
    expect(mapClick).toHaveBeenCalledWith(origin);
    expect(bus.callback).not.toHaveBeenCalled();
    click(map, moved);
    expect(bus.callback).toHaveBeenCalledTimes(1);
  });

  test('open choices cannot activate an overlay removed by a feed refresh', () => {
    const bus = marker('Bus 61');
    marker('Stop', 'stop');
    click(bus.sdk);
    bus.handle.remove();
    document
      .querySelector<HTMLButtonElement>('.map-selection__choice')!
      .click();
    expect(bus.callback).not.toHaveBeenCalled();
  });

  test('shared stop metadata updates without creating another marker', () => {
    const bus = marker('Bus 61');
    const stop = marker('Stop', 'stop');
    stop.handle.setSelection?.({
      id: 'Stop',
      kind: 'stop',
      label: 'Forbes & Morewood',
      detail: '61B · 61C'
    });
    click(bus.sdk);
    expect(document.querySelector('.map-selection')!.textContent).toContain(
      'Forbes & Morewood'
    );
    expect(document.querySelector('.map-selection')!.textContent).toContain(
      '61B · 61C'
    );
    expect(markerInstances).toHaveLength(2);
  });

  test('style changes update a polyline in place and stop after removal', () => {
    const line = route();
    line.handle.setStyle?.({
      color: '#a00',
      weight: 5,
      opacity: 0.3,
      zIndex: 20
    });
    expect(line.sdk.setOptions).toHaveBeenCalledWith({
      strokeColor: '#a00',
      strokeWeight: 5,
      strokeOpacity: 0.3,
      zIndex: 20
    });
    line.handle.remove();
    line.handle.setStyle?.({ weight: 9 });
    expect(line.sdk.setOptions).toHaveBeenCalledTimes(1);
  });

  test('clearing a map closes choices and releases background focus isolation', () => {
    const bus = marker('Bus 61');
    marker('Stop', 'stop');
    click(bus.sdk);
    provider.clearAll();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.getElementById('map')!.hasAttribute('inert')).toBe(false);
    const mapClick = jest.fn();
    provider.onMapClick(mapClick);
    click(map);
    expect(mapClick).toHaveBeenCalledTimes(1);
  });
});

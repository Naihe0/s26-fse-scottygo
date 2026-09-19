import {
  RouteRenderer,
  type RouteData
} from '../../client/scripts/renderers/route-renderer';
import { createStopIcon } from '../../client/scripts/utils/stop-icon';
import type {
  ILatLng,
  IMapMarker,
  IMapMarkerOptions,
  IMapPolyline,
  IMapPolylineOptions,
  IMapProvider
} from '../../common/map.interface';
import type { IDetour, IStop } from '../../common/transit.interface';

const path = [
  { lat: 40.44, lng: -79.95 },
  { lat: 40.44, lng: -79.93 }
];
const stop = (id = 's1', lat = 40.44): IStop => ({
  stopId: id,
  stopName: `Stop ${id}`,
  lat,
  lon: -79.94,
  dtradd: [],
  dtrrem: []
});
const geometry = (direction = 'INBOUND'): RouteData => [{ direction, path }];
const detour = (direction = 'INBOUND'): IDetour[] => [
  {
    id: 'detour',
    description: 'Test detour',
    startdt: '',
    enddt: '',
    geometry: [{ detourId: 'detour', direction, detourPath: path }]
  }
];

function mapFixture() {
  const lines: Array<{
    options: IMapPolylineOptions;
    line: jest.Mocked<IMapPolyline>;
  }> = [];
  const markers: Array<{
    options: IMapMarkerOptions;
    marker: jest.Mocked<IMapMarker>;
  }> = [];
  let zoom = 14;
  let zoomCallback: (value: number) => void = () => undefined;
  const provider = {
    getZoom: jest.fn(() => zoom),
    onZoomChanged: jest.fn((cb: (value: number) => void) => {
      zoomCallback = cb;
    }),
    addPolyline: jest.fn((options: IMapPolylineOptions): IMapPolyline => {
      const line = {
        id: `line-${lines.length}`,
        setVisible: jest.fn(),
        onClick: jest.fn(),
        remove: jest.fn()
      };
      lines.push({ options, line });
      return line;
    }),
    addMarker: jest.fn((options: IMapMarkerOptions): IMapMarker => {
      const marker = {
        id: `marker-${markers.length}`,
        setPosition: jest.fn(),
        animatePosition: jest.fn(),
        setIcon: jest.fn(),
        setVisible: jest.fn(),
        onClick: jest.fn(),
        remove: jest.fn()
      };
      markers.push({ options, marker });
      return marker;
    }),
    fitBounds: jest.fn(),
    setCenter: jest.fn(),
    setZoom: jest.fn()
  };
  return {
    provider: provider as unknown as IMapProvider,
    lines,
    markers,
    zoomTo: (value: number) => {
      zoom = value;
      zoomCallback(value);
    }
  };
}

describe('route and stop rendering', () => {
  let map: ReturnType<typeof mapFixture>;
  let renderer: RouteRenderer;
  beforeEach(() => {
    map = mapFixture();
    renderer = RouteRenderer.getInstance();
    renderer.initialize(map.provider);
    renderer.setRouteClickCallback(jest.fn());
  });
  afterEach(() => renderer.clearAllRoutes());

  test('station dots are centered and keep a 28px target and accessible stop title', () => {
    renderer.renderRouteGeometry('61C', geometry(), '#123456');
    const clicked = jest.fn();
    const station = stop();
    renderer.renderStopMarkers('61C', [station], 'INBOUND', clicked);
    expect(map.markers[0].options).toEqual(
      expect.objectContaining({
        position: { lat: station.lat, lng: station.lon },
        title: 'Stop s1 (Stop #1)',
        iconAnchor: { x: 14, y: 14 },
        iconSize: { width: 28, height: 28 },
        zIndex: 30
      })
    );
    const svg = decodeURIComponent(map.markers[0].options.icon!);
    expect(svg).toContain('stroke="#123456"');
    expect(svg).toContain('fill="#ffffff"');
    expect(svg).not.toContain('<path');
    map.markers[0].marker.onClick.mock.calls[0][0]();
    expect(clicked).toHaveBeenCalledTimes(1);
    expect(clicked).toHaveBeenCalledWith(station);
  });

  test('duplicate stop records in one direction create only one callback and marker', () => {
    renderer.renderStopMarkers(
      '61C',
      [stop(), stop(), stop('s2')],
      'INBOUND',
      jest.fn()
    );
    expect(map.markers).toHaveLength(2);
    expect(map.markers[1].options.title).toBe('Stop s2 (Stop #2)');
    map.markers.forEach(({ marker }) =>
      expect(marker.onClick).toHaveBeenCalledTimes(1)
    );
  });

  test('invalid stop positions are not sent to the map provider', () => {
    renderer.renderStopMarkers(
      '61C',
      [stop('nan', NaN), stop('bad', 95), stop('valid', 0)],
      'INBOUND'
    );
    expect(map.markers).toHaveLength(1);
    expect(map.markers[0].options.position.lat).toBe(0);
  });

  test('zoom changes resize visible dots only across size bands and retain their anchor', () => {
    renderer.renderStopMarkers('61C', [stop()], 'INBOUND');
    map.zoomTo(15);
    expect(map.markers[0].marker.setIcon).not.toHaveBeenCalled();
    map.zoomTo(16);
    expect(map.markers[0].marker.setIcon).toHaveBeenLastCalledWith(
      createStopIcon('#c41230', 16)
    );
    map.zoomTo(13);
    expect(map.markers[0].marker.setIcon).toHaveBeenLastCalledWith(
      createStopIcon('#c41230', 13)
    );
    expect(map.markers[0].marker.setIcon).toHaveBeenCalledTimes(2);
  });

  test('same-provider initialization does not duplicate zoom listeners', () => {
    renderer.initialize(map.provider);
    renderer.initialize(map.provider);
    expect(map.provider.onZoomChanged).toHaveBeenCalledTimes(1);
  });

  test('changing providers removes old overlays and ignores old zoom events', () => {
    renderer.renderStopMarkers('61C', [stop()], 'INBOUND');
    const next = mapFixture();
    renderer.initialize(next.provider);
    expect(map.markers[0].marker.remove).toHaveBeenCalledTimes(1);
    renderer.renderStopMarkers('61C', [stop()], 'INBOUND');
    map.zoomTo(18);
    expect(next.markers[0].marker.setIcon).not.toHaveBeenCalled();
  });

  test('replacing and clearing stop buckets remove all old markers once', () => {
    renderer.renderStopMarkers('61C', [stop(), stop('s2')], 'INBOUND');
    renderer.renderStopMarkers('61C', [stop('replacement')], 'INBOUND');
    renderer.clearStopMarkers('61C_INBOUND');
    renderer.clearStopMarkers('61C_INBOUND');
    map.markers.forEach(({ marker }) =>
      expect(marker.remove).toHaveBeenCalledTimes(1)
    );
    map.zoomTo(18);
    map.markers.forEach(({ marker }) =>
      expect(marker.setIcon).not.toHaveBeenCalled()
    );
  });

  test('routes have a restrained color core above white casing and preserve clicks on both', () => {
    const clicked = jest.fn();
    renderer.setRouteClickCallback(clicked);
    renderer.renderRouteGeometry('61C', geometry(), '#123456');
    expect(map.lines.map(({ options }) => options)).toEqual([
      { path, color: '#ffffff', weight: 6, opacity: 0.95, zIndex: 10 },
      { path, color: '#123456', weight: 3.5, opacity: 1, zIndex: 11 }
    ]);
    const position = { lat: 40.44, lng: -79.94 };
    map.lines.forEach(({ line }) => line.onClick.mock.calls[0][0](position));
    expect(clicked).toHaveBeenCalledTimes(2);
    expect(clicked).toHaveBeenLastCalledWith(['61C'], position);
  });

  test('GeoJSON and custom directions receive the same route treatment', () => {
    renderer.renderRouteGeometry('CMU_LOOP', geometry('CLOCKWISE'), '#123456');
    renderer.renderRouteGeometry(
      'geo',
      {
        type: 'Feature',
        geometry: {
          type: 'LineString',
          coordinates: path.map(({ lat, lng }) => [lng, lat])
        }
      },
      '#abcdef'
    );
    expect(renderer.getRenderedRouteIds()).toEqual(['CMU_LOOP', 'geo']);
    expect(renderer.hasRouteGeometry('CMU_LOOP')).toBe(true);
    expect(map.lines).toHaveLength(4);
  });

  test('route visibility handles custom direction keys and detours together', () => {
    renderer.renderRouteGeometry('CMU_LOOP', geometry('CLOCKWISE'), '#123456');
    renderer.renderDetourGeometry('CMU_LOOP', detour('CLOCKWISE'));
    renderer.hideRoute('CMU_LOOP');
    map.lines.forEach(({ line }) =>
      expect(line.setVisible).toHaveBeenLastCalledWith(false)
    );
    renderer.showRoute('CMU_LOOP');
    map.lines.forEach(({ line }) =>
      expect(line.setVisible).toHaveBeenLastCalledWith(true)
    );
    renderer.hideDirectionPolylines('CMU_LOOP', 'CLOCKWISE');
    map.lines.forEach(({ line }) =>
      expect(line.setVisible).toHaveBeenLastCalledWith(false)
    );
    renderer.showRoute('CMU_LOOP');
    map.lines.forEach(({ line }) =>
      expect(line.setVisible).toHaveBeenLastCalledWith(false)
    );
    renderer.showDirectionPolylines('CMU_LOOP', 'CLOCKWISE');
    map.lines.forEach(({ line }) =>
      expect(line.setVisible).toHaveBeenLastCalledWith(true)
    );
  });

  test('visible-route filtering compares route IDs and retains hidden direction filters', () => {
    renderer.renderRouteGeometry('route_INBOUND', geometry('LOOP'), '#123456');
    renderer.renderRouteGeometry('other', geometry(), '#abcdef');
    renderer.updateVisibleRoutes(['route_INBOUND']);
    expect(map.lines[0].line.setVisible).toHaveBeenLastCalledWith(true);
    expect(map.lines[2].line.setVisible).toHaveBeenLastCalledWith(false);
    renderer.hideDirectionPolylines('route_INBOUND', 'LOOP');
    renderer.updateVisibleRoutes(['route_INBOUND', 'other']);
    expect(map.lines[0].line.setVisible).toHaveBeenLastCalledWith(false);
    expect(map.lines[2].line.setVisible).toHaveBeenLastCalledWith(true);
  });

  test('new detours inherit active visibility and render above ordinary routes', () => {
    renderer.renderRouteGeometry('61C', geometry(), '#123456');
    renderer.hideDirectionPolylines('61C', 'INBOUND');
    renderer.renderDetourGeometry('61C', detour());
    expect(map.lines[2].options).toEqual(
      expect.objectContaining({ weight: 7, zIndex: 20 })
    );
    expect(map.lines[3].options).toEqual(
      expect.objectContaining({ weight: 4.5, color: '#e9462f', zIndex: 21 })
    );
    expect(map.lines[2].line.setVisible).toHaveBeenLastCalledWith(false);
    expect(map.lines[3].line.setVisible).toHaveBeenLastCalledWith(false);
  });

  test('overlap selection detects the middle of long segments and omits hidden routes', () => {
    renderer.renderRouteGeometry('61C', geometry(), '#123456');
    renderer.renderRouteGeometry('61D', geometry(), '#abcdef');
    const midpoint = { lat: 40.44, lng: -79.94 };
    expect(renderer.getRoutesAtPosition(midpoint)).toEqual(['61C', '61D']);
    renderer.hideRoute('61C');
    expect(renderer.getRoutesAtPosition(midpoint)).toEqual(['61D']);
    renderer.hideDirectionPolylines('61D', 'INBOUND');
    expect(renderer.getRoutesAtPosition(midpoint)).toEqual([]);
    expect(renderer.getRoutesAtPosition({ lat: NaN, lng: -79.94 })).toEqual([]);
  });

  test('clearing custom-direction routes removes both strokes and detours without stale hits', () => {
    renderer.renderRouteGeometry('CMU_LOOP', geometry('CLOCKWISE'), '#123456');
    renderer.renderDetourGeometry('CMU_LOOP', detour('CLOCKWISE'));
    renderer.clearRoutePolylines('CMU_LOOP');
    renderer.clearRoutePolylines('CMU_LOOP');
    map.lines.forEach(({ line }) =>
      expect(line.remove).toHaveBeenCalledTimes(1)
    );
    expect(renderer.hasRouteGeometry('CMU_LOOP')).toBe(false);
    expect(renderer.getRenderedRouteIds()).toEqual([]);
    expect(renderer.getRoutesAtPosition(path[0])).toEqual([]);
  });

  test('replacing a route removes old overlays and bounds use its current geometry and stops', () => {
    renderer.renderRouteGeometry('61C', geometry(), '#123456');
    renderer.renderRouteGeometry('61C', geometry(), '#abcdef');
    expect(map.lines[0].line.remove).toHaveBeenCalledTimes(1);
    expect(map.lines[1].line.remove).toHaveBeenCalledTimes(1);
    renderer.renderStopMarkers('61C', [stop('north', 40.45)], 'INBOUND');
    expect(renderer.getRouteBounds('61C')).toEqual({
      north: 40.45,
      south: 40.44,
      east: -79.93,
      west: -79.95
    });
    expect(renderer.getRouteBounds('missing')).toBeNull();
    expect(renderer.getRouteColor('61C')).toBe('#abcdef');
  });

  test('invalid geometry is ignored instead of sending invalid overlays or bounds', () => {
    renderer.renderRouteGeometry(
      'bad',
      [{ direction: 'INBOUND', path: [path[0], { lat: NaN, lng: 0 }] }],
      '#123456'
    );
    renderer.renderRouteGeometry(
      'short',
      [{ direction: 'INBOUND', path: [path[0]] }],
      '#123456'
    );
    expect(map.lines).toHaveLength(0);
    renderer.fitToRouteData({ type: 'FeatureCollection', features: [] });
    expect(map.provider.fitBounds).not.toHaveBeenCalled();
    renderer.fitToRouteData(geometry());
    expect(map.provider.fitBounds).toHaveBeenCalledWith({
      north: 40.44,
      south: 40.44,
      east: -79.93,
      west: -79.95
    });
  });

  test('late geometry replacement preserves hidden directions until explicitly cleared', () => {
    renderer.renderRouteGeometry('61C', geometry(), '#123456');
    renderer.hideDirectionPolylines('61C', 'INBOUND');
    renderer.renderRouteGeometry('61C', geometry(), '#abcdef');
    renderer.renderDetourGeometry('61C', detour());
    map.lines
      .slice(2)
      .forEach(({ line }) =>
        expect(line.setVisible).toHaveBeenLastCalledWith(false)
      );
    expect(renderer.getRoutesAtPosition(path[0])).toEqual([]);
    renderer.clearRoutePolylines('61C');
    renderer.renderRouteGeometry('61C', geometry(), '#abcdef');
    expect(map.lines[6].line.setVisible).not.toHaveBeenCalled();
    expect(renderer.getRoutesAtPosition(path[0])).toEqual(['61C']);
  });

  test('late geometry replacement preserves a hidden route', () => {
    renderer.renderRouteGeometry('61C', geometry(), '#123456');
    renderer.hideRoute('61C');
    renderer.renderRouteGeometry('61C', geometry(), '#abcdef');
    expect(map.lines[2].line.setVisible).toHaveBeenLastCalledWith(false);
    expect(map.lines[3].line.setVisible).toHaveBeenLastCalledWith(false);
    expect(renderer.getRoutesAtPosition(path[0])).toEqual([]);
    renderer.showRoute('61C');
    expect(renderer.getRoutesAtPosition(path[0])).toEqual(['61C']);
  });

  test('late route colors update existing stop rings and subsequent zoom icons without replacing markers', () => {
    renderer.renderRouteGeometry('61C', geometry(), '#123456');
    const clicked = jest.fn();
    renderer.renderStopMarkers('61C', [stop()], 'INBOUND', clicked);
    renderer.renderStopMarkers('61D', [stop('other')], 'INBOUND');
    renderer.renderRouteGeometry('61C', geometry(), '#abcdef');
    expect(map.markers).toHaveLength(2);
    expect(map.markers[0].marker.remove).not.toHaveBeenCalled();
    expect(map.markers[0].marker.setIcon).toHaveBeenLastCalledWith(
      createStopIcon('#abcdef', 14)
    );
    expect(map.markers[1].marker.setIcon).not.toHaveBeenCalled();
    expect(map.markers[0].marker.onClick).toHaveBeenCalledTimes(1);
    map.markers[0].marker.onClick.mock.calls[0][0]();
    expect(clicked).toHaveBeenCalledTimes(1);
    map.zoomTo(16);
    expect(map.markers[0].marker.setIcon).toHaveBeenLastCalledWith(
      createStopIcon('#abcdef', 16)
    );
    renderer.renderRouteGeometry('61C', geometry(), '#abcdef');
    expect(map.markers[0].marker.setIcon).toHaveBeenCalledTimes(2);
  });

  test('malformed detour paths are skipped without preventing the valid detour', () => {
    const invalidPaths = [
      undefined,
      null,
      {},
      [null, path[0]],
      [{ lat: Infinity, lng: 0 }, path[0]]
    ];
    const invalidOriginals = [
      {},
      [null, path[0]],
      [{ lat: 40, lng: NaN }, path[0]]
    ];
    const geometryEntries = [
      ...invalidPaths.map((detourPath) => ({
        direction: 'INBOUND',
        detourPath
      })),
      ...invalidOriginals.map((originalPath) => ({
        direction: 'INBOUND',
        detourPath: path,
        originalPath
      })),
      ...detour()[0].geometry!
    ];
    expect(() =>
      renderer.renderDetourGeometry('61C', [
        { geometry: geometryEntries }
      ] as unknown as IDetour[])
    ).not.toThrow();
    expect(map.lines).toHaveLength(2);
    expect(map.lines[1].options.path).toEqual(path);
  });

  test('malformed detour containers do not prevent subsequent valid geometry', () => {
    const entries = [
      null,
      {},
      { geometry: {} },
      { geometry: [null, {}] },
      ...detour()
    ] as unknown as IDetour[];
    expect(() => renderer.renderDetourGeometry('61C', entries)).not.toThrow();
    expect(map.lines).toHaveLength(2);
    expect(() =>
      renderer.renderDetourGeometry('61C', null as unknown as IDetour[])
    ).not.toThrow();
    map.lines.forEach(({ line }) =>
      expect(line.remove).toHaveBeenCalledTimes(1)
    );
  });

  test('clear all removes every overlay and color, with no later zoom work', () => {
    renderer.renderRouteGeometry('61C', geometry(), '#123456');
    renderer.renderDetourGeometry('61C', detour());
    renderer.renderStopMarkers('61C', [stop()], 'INBOUND');
    renderer.clearAllRoutes();
    map.lines.forEach(({ line }) =>
      expect(line.remove).toHaveBeenCalledTimes(1)
    );
    expect(map.markers[0].marker.remove).toHaveBeenCalledTimes(1);
    expect(renderer.getRouteColor('61C')).toBe('#c41230');
    map.zoomTo(18);
    expect(map.markers[0].marker.setIcon).not.toHaveBeenCalled();
  });

  test('untrusted route colors cannot inject SVG markup', () => {
    const svg = decodeURIComponent(
      createStopIcon('"/><script>alert(1)</script>', 14).url
    );
    expect(svg).not.toContain('<script');
    expect(svg).toContain('stroke="#c41230"');
  });
});

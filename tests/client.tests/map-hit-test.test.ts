import {
  findMapHits,
  MapHitTarget
} from '../../client/scripts/utils/map-hit-test';

const origin = { lat: 40.44, lng: -79.94 };
function target(
  id: string,
  kind: 'bus' | 'stop' | 'route',
  position = origin
): MapHitTarget {
  return { selection: { id, kind, label: id }, position, select: jest.fn() };
}

describe('screen-space transit selection', () => {
  test('groups buses, stops and routes and deduplicates route casings', () => {
    const route = {
      ...target('61C', 'route'),
      position: undefined,
      path: [
        { lat: origin.lat, lng: origin.lng - 0.01 },
        { lat: origin.lat, lng: origin.lng + 0.01 }
      ]
    };
    const hits = findMapHits(origin, 16, [
      route,
      target('stop:1', 'stop'),
      route,
      target('bus:1', 'bus')
    ]);
    expect(hits.map((hit) => hit.selection.id)).toEqual([
      'bus:1',
      'stop:1',
      '61C'
    ]);
  });

  test('uses a fixed CSS-pixel target at different zoom levels', () => {
    const west = target('stop', 'stop', { ...origin, lng: origin.lng - 0.001 });
    expect(findMapHits(origin, 14, [west])).toHaveLength(1);
    expect(findMapHits(origin, 17, [west])).toHaveLength(0);
  });

  test('finds the middle of a route segment without relying on its vertices', () => {
    const route = {
      ...target('61', 'route'),
      position: undefined,
      path: [
        { lat: origin.lat, lng: origin.lng - 0.1 },
        { lat: origin.lat, lng: origin.lng + 0.1 }
      ]
    };
    expect(findMapHits(origin, 19, [route])[0].distance).toBeCloseTo(0);
  });

  test('does not extend a segment past its endpoint', () => {
    const route = {
      ...target('61', 'route'),
      position: undefined,
      path: [
        { ...origin, lng: origin.lng + 0.01 },
        { ...origin, lng: origin.lng + 0.02 }
      ]
    };
    expect(findMapHits(origin, 16, [route])).toEqual([]);
  });

  test('keeps a directly clicked object even if its icon is offset from its anchor', () => {
    const bus = target('bus', 'bus', { ...origin, lng: origin.lng + 0.01 });
    expect(findMapHits(origin, 16, [bus], 24)).toEqual([]);
    expect(findMapHits(origin, 16, [bus], 24, 'bus')).toHaveLength(1);
  });

  test('keeps the nearest callback when several segments represent the same route', () => {
    const far = target('route', 'route', {
      ...origin,
      lng: origin.lng + 0.0001
    });
    const near = target('route', 'route');
    findMapHits(origin, 16, [far, near])[0].select();
    expect(near.select).toHaveBeenCalledTimes(1);
    expect(far.select).not.toHaveBeenCalled();
  });

  test('rejects invalid map coordinates and isolated invalid segments', () => {
    const bad = target('stop', 'stop', { lat: Number.NaN, lng: 0 });
    expect(findMapHits(origin, 16, [bad])).toEqual([]);
    expect(
      findMapHits({ lat: Number.NaN, lng: 0 }, 16, [target('bus', 'bus')])
    ).toEqual([]);
    expect(findMapHits(origin, Number.NaN, [target('bus', 'bus')])).toEqual([]);
  });

  test('recognizes nearby points across the antimeridian', () => {
    const stop = target('stop', 'stop', { lat: 0, lng: -179.9999 });
    expect(findMapHits({ lat: 0, lng: 179.9999 }, 16, [stop])).toHaveLength(1);
  });
});

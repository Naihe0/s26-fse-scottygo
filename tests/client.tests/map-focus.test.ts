/** @jest-environment jsdom */
import { focusNearby } from '../../client/scripts/utils/map-focus';

const position = { lat: 40.4433, lng: -79.9436 };
const map = { getZoom: jest.fn(), setZoom: jest.fn(), setCenter: jest.fn() };

function size(
  element: Element,
  x: number,
  y: number,
  width: number,
  height: number
) {
  jest.spyOn(element, 'getBoundingClientRect').mockReturnValue({
    x,
    y,
    width,
    height,
    top: y,
    left: x,
    bottom: y + height,
    right: x + width,
    toJSON: () => ({})
  });
}

function viewport(width: number, height: number) {
  size(document.querySelector('.map-container')!, 0, 56, width, height);
  size(document.querySelector('#map')!, 0, 56, width, height);
}

beforeEach(() => {
  document.body.innerHTML =
    '<main class="map-container"><div id="map"></div></main>';
  map.getZoom.mockReturnValue(14);
  map.setZoom.mockClear();
  map.setCenter.mockClear();
});

afterEach(() => jest.restoreAllMocks());

test.each([
  [390, 688],
  [1024, 744],
  [844, 300]
])(
  'focuses about 200m around a point at %sx%s without a fixed zoom',
  (width, height) => {
    viewport(width, height);
    focusNearby(map, position);
    const zoom = map.setZoom.mock.calls[0][0];
    const groundMetersPerPixel =
      (40_075_016.686 * Math.cos((position.lat * Math.PI) / 180)) /
      (256 * 2 ** zoom);
    const displayedRadius =
      (Math.min(width - 48, height - 48) * groundMetersPerPixel) / 2;
    // Integer map zoom levels differ by a factor of two; choose the closest scale.
    expect(displayedRadius).toBeGreaterThanOrEqual(140);
    expect(displayedRadius).toBeLessThanOrEqual(285);
    expect(map.setCenter).toHaveBeenCalledWith(position);
  }
);

test('preserves an already closer view while centering the selected point', () => {
  viewport(390, 688);
  map.getZoom.mockReturnValue(19);
  focusNearby(map, position);
  expect(map.setZoom).not.toHaveBeenCalled();
  expect(map.setCenter).toHaveBeenCalledWith(position);
});

test('positions the point between the search bar and an open bottom popup', () => {
  viewport(390, 688);
  const container = document.querySelector('.map-container')!;
  const search = document.createElement('transit-search');
  const searchBar = document.createElement('div');
  searchBar.className = 'search-bar';
  search.append(searchBar);
  const popup = document.createElement('div');
  popup.id = 'map-popup';
  container.append(search, popup);
  size(searchBar, 16, 72, 358, 48);
  size(popup, 0, 444, 390, 300);
  focusNearby(map, position);
  const center = map.setCenter.mock.calls[0][0];
  const zoom = map.setZoom.mock.calls[0][0];
  const worldY = (lat: number) =>
    (1 - Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360)) / Math.PI) / 2;
  const pointScreenY =
    688 / 2 + (worldY(position.lat) - worldY(center.lat)) * 256 * 2 ** zoom;
  expect(pointScreenY).toBeCloseTo((80 + 372) / 2, 5);
  expect(center.lng).toBe(position.lng);
});

test('ignores hidden and off-map popups when choosing the center', () => {
  viewport(390, 688);
  const popup = document.createElement('div');
  popup.id = 'map-popup';
  popup.hidden = true;
  document.body.append(popup);
  size(popup, 0, 400, 390, 300);
  focusNearby(map, position);
  expect(map.setCenter).toHaveBeenLastCalledWith(position);
  popup.hidden = false;
  size(popup, 800, 400, 390, 300);
  focusNearby(map, position);
  expect(map.setCenter).toHaveBeenLastCalledWith(position);
});

test('does not place the focused point under a popup on a short landscape screen', () => {
  viewport(844, 254);
  const search = document.createElement('transit-search');
  const popup = document.createElement('div');
  popup.id = 'map-popup';
  document.querySelector('.map-container')!.append(search, popup);
  size(search, 16, 72, 812, 48);
  size(popup, 0, 154, 844, 156);
  focusNearby(map, position);
  const center = map.setCenter.mock.calls[0][0];
  const zoom = map.setZoom.mock.calls[0][0];
  const worldY = (lat: number) =>
    (1 - Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360)) / Math.PI) / 2;
  const pointScreenY =
    254 / 2 + (worldY(position.lat) - worldY(center.lat)) * 256 * 2 ** zoom;
  expect(pointScreenY).toBeGreaterThan(64);
  expect(pointScreenY).toBeLessThan(98);
});

test('larger requested radii produce a wider view and unknown zoom is recoverable', () => {
  viewport(390, 688);
  map.getZoom.mockReturnValue(NaN);
  focusNearby(map, position, 400);
  const wideZoom = map.setZoom.mock.calls[0][0];
  focusNearby(map, position, 200);
  expect(map.setZoom.mock.calls[1][0]).toBe(wideZoom + 1);
});

test('invalid position cannot move the map and invalid radius uses the safe default', () => {
  viewport(390, 688);
  focusNearby(map, { lat: NaN, lng: 0 });
  focusNearby(map, { lat: 40, lng: 181 });
  expect(map.setCenter).not.toHaveBeenCalled();
  focusNearby(map, position, -1);
  expect(map.setCenter).toHaveBeenCalledWith(position);
  expect(Number.isFinite(map.setZoom.mock.calls[0][0])).toBe(true);
});

test('a not-yet-sized map still has a finite nearby focus', () => {
  focusNearby(map, position);
  expect(Number.isFinite(map.setZoom.mock.calls[0][0])).toBe(true);
  expect(map.setCenter).toHaveBeenCalledWith(position);
});

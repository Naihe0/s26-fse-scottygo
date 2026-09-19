/** @jest-environment jsdom */

import { createBusIcon } from '../../client/scripts/utils/bus-icon';
import type { IVehicle } from '../../common/transit.interface';

const vehicle = (heading: number = 0, isDetoured = false): IVehicle => ({
  vid: 'private-vehicle-id',
  lat: 40.443321,
  lon: -79.943654,
  routeId: 'private-route-name',
  heading,
  source: 'live',
  lastUpdate: '2026-09-19T12:34:56Z',
  isDetoured
});

function decodeIcon(bus: IVehicle = vehicle(), zoom = 14, color = '#2563eb') {
  const icon = createBusIcon(bus, zoom, color);
  const svg = decodeURIComponent(icon.url.split(',')[1]);
  const document = new DOMParser().parseFromString(svg, 'image/svg+xml');
  expect(document.querySelector('parsererror')).toBeNull();
  return { icon, svg, document };
}

describe('circular bus marker', () => {
  it.each([0, 90, 180, 270])(
    'points to compass bearing %d without rotating or mirroring the bus',
    (heading) => {
      const { document } = decodeIcon(vehicle(heading));
      const pointer = document.querySelector('[data-part="heading"]')!;
      expect(pointer.getAttribute('transform')).toBe(
        `rotate(${heading} 24 24)`
      );
      expect(pointer.querySelector('path')!.getAttribute('d')).toBe(
        'M24 2.5 19.5 8.5 28.5 8.5Z'
      );
      expect(
        document.querySelector('[data-part="bus"]')!.closest('[transform]')
      ).toBeNull();
      expect(document.querySelector('[data-part="badge"]')!.tagName).toBe(
        'circle'
      );
      expect(document.querySelectorAll('[transform]')).toHaveLength(1);

      // The tip begins outside the rim and rotates toward the requested compass axis.
      const angle = (heading * Math.PI) / 180;
      const tip = {
        x: 24 + 21.5 * Math.sin(angle),
        y: 24 - 21.5 * Math.cos(angle)
      };
      if (heading === 0) expect(tip.y).toBeLessThan(9);
      if (heading === 90) expect(tip.x).toBeGreaterThan(39);
      if (heading === 180) expect(tip.y).toBeGreaterThan(39);
      if (heading === 270) expect(tip.x).toBeLessThan(9);
    }
  );

  it.each([
    [-90, 270],
    [450, 90],
    [-720, 0],
    [359.5, 359.5]
  ])('normalizes finite heading %d to %d', (heading, normalized) => {
    expect(
      decodeIcon(vehicle(heading))
        .document.querySelector('[data-part="heading"]')!
        .getAttribute('transform')
    ).toBe(`rotate(${normalized} 24 24)`);
  });

  it.each([undefined, null, NaN, Infinity, -Infinity, '90'])(
    'does not imply a direction for heading %s',
    (heading) => {
      const bus = { ...vehicle(), heading } as unknown as IVehicle;
      const { document } = decodeIcon(bus);
      expect(document.querySelector('[data-part="heading"]')).toBeNull();
      expect(document.querySelector('[data-part="badge"]')).not.toBeNull();
      expect(document.querySelector('[data-part="bus"]')).not.toBeNull();
    }
  );

  it.each([
    [-100, 32],
    [10, 32],
    [10.5, 33],
    [14, 40],
    [16, 44],
    [100, 44],
    [NaN, 40],
    [Infinity, 40]
  ])(
    'keeps the marker bounded and anchored at the center at zoom %d',
    (zoom, size) => {
      const { icon, document } = decodeIcon(vehicle(), zoom);
      expect(icon.size).toEqual({ width: size, height: size });
      expect(icon.anchor).toEqual({ x: size / 2, y: size / 2 });
      expect(document.documentElement.getAttribute('width')).toBe(String(size));
      expect(document.documentElement.getAttribute('height')).toBe(
        String(size)
      );
    }
  );

  it.each([
    ['#f06', '#f06'],
    ['aBc123', '#aBc123'],
    [' #123456 ', '#123456']
  ])('retains valid route color %s', (color, expected) => {
    expect(
      decodeIcon(vehicle(), 14, color)
        .document.querySelector('[data-part="badge"]')!
        .getAttribute('fill')
    ).toBe(expected);
  });

  it.each([
    'red',
    'transparent',
    '#12',
    '#12345g',
    'url(https://example.com/tracker)',
    '"><script>alert(1)</script>'
  ])('safely replaces invalid color %s', (color) => {
    const { document, svg } = decodeIcon(vehicle(), 14, color);
    expect(
      document.querySelector('[data-part="badge"]')!.getAttribute('fill')
    ).toBe('#2563eb');
    expect(document.querySelector('script')).toBeNull();
    expect(svg).not.toContain(color);
  });

  it('uses amber for detoured buses, including their pointer', () => {
    const { document } = decodeIcon(vehicle(90, true), 14, '#2563eb');
    expect(
      document.querySelector('[data-part="badge"]')!.getAttribute('fill')
    ).toBe('#d97706');
    for (const path of document.querySelectorAll(
      '[data-part="heading"] path'
    )) {
      expect(path.getAttribute('fill')).toBe('#d97706');
    }
  });

  it('keeps supplied vehicle metadata and external resources out of the asset', () => {
    const bus = vehicle();
    const { svg, document, icon } = decodeIcon(bus);
    expect(icon.url).toMatch(/^data:image\/svg\+xml;charset=UTF-8,/);
    for (const privateValue of [
      bus.vid,
      bus.routeId,
      bus.lat,
      bus.lon,
      bus.lastUpdate
    ]) {
      expect(svg).not.toContain(String(privateValue));
    }
    expect(
      document.querySelector(
        'image, use, script, foreignObject, [href], [onload]'
      )
    ).toBeNull();
    expect(svg).not.toContain('url(');
  });
});

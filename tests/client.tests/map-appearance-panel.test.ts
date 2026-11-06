/** @jest-environment jsdom */
import { MapAppearancePanel } from '../../client/scripts/components/map-appearance-panel';

function mount() {
  document.body.innerHTML =
    '<main class="map-container"><button id="layers-btn"></button><div id="map"></div></main>';
  const panel = new MapAppearancePanel();
  document.querySelector('main')!.append(panel);
  const apply = jest.fn();
  panel.configure(apply);
  return { panel, apply };
}

afterEach(() => {
  document.body.replaceChildren();
  localStorage.clear();
});

test('chooses an independent satellite base with traffic, preserving both across a page reload', () => {
  let { panel, apply } = mount();
  const change = (selector: string, value: string) => {
    const select = panel.querySelector<HTMLSelectElement>(selector)!;
    select.value = value;
    select.dispatchEvent(new Event('change'));
  };
  change('[data-map-base]', 'satellite');
  change('[data-map-overlay]', 'traffic');
  expect(apply).toHaveBeenLastCalledWith({
    base: 'satellite',
    overlay: 'traffic',
    contrast: false
  });
  panel.remove();
  ({ panel, apply } = mount());
  expect(apply).toHaveBeenLastCalledWith({
    base: 'satellite',
    overlay: 'traffic',
    contrast: false
  });
  panel.querySelector<HTMLButtonElement>('[data-reset-map]')!.click();
  expect(apply).toHaveBeenLastCalledWith({
    base: 'road',
    overlay: 'none',
    contrast: false
  });
});

test('focus map keeps an explicit exit and Escape restores usable controls', () => {
  const { panel } = mount();
  panel.querySelector<HTMLButtonElement>('[data-focus-map]')!.click();
  expect(
    document.querySelector('main')!.classList.contains('is-map-focused')
  ).toBe(true);
  const exit = panel.querySelector<HTMLButtonElement>('.map-focus-exit')!;
  expect(exit.hidden).toBe(false);
  expect(document.activeElement).toBe(exit);
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
  expect(exit.hidden).toBe(true);
  expect(
    document.querySelector('main')!.classList.contains('is-map-focused')
  ).toBe(false);
  expect(document.activeElement).toBe(document.getElementById('layers-btn'));
});

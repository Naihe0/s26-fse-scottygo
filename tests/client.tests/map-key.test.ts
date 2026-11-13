/** @jest-environment jsdom */
import '../../client/scripts/components/map-key';

let key: HTMLElement;
let toggle: HTMLButtonElement;
let panel: HTMLElement;

beforeEach(() => {
  document.body.innerHTML =
    '<map-key></map-key><button id="other">Search</button>';
  key = document.querySelector('map-key')!;
  toggle = key.querySelector('button')!;
  panel = key.querySelector('section')!;
});
afterEach(() => {
  document.body.innerHTML = '';
});

test('keeps explanations collapsed until requested and reuses actual map artwork', () => {
  expect(panel.hidden).toBe(true);
  expect(toggle.getAttribute('aria-expanded')).toBe('false');
  expect(toggle.getAttribute('aria-controls')).toBe(panel.id);
  toggle.click();
  expect(panel.hidden).toBe(false);
  expect(toggle.getAttribute('aria-expanded')).toBe('true');
  expect(panel.textContent).toContain('Triangle shows travel direction');
  expect(panel.textContent).toContain('Blue marks your GPS position');
  const images = [...panel.querySelectorAll('img')];
  expect(images).toHaveLength(6);
  for (const img of images) {
    expect(img.src).toMatch(/^data:image\/svg\+xml/);
    expect(img.alt).toBe('');
  }
  toggle.click();
  expect(panel.hidden).toBe(true);
});

test('Escape closes the disclosure and restores its trigger focus', () => {
  toggle.click();
  document.getElementById('other')!.focus();
  document.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })
  );
  expect(panel.hidden).toBe(true);
  expect(document.activeElement).toBe(toggle);
  expect(toggle.getAttribute('aria-expanded')).toBe('false');
});

test('outside interaction closes without taking focus away from another control', () => {
  toggle.click();
  panel.dispatchEvent(new Event('pointerdown', { bubbles: true }));
  expect(panel.hidden).toBe(false);
  const other = document.getElementById('other')!;
  other.focus();
  other.dispatchEvent(new Event('pointerdown', { bubbles: true }));
  expect(panel.hidden).toBe(true);
  expect(document.activeElement).toBe(other);
});

test('a removed map key no longer handles document keyboard events', () => {
  toggle.click();
  key.remove();
  const other = document.getElementById('other')!;
  other.focus();
  document.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })
  );
  expect(panel.hidden).toBe(false);
  expect(document.activeElement).toBe(other);
  document.body.appendChild(key);
  expect(key.querySelector('section')!.hidden).toBe(true);
});

test('an open key stops below the search bar instead of sliding under it', () => {
  document.body.innerHTML =
    '<div class="map-container"><div class="search-bar"></div><map-key></map-key></div>';
  const rect = (top: number, bottom: number) =>
    ({
      top,
      bottom,
      left: 0,
      right: 0,
      width: 0,
      height: bottom - top
    }) as DOMRect;
  const container = document.querySelector('.map-container')!;
  const search = document.querySelector('.search-bar')!;
  const fitted = document.querySelector('map-key')!;
  const button = fitted.querySelector<HTMLButtonElement>('.map-key__toggle')!;
  const section = fitted.querySelector<HTMLElement>('.map-key__panel')!;
  jest.spyOn(container, 'getBoundingClientRect').mockReturnValue(rect(56, 510));
  jest.spyOn(search, 'getBoundingClientRect').mockReturnValue(rect(68, 116));
  const toggleRect = jest
    .spyOn(button, 'getBoundingClientRect')
    .mockReturnValue(rect(400, 444));
  button.click();
  // Toggle top 400 − 10 px gap, below the search bar's 116 + 10 px.
  expect(section.style.maxHeight).toBe('264px');
  toggleRect.mockReturnValue(rect(300, 344));
  window.dispatchEvent(new Event('resize'));
  expect(section.style.maxHeight).toBe('164px');
  // A very short screen keeps a readable minimum and scrolls inside it.
  toggleRect.mockReturnValue(rect(200, 244));
  window.dispatchEvent(new Event('resize'));
  expect(section.style.maxHeight).toBe('160px');
  button.click();
  toggleRect.mockReturnValue(rect(500, 544));
  window.dispatchEvent(new Event('resize'));
  expect(section.style.maxHeight).toBe('160px');
  jest.restoreAllMocks();
});

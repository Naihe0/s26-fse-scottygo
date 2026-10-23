/** @jest-environment jsdom */
import { RouteSelectorPanel } from '../../client/scripts/components/route-selector';
import { TogglePanel } from '../../client/scripts/components/toggle-panel';
import '../../client/scripts/components/route-selector';
import '../../client/scripts/components/toggle-panel';

let routes: RouteSelectorPanel;
let systems: TogglePanel;
let opener: HTMLButtonElement;

const routeOptions = [
  { id: '61A', name: '61A · Wilkinsburg' },
  { id: '61B', name: '61B · Braddock' },
  { id: 'CMU-G', name: 'Green · 校园' }
];

beforeEach(() => {
  document.body.innerHTML =
    '<button id="opener">Filters</button><button id="elsewhere">Elsewhere</button><route-selector-panel></route-selector-panel><toggle-panel></toggle-panel>';
  routes = document.querySelector('route-selector-panel')!;
  systems = document.querySelector('toggle-panel')!;
  opener = document.querySelector('#opener')!;
  routes.setRoutes(routeOptions);
  systems.configure({
    title: 'Transit systems',
    eventName: 'systemFilterApplied',
    emptyMessage: 'Routes and buses will be hidden',
    options: [
      { id: 'prt', label: 'Pittsburgh Regional Transit', defaultChecked: true },
      { id: 'cmu', label: 'CMU Shuttle', defaultChecked: false }
    ]
  });
});

afterEach(() => {
  document.body.innerHTML = '';
});

const search = (value: string): HTMLInputElement => {
  const input = routes.querySelector<HTMLInputElement>('.route-search-input')!;
  input.focus();
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  return input;
};

test('route filtering retains the input, focus and selection during typing and data refresh', () => {
  routes.show();
  const input = search('61');
  input.setSelectionRange(1, 1);
  const shell = routes.querySelector('.route-selector-panel');
  input.dispatchEvent(new Event('input', { bubbles: true }));
  routes.setRoutes([...routeOptions, { id: '61C', name: '61C · Homestead' }]);
  expect(routes.querySelector('.route-search-input')).toBe(input);
  expect(routes.querySelector('.route-selector-panel')).toBe(shell);
  expect(document.activeElement).toBe(input);
  expect(input.value).toBe('61');
  expect(input.selectionStart).toBe(1);
  expect(routes.querySelectorAll('.route-btn')).toHaveLength(3);
  expect(routes.querySelector('.route-results-status')!.textContent).toBe(
    '3 routes'
  );
});

test('IME composition preserves candidates until composition ends and Escape does not dismiss it', () => {
  routes.show();
  const input = routes.querySelector<HTMLInputElement>('.route-search-input')!;
  input.focus();
  input.dispatchEvent(
    new CompositionEvent('compositionstart', { bubbles: true })
  );
  input.value = '校';
  input.dispatchEvent(
    new InputEvent('input', { bubbles: true, isComposing: true })
  );
  input.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })
  );
  routes.setRoutes(routeOptions);
  expect(routes.isOpen()).toBe(true);
  expect(routes.querySelectorAll('.route-btn')).toHaveLength(3);
  expect(document.activeElement).toBe(input);
  input.dispatchEvent(
    new CompositionEvent('compositionend', { bubbles: true })
  );
  expect(routes.querySelectorAll('.route-btn')).toHaveLength(1);
  expect(routes.querySelector('.route-btn')!.getAttribute('data-route')).toBe(
    'CMU-G'
  );
  expect(routes.querySelector('.route-search-input')).toBe(input);
});

test('empty results retain the selected route and clear search recovers the list', () => {
  routes.setSelection('61A');
  routes.show();
  const input = search('<img src=x>');
  expect(routes.querySelector('.route-empty')!.textContent).toContain(
    'No routes match'
  );
  expect(routes.querySelector('.route-empty img')).toBeNull();
  expect(routes.querySelector('.route-selection-summary')!.textContent).toBe(
    'Selected: 61A · Wilkinsburg'
  );
  expect(routes.querySelector('#route-ok')!.textContent).toBe('Show route');
  routes.querySelector<HTMLButtonElement>('.route-search-clear')!.click();
  expect(input.value).toBe('');
  expect(document.activeElement).toBe(input);
  expect(routes.querySelectorAll('.route-btn')).toHaveLength(3);
  expect(
    routes.querySelector('[data-route="61A"]')!.getAttribute('aria-pressed')
  ).toBe('true');
});

test('selecting a route is a draft and Escape restores the committed route and opener focus', () => {
  const selected = jest.fn();
  routes.addEventListener('routeSelected', selected);
  routes.setSelection('61A');
  opener.focus();
  routes.show();
  expect(document.activeElement).toBe(routes.querySelector('[role="dialog"]'));
  routes.querySelector<HTMLButtonElement>('[data-route="61B"]')!.click();
  expect(selected).not.toHaveBeenCalled();
  routes.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })
  );
  expect(routes.isOpen()).toBe(false);
  expect(document.activeElement).toBe(opener);
  expect(
    routes.querySelector('[data-route="61A"]')!.getAttribute('aria-pressed')
  ).toBe('true');
  expect(selected).not.toHaveBeenCalled();
});

test('All routes has an explicit action and committing it emits one null selection', () => {
  const selected = jest.fn();
  routes.addEventListener('routeSelected', selected);
  routes.setSelection('61A');
  routes.show();
  routes.querySelector<HTMLButtonElement>('[data-route="61A"]')!.click();
  expect(
    routes.querySelector('[data-route="61A"]')!.getAttribute('aria-pressed')
  ).toBe('true');
  routes.querySelector<HTMLButtonElement>('.route-all')!.click();
  expect(routes.querySelector('#route-ok')!.textContent).toBe(
    'Show all routes'
  );
  routes.querySelector<HTMLButtonElement>('#route-ok')!.click();
  expect(selected).toHaveBeenCalledTimes(1);
  expect(selected.mock.calls[0][0].detail).toEqual({ route: null });
  routes.show();
  expect(routes.querySelector('.route-all')!.getAttribute('aria-pressed')).toBe(
    'true'
  );
});

test('closing after an outside action does not steal its focus', () => {
  opener.focus();
  routes.show();
  const outside = document.querySelector<HTMLButtonElement>('#elsewhere')!;
  outside.focus();
  routes.hide();
  expect(document.activeElement).toBe(outside);
});

test('tapping the system label changes only its draft and explains an empty map before Apply', () => {
  const applied = jest.fn();
  systems.addEventListener('systemFilterApplied', applied);
  systems.show();
  systems.querySelector<HTMLElement>('.filter-label')!.click();
  expect(systems.querySelector<HTMLInputElement>('#prt')!.checked).toBe(false);
  expect(systems.getState().get('prt')).toBe(true);
  expect(systems.querySelector('.toggle-selection-summary')!.textContent).toBe(
    'Routes and buses will be hidden'
  );
  expect(applied).not.toHaveBeenCalled();
  systems.querySelector<HTMLButtonElement>('#toggle-ok')!.click();
  expect(applied).toHaveBeenCalledTimes(1);
  expect(applied.mock.calls[0][0].detail).toEqual({ prt: false, cmu: false });
  systems.show();
  expect(systems.querySelector<HTMLInputElement>('#prt')!.checked).toBe(false);
});

test('system Escape and close discard drafts and restore focus; reconnecting has no duplicate handlers', () => {
  const applied = jest.fn();
  systems.addEventListener('systemFilterApplied', applied);
  systems.remove();
  document.body.append(systems);
  opener.focus();
  systems.show();
  systems.querySelector<HTMLInputElement>('#cmu')!.click();
  systems.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })
  );
  expect(systems.isOpen()).toBe(false);
  expect(document.activeElement).toBe(opener);
  expect(systems.querySelector<HTMLInputElement>('#cmu')!.checked).toBe(false);
  systems.show();
  systems.querySelector<HTMLInputElement>('#cmu')!.click();
  systems.querySelector<HTMLButtonElement>('.route-controls-close')!.click();
  expect(systems.querySelector<HTMLInputElement>('#cmu')!.checked).toBe(false);
  expect(applied).not.toHaveBeenCalled();
  systems.show();
  systems.querySelector<HTMLButtonElement>('#toggle-ok')!.click();
  expect(applied).toHaveBeenCalledTimes(1);
});

test('route names and filter labels are displayed as text, including selector-sensitive IDs', () => {
  routes.setRoutes([{ id: 'route"id', name: '<img src=x>' }]);
  expect(routes.querySelector('.route-btn')!.textContent).toContain(
    '<img src=x>'
  );
  expect(routes.querySelector('img')).toBeNull();
  systems.configure({
    title: 'Transit <systems>',
    eventName: 'customFilterApplied',
    options: [{ id: 'route[1]', label: '<img src=x>', defaultChecked: true }]
  });
  expect(systems.querySelector('img')).toBeNull();
  systems.setState({ 'route[1]': false });
  expect(systems.querySelector<HTMLInputElement>('input')!.checked).toBe(false);
  expect(systems.getState().size).toBe(1);
});

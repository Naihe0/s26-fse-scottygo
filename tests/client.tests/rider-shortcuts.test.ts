/** @jest-environment jsdom */
import {
  RiderShortcuts,
  RiderShortcutsContext
} from '../../client/scripts/components/rider-shortcuts';
import {
  getRiderShortcuts,
  recordRecentRoute,
  recordRecentStop,
  saveFilterView,
  savePlace,
  toggleSavedStop
} from '../../client/scripts/utils/rider-shortcuts';
import { copyStopLink } from '../../client/scripts/utils/stop-link';
jest.mock('../../client/scripts/utils/stop-link', () => ({
  copyStopLink: jest.fn().mockResolvedValue(undefined)
}));

const stop = {
  stopId: '123',
  stopName: 'Forbes & Morewood',
  lat: 40.44,
  lon: -79.94,
  routes: ['61C']
};
let account = 0;

describe('My places rider shortcut interactions', () => {
  let element: RiderShortcuts;
  let context: RiderShortcutsContext;
  let trigger: HTMLButtonElement;
  const showModal = HTMLDialogElement.prototype.showModal;
  const close = HTMLDialogElement.prototype.close;

  function click(label: string, root: ParentNode = element) {
    const target = [...root.querySelectorAll<HTMLButtonElement>('button')].find(
      (item) =>
        item.textContent === label || item.getAttribute('aria-label') === label
    );
    if (!target) throw new Error(`Missing button: ${label}`);
    target.click();
    return target;
  }

  function submit(value: string, root: ParentNode = element) {
    const input = root.querySelector<HTMLInputElement>('input')!;
    input.value = value;
    input
      .closest('form')!
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  }

  beforeAll(() => {
    HTMLDialogElement.prototype.showModal = function () {
      this.setAttribute('open', '');
    };
    HTMLDialogElement.prototype.close = function () {
      this.removeAttribute('open');
    };
  });
  afterAll(() => {
    HTMLDialogElement.prototype.showModal = showModal;
    HTMLDialogElement.prototype.close = close;
  });
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem('username', `component-${++account}`);
    localStorage.setItem(
      'token',
      `header.${btoa(JSON.stringify({ userId: `component-${account}` }))}.signature`
    );
    jest.clearAllMocks();
    context = {
      getOrigin: jest.fn(() => ({
        lat: 40.44,
        lng: -79.94,
        label: 'CMU Campus'
      })),
      getFilters: jest.fn(() => ({
        selectedRouteId: '61C',
        selectedSystems: { prt: true, cmu: false },
        selectedDirections: { inbound: true, outbound: true }
      })),
      onSelectStop: jest.fn(),
      onSelectRoute: jest.fn(),
      onSelectPlace: jest.fn(),
      onApplyFilters: jest.fn()
    };
    element = new RiderShortcuts();
    element.configure(context);
    document.body.append(element);
    trigger = element.querySelector<HTMLButtonElement>(
      '.rider-shortcuts__trigger'
    )!;
    trigger.focus();
  });
  afterEach(() => {
    element.remove();
    document.body.innerHTML = '';
  });

  test('opens a compact tabbed dialog with local storage disclosure and returns focus on close', () => {
    trigger.click();
    expect(element.querySelector('dialog')!.open).toBe(true);
    expect(
      element.querySelector('[role="tab"][aria-selected="true"]')!.textContent
    ).toBe('Saved stops');
    expect(element.textContent).toContain(
      'Stored in this browser, separately for each account.'
    );
    expect(element.textContent).toContain(
      'Open any stop on the map and tap Save stop.'
    );
    click('Close My places');
    expect(element.querySelector('dialog')!.open).toBe(false);
    expect(document.activeElement).toBe(trigger);
  });

  test('opens saved stops, shares them and removes them independently', () => {
    toggleSavedStop(stop);
    element.open();
    const row = element.querySelector('.rider-shortcuts__row')!;
    click(`Share ${stop.stopName}`, row);
    expect(copyStopLink).toHaveBeenCalledWith(
      '123',
      expect.any(HTMLButtonElement),
      expect.any(Function)
    );
    row.querySelector<HTMLButtonElement>('.rider-shortcuts__primary')!.click();
    expect(context.onSelectStop).toHaveBeenCalledWith(stop);
    expect(element.querySelector('dialog')!.open).toBe(false);
    element.open();
    click(`Remove ${stop.stopName}`);
    expect(getRiderShortcuts().stops).toEqual([]);
    expect(element.querySelector('[role="status"]')!.textContent).toContain(
      'removed'
    );
  });

  test('saves a named planning location, renames it, and reuses its chosen coordinates', () => {
    element.open('places');
    expect(element.textContent).toContain('Save planning location: CMU Campus');
    submit('Campus');
    expect(getRiderShortcuts().places[0]).toEqual(
      expect.objectContaining({
        name: 'Campus',
        lat: 40.44,
        lng: -79.94,
        label: 'CMU Campus'
      })
    );
    const row = element.querySelector('.rider-shortcuts__row')!;
    click('Rename', row);
    submit('School', row);
    expect(getRiderShortcuts().places[0].name).toBe('School');
    element
      .querySelector<HTMLButtonElement>('.rider-shortcuts__primary')!
      .click();
    expect(context.onSelectPlace).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'School', lat: 40.44, lng: -79.94 })
    );
  });

  test('does not offer saving a location before a planning origin is available', () => {
    context.getOrigin = () => null;
    element.open('places');
    expect(element.querySelector<HTMLInputElement>('input')!.disabled).toBe(
      true
    );
    expect(
      element.querySelector<HTMLButtonElement>('[type="submit"]')!.disabled
    ).toBe(true);
    expect(element.textContent).toContain(
      'Choose a planning location on the map'
    );
  });

  test('recent routes and stops dispatch their matching selection callbacks', () => {
    recordRecentStop(stop);
    recordRecentRoute('61C', '61C to McKeesport');
    element.open('recent');
    const rows = [
      ...element.querySelectorAll<HTMLButtonElement>(
        '.rider-shortcuts__primary'
      )
    ];
    rows[0].click();
    expect(context.onSelectRoute).toHaveBeenCalledWith('61C');
    element.open('recent');
    element
      .querySelectorAll<HTMLButtonElement>('.rider-shortcuts__primary')[1]
      .click();
    expect(context.onSelectStop).toHaveBeenCalledWith(stop);
    element.open('recent');
    click('Clear recent');
    expect(getRiderShortcuts().recent).toEqual([]);
  });

  test('saves current route filters and restores them from a named view', () => {
    element.open('views');
    submit('My commute');
    expect(element.textContent).toContain('Route 61C · PRT · Both directions');
    element
      .querySelector<HTMLButtonElement>('.rider-shortcuts__primary')!
      .click();
    expect(context.onApplyFilters).toHaveBeenCalledWith(context.getFilters());
    expect(element.querySelector('dialog')!.open).toBe(false);
  });

  test('supports arrow-key tab navigation and native Escape cancellation', () => {
    element.open();
    document.activeElement!.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })
    );
    expect(document.activeElement!.textContent).toBe('Places');
    expect(
      element
        .querySelector('[role="tabpanel"]')!
        .getAttribute('aria-labelledby')
    ).toBe('rider-shortcuts-tab-places');
    document.activeElement!.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'End', bubbles: true })
    );
    expect(document.activeElement!.textContent).toBe('Views');
    element
      .querySelector('dialog')!
      .dispatchEvent(new Event('cancel', { cancelable: true }));
    expect(element.querySelector('dialog')!.open).toBe(false);
    expect(document.activeElement).toBe(trigger);
  });

  test('renders untrusted names as text and reports capacity without removing earlier views', () => {
    savePlace('<img src=x onerror=alert(1)>', { lat: 40, lng: -80 });
    element.open('places');
    expect(element.querySelector('img')).toBeNull();
    expect(element.textContent).toContain('<img src=x');
    for (let i = 0; i < 8; i++) saveFilterView(`${i}`, context.getFilters());
    click('Views');
    submit('Extra');
    expect(element.querySelector('[role="status"]')!.textContent).toContain(
      '8 views'
    );
    expect(getRiderShortcuts().views).toHaveLength(8);
  });

  test('updates open saved stops when an external card changes the store', () => {
    element.open();
    toggleSavedStop(stop);
    expect(
      element.querySelector('.rider-shortcuts__primary')!.textContent
    ).toContain(stop.stopName);
    toggleSavedStop(stop);
    expect(element.querySelector('.rider-shortcuts__primary')).toBeNull();
  });

  test('disconnecting closes the native modal and detaches storage subscriptions', () => {
    element.open();
    const dialog = element.querySelector('dialog')!;
    element.remove();
    expect(dialog.open).toBe(false);
    expect(() => toggleSavedStop(stop)).not.toThrow();
  });

  test('background history and storage updates preserve a place draft, caret and focus', () => {
    element.open('places');
    const input = element.querySelector<HTMLInputElement>('input')!;
    input.value = 'Draft campus name';
    input.focus();
    input.setSelectionRange(5, 11);
    recordRecentRoute('61C');
    const key = `scottygo:rider-shortcuts:v2:${encodeURIComponent(`user:component-${account}`)}`;
    window.dispatchEvent(new StorageEvent('storage', { key }));
    expect(input.isConnected).toBe(true);
    expect(input.value).toBe('Draft campus name');
    expect(input.selectionStart).toBe(5);
    expect(input.selectionEnd).toBe(11);
    expect(document.activeElement).toBe(input);
    submit('Draft campus name');
    expect(getRiderShortcuts().places[0].name).toBe('Draft campus name');
    expect(
      element.querySelector('.rider-shortcuts__primary')!.textContent
    ).toContain('Draft campus name');
  });

  test('background notifications preserve an open rename form', () => {
    savePlace('Campus', { lat: 40, lng: -80 });
    element.open('places');
    const row = element.querySelector('.rider-shortcuts__row')!;
    click('Rename', row);
    const input = row.querySelector<HTMLInputElement>('input')!;
    input.value = 'My new campus';
    input.focus();
    recordRecentRoute('61C');
    expect(input.isConnected).toBe(true);
    expect(document.activeElement).toBe(input);
    expect(input.value).toBe('My new campus');
    submit('My new campus', row);
    expect(getRiderShortcuts().places[0].name).toBe('My new campus');
  });

  test('dialog padding clicks stay open while backdrop clicks close it', () => {
    element.open();
    const dialog = element.querySelector('dialog')!;
    jest.spyOn(dialog, 'getBoundingClientRect').mockReturnValue({
      left: 20,
      top: 40,
      right: 400,
      bottom: 600
    } as DOMRect);
    dialog.dispatchEvent(
      new MouseEvent('click', { bubbles: true, clientX: 30, clientY: 50 })
    );
    expect(dialog.open).toBe(true);
    dialog.dispatchEvent(
      new MouseEvent('click', { bubbles: true, clientX: 10, clientY: 20 })
    );
    expect(dialog.open).toBe(false);
  });

  test('a different account signing in through another tab closes private shortcut drafts', () => {
    savePlace('Private home', { lat: 40, lng: -80 });
    element.open('places');
    const input = element.querySelector<HTMLInputElement>('input')!;
    input.value = 'Private draft';
    input.focus();
    localStorage.setItem(
      'token',
      `header.${btoa(JSON.stringify({ userId: 'another-account' }))}.signature`
    );
    window.dispatchEvent(new StorageEvent('storage', { key: 'token' }));
    expect(element.querySelector('dialog')!.open).toBe(false);
    element.open('places');
    expect(element.textContent).not.toContain('Private home');
    expect(element.querySelector<HTMLInputElement>('input')!.value).toBe('');
  });
});

/** @jest-environment jsdom */
import { copyViewLink } from '../../client/scripts/utils/copy-view-link';
import { MapStateManager } from '../../client/scripts/state/map-state';
import { URLSyncManager } from '../../client/scripts/state/url-sync';
import '../../client/scripts/components/map-controls';

const state = MapStateManager.getInstance();
const sync = URLSyncManager.getInstance();
let button: HTMLButtonElement;
const announce = jest.fn();
beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
  state.resetFilters();
  history.replaceState(
    null,
    '',
    '/map?token=private&lat=40.412345#/map?unexpected=secret'
  );
  document.body.innerHTML = '<map-controls></map-controls>';
  button = document.querySelector('#copy-view-link-btn')!;
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
    configurable: true,
    value: function (this: HTMLDialogElement) {
      this.setAttribute('open', '');
    }
  });
});
afterEach(() => {
  document.body.innerHTML = '';
  jest.clearAllTimers();
  jest.useRealTimers();
});

test('the canonical share link includes only public filters, without credentials or precise location', () => {
  localStorage.setItem('token', 'private-account-token');
  state.setPlannedLocation({ lat: 40.412345, lng: -79.923456 }, 'Private home');
  state.updateFilters({
    selectedRouteId: '61A',
    selectedSystems: { prt: true, cmu: true },
    selectedDate: new Date(2026, 8, 21),
    selectedTime: { hour: 8, minute: 30, period: 'AM' },
    selectedDirections: { inbound: false, outbound: true }
  });
  const url = sync.getViewLink(state.getState());
  expect(url).toBe(
    'http://localhost/map#/map?r=61A&d=20260921&t=0830&s=PRT%2CCMU&dir=OB'
  );
  expect(url).not.toMatch(/private|40\.412345|-79\.923456|unexpected|token/i);
});

test('the named Copy view link button copies current state and announces success', async () => {
  const writeText = jest.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText }
  });
  state.updateFilter('selectedRouteId', '61B');
  expect(button.getAttribute('aria-label')).toBe('Copy view link');
  button.click();
  await Promise.resolve();
  await Promise.resolve();
  expect(writeText).toHaveBeenCalledWith('http://localhost/map#/map?r=61B');
  expect(document.querySelector('[role="status"]')!.textContent).toContain(
    'View link copied'
  );
  expect(button.disabled).toBe(false);
});

test.each(['missing', 'denied'] as const)(
  'clipboard %s exposes a selected labeled link and Escape restores focus',
  async (condition) => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value:
        condition === 'missing'
          ? undefined
          : { writeText: jest.fn().mockRejectedValue(new Error('Denied')) }
    });
    const url = sync.getViewLink(state.getState());
    await copyViewLink(url, button, announce);
    const dialog = document.querySelector('dialog')!;
    const input = dialog.querySelector('input')!;
    expect(dialog.getAttribute('aria-labelledby')).toBe('view-link-title');
    expect(input.value).toBe(url);
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe(url.length);
    expect(document.activeElement).toBe(input);
    expect(announce).toHaveBeenCalledWith(
      expect.stringContaining('Copy was unavailable')
    );
    dialog.dispatchEvent(new Event('cancel', { cancelable: true }));
    expect(document.querySelector('dialog')).toBeNull();
    expect(document.activeElement).toBe(button);
  }
);

test('duplicate requests are ignored while clipboard permission is pending', async () => {
  let finish!: () => void;
  const writeText = jest.fn().mockReturnValue(
    new Promise<void>((resolve) => {
      finish = resolve;
    })
  );
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText }
  });
  const first = copyViewLink('http://localhost/map#/map', button, announce);
  await copyViewLink('http://localhost/map#/map', button, announce);
  expect(writeText).toHaveBeenCalledTimes(1);
  finish();
  await first;
  expect(button.disabled).toBe(false);
});

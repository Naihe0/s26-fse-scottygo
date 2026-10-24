/** @jest-environment jsdom */
import {
  dismissMapSelection,
  showMapSelection
} from '../../client/scripts/components/map-selection';
import type { MapHitTarget } from '../../client/scripts/utils/map-hit-test';

describe('crowded map chooser', () => {
  let trigger: HTMLButtonElement;
  const bus: MapHitTarget = {
    selection: {
      id: 'bus',
      kind: 'bus',
      label: 'Bus 61C',
      detail: 'To McKeesport'
    },
    select: jest.fn()
  };
  const stop: MapHitTarget = {
    selection: {
      id: 'stop',
      kind: 'stop',
      label: 'Forbes & Morewood',
      detail: '61B · 61C'
    },
    select: jest.fn()
  };

  beforeEach(() => {
    document.body.innerHTML =
      '<main><button>Map trigger</button></main><aside inert>Already inert</aside>';
    trigger = document.querySelector('button')!;
    trigger.focus();
    jest.clearAllMocks();
  });
  afterEach(() => dismissMapSelection());

  test('opens directly for a single object, with no extra choice', () => {
    showMapSelection([bus]);
    expect(bus.select).toHaveBeenCalledTimes(1);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  test('offers readable groups, focuses a choice and dispatches only the chosen callback', () => {
    showMapSelection([stop, bus]);
    expect(
      [...document.querySelectorAll('h3')].map((heading) => heading.textContent)
    ).toEqual(['Buses', 'Stops']);
    const choices = [
      ...document.querySelectorAll<HTMLButtonElement>('.map-selection__choice')
    ];
    expect(document.activeElement).toBe(choices[0]);
    expect(choices[1].textContent).toContain('Forbes & Morewood');
    expect(choices[1].textContent).toContain('61B · 61C');
    expect(document.querySelector('main')!.hasAttribute('inert')).toBe(true);
    choices[1].click();
    expect(stop.select).toHaveBeenCalledTimes(1);
    expect(bus.select).not.toHaveBeenCalled();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
    expect(document.querySelector('main')!.hasAttribute('inert')).toBe(false);
    expect(document.querySelector('aside')!.hasAttribute('inert')).toBe(true);
  });

  test('Escape closes the chooser and returns keyboard focus', () => {
    showMapSelection([bus, stop]);
    document.activeElement!.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })
    );
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  test('wraps Tab and Shift+Tab inside the dialog', () => {
    showMapSelection([bus, stop]);
    const buttons = [
      ...document.querySelectorAll<HTMLButtonElement>('.map-selection button')
    ];
    buttons.at(-1)!.focus();
    buttons
      .at(-1)!
      .dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Tab', bubbles: true })
      );
    expect(document.activeElement).toBe(buttons[0]);
    buttons[0].dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Tab',
        shiftKey: true,
        bubbles: true
      })
    );
    expect(document.activeElement).toBe(buttons.at(-1));
  });

  test('close and backdrop dismiss without selecting', () => {
    showMapSelection([bus, stop]);
    document.querySelector<HTMLButtonElement>('.map-selection__close')!.click();
    showMapSelection([bus, stop]);
    document.querySelector<HTMLElement>('.map-selection-backdrop')!.click();
    expect(bus.select).not.toHaveBeenCalled();
    expect(stop.select).not.toHaveBeenCalled();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  test('metadata is rendered as text and cannot create markup', () => {
    showMapSelection([
      bus,
      {
        ...stop,
        selection: {
          ...stop.selection,
          label: '<img src=x onerror=alert(1)>',
          detail: '<script>bad()</script>'
        }
      }
    ]);
    expect(document.querySelector('.map-selection img')).toBeNull();
    expect(document.querySelector('.map-selection script')).toBeNull();
    expect(document.querySelector('.map-selection')!.textContent).toContain(
      '<img src=x'
    );
  });

  test('replacing a chooser leaves only one dialog and restores the background', () => {
    showMapSelection([bus, stop]);
    showMapSelection([stop, bus]);
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);
    dismissMapSelection();
    expect(document.querySelector('main')!.hasAttribute('inert')).toBe(false);
  });
});

/** @jest-environment jsdom */
import type { OnboardingTutorial } from '../../client/scripts/components/onboarding-tutorial';
import '../../client/scripts/components/onboarding-tutorial';
import '../../client/scripts/components/map-key';

test('replayed tours count available controls, let riders revisit topics, and close once', () => {
  document.body.innerHTML =
    '<map-key></map-key><button id="route-filter-btn">Route</button><button id="menu-icon">Menu</button><button id="direction-filter-btn" hidden></button><onboarding-tutorial></onboarding-tutorial>';
  const getRects = jest
    .spyOn(HTMLElement.prototype, 'getClientRects')
    .mockImplementation(function (this: HTMLElement) {
      return { length: this.hidden ? 0 : 1 } as DOMRectList;
    });
  const proto = HTMLDialogElement.prototype;
  const show = Object.getOwnPropertyDescriptor(proto, 'showModal');
  const close = Object.getOwnPropertyDescriptor(proto, 'close');
  Object.defineProperty(proto, 'showModal', {
    configurable: true,
    value: function (this: HTMLDialogElement) {
      this.open = true;
    }
  });
  Object.defineProperty(proto, 'close', {
    configurable: true,
    value: function (this: HTMLDialogElement) {
      this.open = false;
    }
  });
  try {
    const tour = document.querySelector<OnboardingTutorial>(
      'onboarding-tutorial'
    )!;
    const completed = jest.fn();
    tour.addEventListener('tutorial-complete', completed);
    document.querySelector<HTMLButtonElement>('.map-key__toggle')!.click();
    document.querySelector<HTMLButtonElement>('.map-key__guide')!.click();
    tour.start();
    expect(tour.querySelectorAll('dialog')).toHaveLength(1);
    const select = tour.querySelector('select')!;
    expect(select.options.length).toBe(2);
    select.value = '1';
    select.dispatchEvent(new Event('change'));
    expect(tour.querySelector('[data-next]')?.textContent).toBe('Finish');
    tour.querySelector<HTMLButtonElement>('[data-back]')!.click();
    expect(tour.querySelector('.tutorial-popup__step')?.textContent).toContain(
      '1 of 2'
    );
    tour
      .querySelector('dialog')!
      .dispatchEvent(new Event('cancel', { cancelable: true }));
    expect(completed).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(
      document.querySelector('.map-key__toggle')
    );
    expect(tour.children).toHaveLength(0);
  } finally {
    getRects.mockRestore();
    if (show) Object.defineProperty(proto, 'showModal', show);
    else Reflect.deleteProperty(proto, 'showModal');
    if (close) Object.defineProperty(proto, 'close', close);
    else Reflect.deleteProperty(proto, 'close');
    document.body.innerHTML = '';
  }
});

export interface IOnboardingTutorialElement extends HTMLElement {
  start(opener?: HTMLElement): void;
}

interface GuideTopic {
  target: string;
  title: string;
  description: string;
}

const topics: GuideTopic[] = [
  {
    target: 'transit-search .search-bar',
    title: 'Find a route or stop',
    description:
      'Search by name, route number or stop ID. Use the Routes and Stops buttons to narrow mixed results.'
  },
  {
    target: '.nearby-stops__launch',
    title: 'Find a place to board',
    description:
      'Nearby stops compares the walk with predicted arrival times. Tap a stop to see its arrivals.'
  },
  {
    target: '#route-filter-btn',
    title: 'Choose a route',
    description: 'Choose a route to see its line, stops and buses on the map.'
  },
  {
    target: '#system-filter-btn',
    title: 'Choose a transit system',
    description:
      'Show Pittsburgh Regional Transit, CMU shuttles or both systems.'
  },
  {
    target: '#direction-filter-btn',
    title: 'Choose a direction',
    description: 'Use the direction filter to show inbound or outbound service.'
  },
  {
    target: '#clear-filters-btn',
    title: 'Reset filters',
    description: 'Clear the current filters to see other routes.'
  },
  {
    target: '.rider-shortcuts__trigger',
    title: 'Reopen a saved stop',
    description:
      'My places holds your saved stops, places and route views for this browser and account.'
  },
  {
    target: '#bell-btn:enabled',
    title: 'Follow route updates',
    description: 'Use the bell to save this route and find its service updates.'
  },
  {
    target: '#menu-icon',
    title: 'Read transit alerts',
    description: 'Open the menu to view Alerts, Saved routes or your account.'
  }
];

type VisibleTopic = GuideTopic & { element: HTMLElement };

export class OnboardingTutorial
  extends HTMLElement
  implements IOnboardingTutorialElement
{
  private steps: VisibleTopic[] = [];
  private index = 0;
  private popup: HTMLDialogElement | null = null;
  private spotlight: HTMLElement | null = null;
  private returnTo: HTMLElement | null = null;

  start(opener?: HTMLElement): void {
    if (this.popup) return;
    this.steps = topics.flatMap((topic) => {
      const element = document.querySelector<HTMLElement>(topic.target);
      if (
        !element ||
        !element.getClientRects().length ||
        getComputedStyle(element).visibility === 'hidden'
      )
        return [];
      return [{ ...topic, element }];
    });
    if (!this.steps.length) return;
    this.index = 0;
    this.returnTo =
      opener ?? document.querySelector<HTMLElement>('.map-key__toggle');
    this.spotlight = document.createElement('div');
    this.spotlight.className = 'tutorial-spotlight';
    this.spotlight.setAttribute('aria-hidden', 'true');
    this.popup = document.createElement('dialog');
    this.popup.className = 'tutorial-popup rider-guide';
    this.popup.setAttribute('aria-labelledby', 'guide-title');
    this.popup.setAttribute('aria-describedby', 'guide-description');
    this.popup.innerHTML = `
      <div class="rider-guide__top"><span class="tutorial-popup__step"></span><button type="button" data-exit>End tour</button></div>
      <h2 id="guide-title" class="tutorial-popup__title" tabindex="-1"></h2>
      <p id="guide-description" class="tutorial-popup__desc"></p>
      <label class="rider-guide__jump">Jump to topic<select></select></label>
      <div class="tutorial-popup__actions"><button type="button" data-back>Back</button><button type="button" data-next>Next</button></div>`;
    this.append(this.spotlight, this.popup);
    const selector = this.popup.querySelector('select')!;
    this.steps.forEach((step, index) =>
      selector.add(new Option(step.title, String(index)))
    );
    selector.addEventListener('change', () =>
      this.show(Number(selector.value))
    );
    this.popup
      .querySelector('[data-back]')!
      .addEventListener('click', () => this.show(this.index - 1));
    this.popup.querySelector('[data-next]')!.addEventListener('click', () => {
      if (this.index === this.steps.length - 1) this.finish();
      else this.show(this.index + 1);
    });
    this.popup
      .querySelector('[data-exit]')!
      .addEventListener('click', () => this.finish());
    this.popup.addEventListener('cancel', (event) => {
      event.preventDefault();
      this.finish();
    });
    this.popup.showModal();
    this.show(0);
    window.addEventListener('resize', this.layout);
    window.visualViewport?.addEventListener('resize', this.layout);
  }

  disconnectedCallback(): void {
    this.cleanup();
  }

  private show(index: number): void {
    const step = this.steps[index];
    if (!step || !this.popup) return;
    this.index = index;
    this.popup.querySelector('.tutorial-popup__step')!.textContent =
      `Map tour · ${index + 1} of ${this.steps.length}`;
    const title = this.popup.querySelector<HTMLElement>('#guide-title')!;
    title.textContent = step.title;
    this.popup.querySelector('#guide-description')!.textContent =
      step.description;
    this.popup.querySelector('select')!.value = String(index);
    this.popup.querySelector<HTMLButtonElement>('[data-back]')!.disabled =
      index === 0;
    this.popup.querySelector('[data-next]')!.textContent =
      index === this.steps.length - 1 ? 'Finish' : 'Next';
    this.layout();
    title.focus({ preventScroll: true });
  }

  private layout = (): void => {
    if (!this.popup || !this.spotlight) return;
    const rect = this.steps[this.index].element.getBoundingClientRect();
    Object.assign(this.spotlight.style, {
      top: `${rect.top - 4}px`,
      left: `${rect.left - 4}px`,
      width: `${rect.width + 8}px`,
      height: `${rect.height + 8}px`
    });
    const card = this.popup.getBoundingClientRect();
    const viewport = window.visualViewport;
    const width = viewport?.width ?? window.innerWidth;
    const height = viewport?.height ?? window.innerHeight;
    const edge = 10;
    const maxX = Math.max(edge, width - card.width - edge);
    const maxY = Math.max(edge, height - card.height - edge);
    const above = rect.top - card.height - edge;
    const below = rect.bottom + edge;
    const top = below <= maxY ? below : above;
    this.popup.style.left = `${Math.min(maxX, Math.max(edge, rect.left + (rect.width - card.width) / 2))}px`;
    this.popup.style.top = `${Math.min(maxY, Math.max(edge, top))}px`;
  };

  private cleanup(): void {
    window.removeEventListener('resize', this.layout);
    window.visualViewport?.removeEventListener('resize', this.layout);
    this.popup?.close();
    this.popup?.remove();
    this.spotlight?.remove();
    this.popup = null;
    this.spotlight = null;
    this.steps = [];
  }

  private finish(): void {
    const opener = this.returnTo;
    this.cleanup();
    this.returnTo = null;
    if (opener?.isConnected) opener.focus({ preventScroll: true });
    this.dispatchEvent(new CustomEvent('tutorial-complete', { bubbles: true }));
  }
}

customElements.define('onboarding-tutorial', OnboardingTutorial);

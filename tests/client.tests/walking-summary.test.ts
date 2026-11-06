/** @jest-environment jsdom */
import { fillWalkingDetails, type WalkingReadingState } from '../../client/scripts/components/walking-summary';
import type { IWalkingSummary } from '../../client/scripts/controllers/directions-controller';

const refreshArrivals = jest.fn();
const viewArrivals = jest.fn();
const setBoardingBuffer = jest.fn();
const actions = { refreshArrivals, viewArrivals, setBoardingBuffer };
const summary = (extra: Partial<IWalkingSummary> = {}): IWalkingSummary => ({
  durationMin: 3, eta: '1:25 PM', arrivalTime: 1_800_000_000_000,
  distanceMeters: 216,
  steps: [
    { instruction: 'Walk along Forbes', distanceMeters: 120 },
    { instruction: 'Cross Craig', distanceMeters: 40 },
    { instruction: 'The platform is on your right', distanceMeters: 56 }
  ],
  predictions: [{ stopId: '7117', routeId: '61A', vid: '3552', predictedArrivalTime: 1_800_000_600_000, minutes: 10, isDelayed: false }],
  predictionKeys: ['visit-one'], missingPredictionKeys: [],
  checkedAt: Date.UTC(2026, 10, 6, 17, 24), predictionsAvailable: true,
  warnings: [], boardingBufferMin: 0,
  origin: { lat: 40.441, lng: -79.944 }, destination: { lat: 40.443, lng: -79.942 },
  ...extra
});
function render(info = summary(), options: { collapsed?: boolean; stepsOpen?: boolean; state?: WalkingReadingState } = {}): HTMLElement {
  document.body.innerHTML = '<section id="panel"><div class="directions-panel__info"><span class="directions-panel__distance"></span></div></section>';
  const panel = document.getElementById('panel')!;
  const arrival = document.createElement('li');
  arrival.textContent = 'Route 61A · 10 min';
  fillWalkingDetails(panel, info, '7117', [arrival], options.collapsed ?? false, options.stepsOpen ?? false, actions, options.state);
  return panel;
}
function click(action: string): void {
  document.querySelector<HTMLButtonElement>(`[data-walk-action="${action}"]`)!.click();
}
function state(panel: HTMLElement): WalkingReadingState {
  return { stepIndex: Number(panel.dataset.walkStepIndex), focusedSteps: panel.dataset.focusedSteps === 'true', stepsSignature: panel.dataset.stepsSignature,
    optionsOpen: panel.querySelector<HTMLDetailsElement>('[data-walk-options]')?.open };
}

beforeEach(() => jest.clearAllMocks());

test('selected departures show a Pittsburgh check time and one explicit refresh', () => {
  render();
  expect(document.querySelector('.directions-panel__freshness')?.textContent).toContain('12:24');
  expect(document.querySelector('.directions-panel__freshness')?.textContent).toContain('ET');
  click('refresh-arrivals');
  expect(refreshArrivals).toHaveBeenCalledTimes(1);
  render(summary({ updatingPredictions: true }));
  const refresh = document.querySelector<HTMLButtonElement>('[data-walk-action="refresh-arrivals"]')!;
  expect(refresh.getAttribute('aria-disabled')).toBe('true');
  refresh.focus();
  expect(document.activeElement).toBe(refresh);
  click('refresh-arrivals');
  expect(refreshArrivals).toHaveBeenCalledTimes(1);
});

test('paused and missing departures stay explicit without a false current check claim', () => {
  render(summary({ predictionsAvailable: false, missingPredictionKeys: ['visit-one'] }));
  expect(document.querySelector('.directions-panel__freshness')?.textContent).toContain('Updates paused');
  expect(document.querySelector('.directions-panel__freshness')?.textContent).toContain('1 no longer reported');
  expect(document.querySelector('.directions-panel__bus-list')?.textContent).toContain('61A');
  render(summary({ checkedAt: null, predictionsAvailable: false }));
  expect(document.querySelector('.directions-panel__freshness')?.textContent).toBe('Updates paused');
});

test('View arrivals remains directly available with walking details collapsed', () => {
  render(summary(), { collapsed: true });
  expect(document.querySelector<HTMLElement>('.directions-panel__body')!.hidden).toBe(true);
  const handoff = document.querySelector<HTMLButtonElement>('[data-walk-action="arrivals"]')!;
  expect(handoff.closest('.directions-panel__body')).toBeNull();
  handoff.click();
  expect(viewArrivals).toHaveBeenCalledTimes(1);
  click('compact');
  expect(document.querySelector<HTMLElement>('.directions-panel__body')!.hidden).toBe(false);
});

test('a failed walking refresh labels its retained estimate even when details are collapsed', () => {
  render(summary({ walkCurrent: false }), { collapsed: true });
  const warning = document.querySelector('.directions-panel__route-status')!;
  expect(warning.textContent).toBe('Last-known walking estimate');
  expect(warning.closest('.directions-panel__body')).toBeNull();
  expect(document.querySelector('.directions-panel__eta')?.textContent).toContain('Last-known arrival');
});

test('full steps stay the default and manual focus advances only on rider action', () => {
  const panel = render(summary(), { stepsOpen: true });
  expect(document.querySelector<HTMLOListElement>('ol')!.hidden).toBe(false);
  click('step-mode');
  expect(panel.dataset.walkStepIndex).toBe('0');
  expect(document.querySelector<HTMLButtonElement>('[data-walk-action="previous-step"]')!.disabled).toBe(true);
  click('next-step');
  expect(panel.dataset.walkStepIndex).toBe('1');
  expect(document.querySelector('.directions-panel__step-instruction')?.textContent).toBe('Cross Craig');
  expect(document.activeElement).toBe(document.querySelector('.directions-panel__step-instruction'));
  click('next-step');
  expect(document.querySelector<HTMLButtonElement>('[data-walk-action="next-step"]')!.disabled).toBe(true);
  click('previous-step');
  expect(panel.dataset.walkStepIndex).toBe('1');
  click('step-mode');
  expect(document.querySelector<HTMLOListElement>('ol')!.hidden).toBe(false);
});

test('same route updates preserve manual reading while changed steps restart at step one', () => {
  const panel = render(summary(), { stepsOpen: true });
  click('step-mode');
  click('next-step');
  const saved = state(panel);
  const refreshed = render(summary({ durationMin: 2 }), { stepsOpen: true, state: saved });
  expect(refreshed.dataset.walkStepIndex).toBe('1');
  expect(refreshed.dataset.focusedSteps).toBe('true');
  const rerouted = render(summary({ steps: [{ instruction: 'Use the opposite crossing', distanceMeters: 35 }] }), { stepsOpen: true, state: saved });
  expect(rerouted.dataset.walkStepIndex).toBe('0');
  expect(rerouted.textContent).toContain('Route updated. Start with step 1.');
  expect(document.querySelector('.directions-panel__step-instruction')?.textContent).toBe('Use the opposite crossing');
});

test('boarding buffer is disclosed, selects only supported values and survives a rerender', () => {
  const panel = render();
  const options = panel.querySelector<HTMLDetailsElement>('[data-walk-options]')!;
  expect(options.open).toBe(false);
  options.open = true;
  const select = panel.querySelector<HTMLSelectElement>('[data-walk-action="buffer"]')!;
  select.value = '5';
  select.dispatchEvent(new Event('change'));
  expect(setBoardingBuffer).toHaveBeenCalledWith(5);
  render(summary({ boardingBufferMin: 5 }), { state: state(panel) });
  expect(document.querySelector<HTMLDetailsElement>('[data-walk-options]')!.open).toBe(true);
  expect(document.querySelector<HTMLSelectElement>('[data-walk-action="buffer"]')!.value).toBe('5');
  render(summary({ predictions: [], predictionKeys: [] }));
  expect(document.querySelector('[data-walk-action="buffer"]')).toBeNull();
  expect(document.querySelector('.directions-panel__map-apps')).not.toBeNull();
});

test('external walking links use the platform and let device Maps choose GPS origin', () => {
  render();
  const google = new URL(document.querySelector<HTMLAnchorElement>('[data-walk-action="google-maps"]')!.href);
  const apple = document.querySelector<HTMLAnchorElement>('[data-walk-action="apple-maps"]')!;
  expect(google.searchParams.get('destination')).toBe('40.443,-79.942');
  expect(google.searchParams.get('travelmode')).toBe('walking');
  expect(google.searchParams.has('origin')).toBe(false);
  expect(apple.target).toBe('_blank');
  expect(apple.rel).toContain('noopener');
});

test('planned-origin label and both map apps retain the chosen starting point', () => {
  render(summary({ plannedOrigin: true }));
  expect(document.querySelector('.directions-panel__origin')?.textContent).toBe('From planned starting point');
  const google = new URL(document.querySelector<HTMLAnchorElement>('[data-walk-action="google-maps"]')!.href);
  const apple = new URL(document.querySelector<HTMLAnchorElement>('[data-walk-action="apple-maps"]')!.href);
  expect(google.searchParams.get('origin')).toBe('40.441,-79.944');
  expect(apple.searchParams.get('source')).toBe('40.441,-79.944');
});

test('invalid destinations and missing planned coordinates omit unsafe or misleading map links', () => {
  render(summary({ destination: { lat: NaN, lng: 0 } }));
  expect(document.querySelector('.directions-panel__map-apps')).toBeNull();
  render(summary({ plannedOrigin: true, origin: undefined }));
  expect(document.querySelector('.directions-panel__map-apps')).toBeNull();
});

test('no-step results remain usable and instructions render as text', () => {
  render(summary({ steps: [] }));
  expect(document.querySelector('[data-walk-steps]')).toBeNull();
  click('arrivals');
  expect(viewArrivals).toHaveBeenCalledTimes(1);
  render(summary({ steps: [{ instruction: '<img src=x onerror=alert(1)>' }] }));
  click('step-mode');
  expect(document.querySelector('img')).toBeNull();
  expect(document.querySelector('.directions-panel__step-instruction')?.textContent).toContain('<img');
});

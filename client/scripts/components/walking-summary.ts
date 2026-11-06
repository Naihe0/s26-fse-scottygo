import type { IWalkingSummary } from '../controllers/directions-controller';
import { walkingMapLinks } from '../utils/walking-departures';

export interface WalkingActions {
  refreshArrivals(): void;
  viewArrivals(): void;
  setBoardingBuffer(value: 0 | 2 | 5): void;
}

export interface WalkingReadingState {
  stepIndex: number;
  focusedSteps: boolean;
  stepsSignature?: string;
  optionsOpen?: boolean;
}

function walkingDistance(meters: number): string {
  return meters < 1000 ? `${Math.round(meters)} m` : `${(meters / 1000).toFixed(1)} km`;
}

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(label: string, action: string, callback: () => void): HTMLButtonElement {
  const node = element('button', 'directions-panel__action', label);
  node.type = 'button';
  node.dataset.walkAction = action;
  node.addEventListener('click', callback);
  return node;
}

function stepSignature(info: IWalkingSummary): string {
  let hash = 2166136261;
  for (const char of JSON.stringify(info.steps)) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return (hash >>> 0).toString(36);
}

function appendSteps(body: HTMLElement, panel: HTMLElement, info: IWalkingSummary, readingSteps: boolean, state?: WalkingReadingState): void {
  const signature = stepSignature(info);
  const rerouted = Boolean(state?.stepsSignature && state.stepsSignature !== signature);
  let index = rerouted ? 0 : Math.max(0, Math.min(info.steps.length - 1, Math.floor(state?.stepIndex ?? 0)));
  if (!Number.isFinite(index)) index = 0;
  let focused = Boolean(state?.focusedSteps);
  panel.dataset.stepsSignature = signature;
  const steps = element('details', 'directions-panel__steps');
  steps.dataset.walkSteps = '';
  steps.open = Boolean(readingSteps);
  const heading = element('summary', '', `Walking steps (${info.steps.length})`);
  heading.dataset.walkAction = 'steps';
  const list = document.createElement('ol');
  for (const step of info.steps) {
    const row = element('li', '', step.instruction);
    if (step.distanceMeters !== undefined) row.append(' ', element('small', '', walkingDistance(step.distanceMeters)));
    list.append(row);
  }
  const reader = element('div', 'directions-panel__step-reader');
  const progress = element('p', 'directions-panel__step-progress');
  const instruction = element('p', 'directions-panel__step-instruction');
  instruction.tabIndex = -1;
  instruction.dataset.walkAction = 'current-step';
  const distance = element('p', 'directions-panel__step-distance');
  const navigation = element('div', 'directions-panel__step-navigation');
  const previous = button('Previous', 'previous-step', () => { index--; update(true); });
  const next = button('Next', 'next-step', () => { index++; update(true); });
  navigation.append(previous, next);
  reader.append(progress, instruction, distance, navigation, element('p', 'directions-panel__step-help', 'Choose steps manually as you walk.'));
  const mode = button('One step at a time', 'step-mode', () => { focused = !focused; update(false); });
  mode.setAttribute('aria-controls', 'walking-step-reader');
  reader.id = 'walking-step-reader';
  function update(announce: boolean): void {
    panel.dataset.walkStepIndex = String(index);
    panel.dataset.focusedSteps = String(focused);
    list.hidden = focused;
    reader.hidden = !focused;
    mode.textContent = focused ? 'Show all steps' : 'One step at a time';
    mode.setAttribute('aria-expanded', String(focused));
    progress.textContent = `Step ${index + 1} of ${info.steps.length}`;
    instruction.textContent = info.steps[index].instruction;
    const meters = info.steps[index].distanceMeters;
    distance.textContent = meters === undefined ? '' : walkingDistance(meters);
    distance.hidden = meters === undefined;
    previous.disabled = index === 0;
    next.disabled = index === info.steps.length - 1;
    if (announce) {
      instruction.setAttribute('aria-label', `${progress.textContent}. ${instruction.textContent}`);
      instruction.focus({ preventScroll: true });
    }
  }
  update(false);
  steps.append(heading, mode, list, reader);
  if (rerouted && focused) steps.append(element('p', 'directions-panel__step-help', 'Route updated. Start with step 1.'));
  body.append(steps);
}

export function fillWalkingDetails(
  panel: HTMLElement,
  info: IWalkingSummary,
  stopId: string,
  arrivals: HTMLLIElement[],
  collapsed: boolean,
  readingSteps: boolean,
  actions?: WalkingActions,
  readingState?: WalkingReadingState
): void {
  panel.querySelector('.directions-panel__distance')!.textContent = walkingDistance(info.distanceMeters);
  const body = element('div', 'directions-panel__body');
  body.id = 'walk-details';
  body.append(element('p', 'directions-panel__eta', info.walkCurrent === false
    ? `Last-known arrival at stop ${stopId}: ${info.eta} ET`
    : `Arrive at stop ${stopId} around ${info.eta} ET`));
  if (info.plannedOrigin) body.append(element('p', 'directions-panel__origin', 'From planned starting point'));
  if (info.steps.length) appendSteps(body, panel, info, readingSteps, readingState);
  if (info.predictions.length > 0 || info.predictionKeys?.length) {
    const buses = element('div', 'directions-panel__buses');
    const header = element('div', 'directions-panel__departures-header');
    header.append(element('span', 'directions-panel__buses-label', 'Selected departures'));
    if (actions) {
      const refresh = button(info.updatingPredictions ? 'Refreshing…' : 'Refresh arrivals', 'refresh-arrivals', () => {
        if (!info.updatingPredictions) actions.refreshArrivals();
      });
      refresh.setAttribute('aria-disabled', String(Boolean(info.updatingPredictions)));
      header.append(refresh);
    }
    const status = element('p', 'directions-panel__freshness');
    status.dataset.walkFreshness = info.updatingPredictions ? 'updating' : info.predictionsAvailable ? 'current' : 'paused';
    const checked = typeof info.checkedAt === 'number' && Number.isFinite(info.checkedAt) && info.checkedAt > 0
      ? new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' }).format(info.checkedAt) + ' ET' : null;
    status.textContent = info.updatingPredictions ? 'Checking selected departures…'
      : !info.predictionsAvailable ? `Updates paused${checked ? ` · Last checked ${checked}` : ''}`
        : checked ? `Checked ${checked}` : 'Waiting for an arrival check';
    if (info.missingPredictionKeys?.length) status.textContent += ` · ${info.missingPredictionKeys.length} no longer reported`;
    const list = element('ul', 'directions-panel__bus-list');
    list.append(...arrivals);
    buses.append(header, status, list);
    body.append(buses);
  }
  const links = info.destination && (!info.plannedOrigin || info.origin)
    ? walkingMapLinks(info.destination, info.plannedOrigin ? info.origin : undefined) : null;
  if ((actions && info.predictions.length > 0) || links) {
    const options = element('details', 'directions-panel__options');
    options.dataset.walkOptions = '';
    options.open = Boolean(readingState?.optionsOpen);
    const summary = element('summary', '', 'Walking options');
    summary.dataset.walkAction = 'options';
    options.append(summary);
    if (actions && info.predictions.length > 0) {
      const label = element('label', 'directions-panel__buffer-label', 'Boarding buffer');
      const select = document.createElement('select');
      select.dataset.walkAction = 'buffer';
      select.setAttribute('aria-label', 'Boarding buffer');
      for (const value of [0, 2, 5]) select.append(new Option(value === 0 ? 'No extra time' : `${value} minutes`, String(value)));
      select.value = String(info.boardingBufferMin ?? 0);
      select.addEventListener('change', () => {
        const value = Number(select.value);
        if (value === 0 || value === 2 || value === 5) actions.setBoardingBuffer(value);
      });
      label.append(select);
      options.append(label, element('p', 'directions-panel__step-help', 'Allow extra time at the stop before the departure estimate.'));
    }
    if (links) {
      const apps = element('div', 'directions-panel__map-apps');
      for (const [label, href, action] of [['Apple Maps', links.apple, 'apple-maps'], ['Google Maps', links.google, 'google-maps']]) {
        const link = element('a', 'directions-panel__action', label);
        link.href = href;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.dataset.walkAction = action;
        link.setAttribute('aria-label', `Open walking directions in ${label}`);
        apps.append(link);
      }
      options.append(apps);
    }
    body.append(options);
  }
  panel.append(body);
  if (actions) {
    const footer = element('div', 'directions-panel__handoff');
    footer.append(button('View arrivals', 'arrivals', actions.viewArrivals));
    panel.append(footer);
  }
  const toggle = button('Hide details', 'compact', () => setCompact(!body.hidden));
  toggle.className = 'directions-panel__compact';
  toggle.setAttribute('aria-controls', body.id);
  function setCompact(compact: boolean): void {
    body.hidden = compact;
    panel.dataset.compact = String(compact);
    toggle.textContent = compact ? 'Show details' : 'Hide details';
    toggle.setAttribute('aria-expanded', String(!compact));
  }
  setCompact(Boolean(collapsed));
  panel.querySelector('.directions-panel__info')!.append(toggle);
  if (info.walkCurrent === false) panel.querySelector('.directions-panel__info')!.append(
    element('span', 'directions-panel__route-status', 'Last-known walking estimate')
  );
  for (const warning of info.warnings) panel.append(element('p', 'directions-panel__warning', warning));
}

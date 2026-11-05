import type { IWalkingSummary } from '../controllers/directions-controller';

function walkingDistance(meters: number): string {
  return meters < 1000
    ? `${Math.round(meters)} m`
    : `${(meters / 1000).toFixed(1)} km`;
}

export function fillWalkingDetails(
  panel: HTMLElement,
  info: IWalkingSummary,
  stopId: string,
  arrivals: HTMLLIElement[],
  collapsed: boolean,
  readingSteps: boolean
): void {
  panel.querySelector('.directions-panel__distance')!.textContent =
    walkingDistance(info.distanceMeters);
  const body = document.createElement('div');
  body.className = 'directions-panel__body';
  body.id = 'walk-details';
  const eta = document.createElement('p');
  eta.className = 'directions-panel__eta';
  eta.textContent = `Arrive at stop ${stopId} around ${info.eta} ET`;
  body.append(eta);
  if (info.steps.length) {
    const steps = document.createElement('details');
    steps.open = Boolean(readingSteps);
    const heading = document.createElement('summary');
    heading.dataset.walkAction = 'steps';
    heading.textContent = `Walking steps (${info.steps.length})`;
    const list = document.createElement('ol');
    for (const step of info.steps) {
      const row = document.createElement('li');
      row.textContent = step.instruction;
      if (step.distanceMeters !== undefined) {
        const distance = document.createElement('small');
        distance.textContent = walkingDistance(step.distanceMeters);
        row.append(' ', distance);
      }
      list.append(row);
    }
    steps.append(heading, list);
    body.append(steps);
  }
  if (info.predictions.length > 0) {
    const buses = document.createElement('div');
    buses.className = 'directions-panel__buses';
    buses.innerHTML =
      '<span class="directions-panel__buses-label">Selected departures</span>' +
      '<ul class="directions-panel__bus-list"></ul>';
    buses.querySelector('ul')!.append(...arrivals);
    body.appendChild(buses);
  }
  panel.append(body);
  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'directions-panel__compact';
  toggle.dataset.walkAction = 'compact';
  toggle.setAttribute('aria-controls', body.id);
  function setCompact(compact: boolean): void {
    body.hidden = compact;
    panel.dataset.compact = String(compact);
    toggle.textContent = compact ? 'Show details' : 'Hide details';
    toggle.setAttribute('aria-expanded', String(!compact));
  }
  setCompact(Boolean(collapsed));
  toggle.addEventListener('click', () => setCompact(!body.hidden));
  panel.querySelector('.directions-panel__info')!.append(toggle);
  for (const warning of info.warnings) {
    const text = document.createElement('p');
    text.className = 'directions-panel__warning';
    text.textContent = warning;
    panel.appendChild(text);
  }
}

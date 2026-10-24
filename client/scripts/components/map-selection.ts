import type { MapHitTarget } from '../utils/map-hit-test';

let dismissActive: ((restoreFocus: boolean) => void) | null = null;
const GROUPS = [
  { kind: 'bus', title: 'Buses', icon: 'directions_bus' },
  { kind: 'stop', title: 'Stops', icon: 'trip_origin' },
  { kind: 'route', title: 'Routes', icon: 'route' }
] as const;

export function dismissMapSelection(): void {
  dismissActive?.(true);
}

/** One keyboard-accessible chooser for a crowded point on the map. */
export function showMapSelection(candidates: readonly MapHitTarget[]): void {
  dismissActive?.(true);
  if (candidates.length === 0) return;
  if (candidates.length === 1) {
    candidates[0].select();
    return;
  }
  const previousFocus = document.activeElement as HTMLElement | null;
  const overlay = document.createElement('div');
  overlay.className = 'map-selection-backdrop';
  const dialog = document.createElement('section');
  dialog.className = 'map-selection';
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  dialog.setAttribute('aria-labelledby', 'map-selection-title');
  dialog.innerHTML =
    '<header class="map-selection__header"><div><h2 id="map-selection-title">Choose on map</h2><p>Several items are close together.</p></div><button type="button" class="map-selection__close" aria-label="Close map choices"><span aria-hidden="true">×</span></button></header><div class="map-selection__items"></div>';
  const closeButton = dialog.querySelector<HTMLButtonElement>(
    '.map-selection__close'
  )!;
  const items = dialog.querySelector<HTMLElement>('.map-selection__items')!;
  const background = Array.from(document.body.children).filter(
    (element) => !element.hasAttribute('inert')
  );
  background.forEach((element) => element.setAttribute('inert', ''));
  const dismiss = (restoreFocus: boolean) => {
    overlay.remove();
    background.forEach((element) => element.removeAttribute('inert'));
    if (dismissActive === dismiss) dismissActive = null;
    if (restoreFocus && previousFocus?.isConnected) previousFocus.focus();
  };
  dismissActive = dismiss;
  for (const group of GROUPS) {
    const groupCandidates = candidates.filter(
      (candidate) => candidate.selection.kind === group.kind
    );
    if (!groupCandidates.length) continue;
    const section = document.createElement('section');
    const heading = document.createElement('h3');
    heading.textContent = group.title;
    section.append(heading);
    for (const candidate of groupCandidates) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'map-selection__choice';
      const icon = document.createElement('span');
      icon.className = 'material-icons-outlined map-selection__icon';
      icon.setAttribute('aria-hidden', 'true');
      icon.textContent = group.icon;
      const text = document.createElement('span');
      text.className = 'map-selection__label';
      const label = document.createElement('strong');
      label.textContent = candidate.selection.label;
      text.append(label);
      if (candidate.selection.detail) {
        const detail = document.createElement('span');
        detail.textContent = candidate.selection.detail;
        text.append(detail);
      }
      button.append(icon, text);
      button.addEventListener('click', () => {
        dismiss(true);
        candidate.select();
      });
      section.append(button);
    }
    items.append(section);
  }
  closeButton.addEventListener('click', () => dismiss(true));
  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) dismiss(true);
  });
  dialog.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      dismiss(true);
      return;
    }
    const buttons = [...dialog.querySelectorAll<HTMLButtonElement>('button')];
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === 'Tab') {
      if (event.shiftKey && index <= 0) {
        event.preventDefault();
        buttons.at(-1)!.focus();
      } else if (!event.shiftKey && index === buttons.length - 1) {
        event.preventDefault();
        buttons[0].focus();
      }
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      buttons[
        (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) %
          buttons.length
      ].focus();
    }
  });
  overlay.append(dialog);
  document.body.append(overlay);
  items.querySelector<HTMLButtonElement>('button')?.focus();
}

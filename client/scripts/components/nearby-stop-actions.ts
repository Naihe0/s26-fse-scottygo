import type { ILatLng } from '../../../common/map.interface';
import type { IStop } from '../../../common/transit.interface';
import { isStopSaved, toggleSavedStop } from '../utils/rider-shortcuts';

/** A separate action so saving never opens the stop or resets the list. */
export function nearbySaveButton(stop: IStop): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'nearby-stop-save';
  button.setAttribute(
    'aria-label',
    'Save stop ' + stop.stopName + ' (#' + stop.stopId + ')'
  );
  const sync = (saved: boolean): void => {
    button.textContent = saved ? 'Saved' : 'Save';
    button.setAttribute('aria-pressed', String(saved));
  };
  sync(isStopSaved(stop.stopId));
  button.addEventListener('click', (event) => {
    event.stopPropagation();
    const result = toggleSavedStop(stop);
    sync(result.saved);
    const box = button.closest('dialog') ?? button.parentElement;
    if (!box) return;
    let status = box.querySelector<HTMLElement>('[data-save-feedback]');
    if (!status && !result.ok) {
      status = document.createElement('p');
      status.dataset.saveFeedback = '';
      status.setAttribute('role', 'status');
      button.after(status);
    }
    if (status) status.textContent = result.ok ? '' : result.message;
  });
  return button;
}

/** Direction from the search origin to a platform, never a walking instruction. */
export function nearbyBearing(
  origin: ILatLng,
  stop: IStop,
  distanceMeters: number
): string {
  if (
    !Number.isFinite(distanceMeters) ||
    distanceMeters < 30 ||
    ![origin.lat, origin.lng, stop.lat, stop.lon].every(Number.isFinite) ||
    Math.abs(origin.lat) > 90 ||
    Math.abs(stop.lat) > 90 ||
    Math.abs(origin.lng) > 180 ||
    Math.abs(stop.lon) > 180 ||
    (origin.lat === stop.lat && origin.lng === stop.lon)
  )
    return '';
  const rad = Math.PI / 180;
  const from = origin.lat * rad,
    to = stop.lat * rad,
    dl = (stop.lon - origin.lng) * rad;
  const angle = Math.atan2(
    Math.sin(dl) * Math.cos(to),
    Math.cos(from) * Math.sin(to) - Math.sin(from) * Math.cos(to) * Math.cos(dl)
  );
  return ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][
    (Math.round(angle / (Math.PI / 4)) + 8) % 8
  ];
}

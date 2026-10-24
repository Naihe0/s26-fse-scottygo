import { copyViewLink } from './copy-view-link';
import { validShortcutStopId } from './rider-shortcuts';

/** A stop link contains only a public stop ID, never the rider's location or filters. */
export function buildStopLink(
  stopId: string,
  base = window.location.href
): string | null {
  if (!validShortcutStopId(stopId)) return null;
  try {
    const url = new URL(base);
    if (!['https:', 'http:'].includes(url.protocol)) return null;
    url.pathname = '/';
    url.search = '';
    url.hash = `/map?stop=${encodeURIComponent(stopId)}`;
    url.username = '';
    url.password = '';
    return url.href;
  } catch {
    return null;
  }
}

export function parseStopLink(hash = window.location.hash): string | null {
  if (!hash.startsWith('#/map?') || hash.length > 2048) return null;
  const params = new URLSearchParams(hash.slice(6));
  const values = params.getAll('stop');
  return values.length === 1 && validShortcutStopId(values[0])
    ? values[0]
    : null;
}

export async function copyStopLink(
  stopId: string,
  trigger: HTMLButtonElement,
  announce: (message: string) => void
): Promise<void> {
  if (trigger.disabled) return;
  const link = buildStopLink(stopId);
  if (!link) {
    announce('This stop cannot be shared yet.');
    return;
  }
  await copyViewLink(link, trigger, (message) => {
    if (message.startsWith('View link copied'))
      announce('Stop link copied. Your location is not included.');
    else announce(message);
  });
  // Reuse the established clipboard fallback with stop-specific instructions.
  const dialog = document.getElementById('copy-view-link-dialog');
  if (dialog) {
    const title = dialog.querySelector('h2');
    const description = dialog.querySelector('p');
    const label = dialog.querySelector('label');
    if (title) title.textContent = 'Copy stop link';
    if (description)
      description.textContent =
        'Share this stop. Your location and account information are not included.';
    if (label) label.textContent = 'Stop link';
  }
}

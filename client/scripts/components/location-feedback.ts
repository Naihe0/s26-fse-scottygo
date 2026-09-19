import type { LocationFailure } from '../services/geolocation-controller';

interface LocationFeedback {
  card: HTMLElement;
  title: HTMLElement;
  message: HTMLElement;
  fallback: HTMLElement;
  help: HTMLDetailsElement;
  retry: HTMLButtonElement;
  dismiss: HTMLButtonElement;
  onRetry: () => void;
}

let feedback: LocationFeedback | null = null;

function failureCopy(kind: LocationFailure): [string, string] {
  switch (kind) {
    case 'denied':
      return [
        'Location access is blocked',
        'Your browser or device is not allowing this site to use your location. Check location settings, then try again.'
      ];
    case 'timeout':
      return [
        'Finding your location took too long',
        'A location was not available in time. Try again; your device may need more time to find you.'
      ];
    case 'unsupported':
      return [
        'Location is not supported here',
        'This browser cannot provide your location. Open ScottyGo in a browser with location support.'
      ];
    default:
      return [
        'Your location is temporarily unavailable',
        'Your device could not determine your location. Check your connection and try again.'
      ];
  }
}

function createFeedback(container: Element): LocationFeedback {
  const card = document.createElement('section');
  card.id = 'location-feedback';
  card.className = 'location-feedback';
  card.setAttribute('aria-labelledby', 'location-feedback-title');

  const status = document.createElement('div');
  status.className = 'location-feedback__status';
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  status.setAttribute('aria-atomic', 'true');
  const title = document.createElement('h2');
  title.id = 'location-feedback-title';
  const message = document.createElement('p');
  status.append(title, message);

  const dismiss = document.createElement('button');
  dismiss.type = 'button';
  dismiss.className = 'location-feedback__dismiss';
  dismiss.setAttribute('aria-label', 'Dismiss location message');
  dismiss.textContent = '×';

  const fallback = document.createElement('p');
  fallback.className = 'location-feedback__fallback';

  const help = document.createElement('details');
  help.className = 'location-feedback__help';
  const summary = document.createElement('summary');
  summary.textContent = 'Location settings help';
  const instructions = document.createElement('ol');
  for (const text of [
    'On iPhone, open Settings → Privacy & Security → Location Services and make sure Location Services is on.',
    'In Location Services, select Safari Websites and allow access while using the app.',
    'In Safari, open this site’s Page Menu → Website Settings → Location and choose Allow. If it already says Allow, check the device settings above.',
    'Return to ScottyGo and choose Try again. In other browsers, check this site’s location permission and your device’s location settings.'
  ]) {
    const step = document.createElement('li');
    step.textContent = text;
    instructions.append(step);
  }
  help.append(summary, instructions);

  const retry = document.createElement('button');
  retry.type = 'button';
  retry.className = 'location-feedback__retry';
  retry.textContent = 'Try again';

  const entry: LocationFeedback = {
    card,
    title,
    message,
    fallback,
    help,
    retry,
    dismiss,
    onRetry: () => {}
  };
  dismiss.addEventListener('click', () => {
    if (feedback === entry) clearLocationFeedback();
  });
  retry.addEventListener('click', () => {
    if (feedback !== entry || retry.hidden) return;
    const onRetry = entry.onRetry;
    clearLocationFeedback();
    // Keep this synchronous so browser permission requests retain the gesture.
    onRetry();
  });
  card.append(status, dismiss, fallback, help, retry);
  container.append(card);
  return entry;
}

/** Nonmodal feedback: the map stays available while location recovers. */
export function showLocationFeedback(
  kind: LocationFailure,
  onRetry: () => void,
  hasLastKnown = false
): void {
  const container = document.querySelector('.map-container');
  if (!container) return;
  if (!feedback?.card.isConnected) feedback = createFeedback(container);
  const entry = feedback;
  entry.onRetry = onRetry;

  const [title, message] = failureCopy(kind);
  if (entry.title.textContent !== title) entry.title.textContent = title;
  if (entry.message.textContent !== message)
    entry.message.textContent = message;
  entry.fallback.textContent = hasLastKnown
    ? 'Showing your last known location.'
    : 'You can still browse routes or choose a starting point.';

  const focusInHelp = entry.help.contains(document.activeElement);
  const focusOnRetry = document.activeElement === entry.retry;
  entry.help.hidden = kind !== 'denied';
  entry.retry.hidden = kind === 'unsupported';
  if (entry.help.hidden) entry.help.open = false;
  if (
    (focusInHelp && entry.help.hidden) ||
    (focusOnRetry && entry.retry.hidden)
  )
    (entry.retry.hidden ? entry.dismiss : entry.retry).focus({
      preventScroll: true
    });
}

export function clearLocationFeedback(): void {
  const entry = feedback;
  if (!entry) return;
  const restoreFocus = entry.card.contains(document.activeElement);
  // Release ownership before focusing: a focus handler may show fresh feedback.
  feedback = null;
  entry.card.remove();
  if (restoreFocus)
    document
      .querySelector<HTMLElement>('#recenter-btn')
      ?.focus({ preventScroll: true });
}

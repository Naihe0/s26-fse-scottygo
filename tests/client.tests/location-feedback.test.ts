/** @jest-environment jsdom */
import {
  clearLocationFeedback,
  showLocationFeedback
} from '../../client/scripts/components/location-feedback';
import type { LocationFailure } from '../../client/scripts/services/geolocation-controller';

const card = () => document.querySelector<HTMLElement>('#location-feedback');
const retry = () =>
  document.querySelector<HTMLButtonElement>('.location-feedback__retry')!;
const dismiss = () =>
  document.querySelector<HTMLButtonElement>('.location-feedback__dismiss')!;
const help = () =>
  document.querySelector<HTMLDetailsElement>('.location-feedback__help')!;

beforeEach(() => {
  document.body.innerHTML =
    '<main class="map-container"><button id="recenter-btn">My location</button></main><button id="elsewhere">Other action</button>';
});

afterEach(() => {
  clearLocationFeedback();
  jest.restoreAllMocks();
});

test.each<[LocationFailure, string]>([
  ['denied', 'Location access is blocked'],
  ['unavailable', 'Your location is temporarily unavailable'],
  ['timeout', 'Finding your location took too long'],
  ['unsupported', 'Location is not supported here']
])('explains %s with a distinct polite message', (kind, title) => {
  showLocationFeedback(kind, jest.fn());
  expect(card()?.parentElement?.className).toBe('map-container');
  expect(card()?.querySelector('h2')?.textContent).toBe(title);
  expect(card()?.getAttribute('role')).not.toBe('alert');
  const status = card()?.querySelector('[role="status"]');
  expect(status?.getAttribute('aria-live')).toBe('polite');
  expect(status?.getAttribute('aria-atomic')).toBe('true');
  expect(status?.querySelector('button, details')).toBeNull();
  expect(card()?.textContent).toContain(
    'You can still browse routes or choose a starting point.'
  );
  if (kind === 'timeout') {
    expect(status?.textContent).not.toMatch(/denied|blocked|permission/i);
    expect(help().hidden).toBe(true);
  }
});

test('shows recovery guidance only for denied access and keeps it collapsed', () => {
  showLocationFeedback('denied', jest.fn());
  expect(help().hidden).toBe(false);
  expect(help().open).toBe(false);
  expect(help().querySelector('summary')?.textContent).toBe(
    'Location settings help'
  );
  expect(help().textContent).toContain('Safari Websites');
  expect(help().textContent).toContain('Website Settings → Location');
  expect(help().textContent).toContain('If it already says Allow');
  help().open = true;
  showLocationFeedback('timeout', jest.fn());
  expect(help().hidden).toBe(true);
  expect(help().open).toBe(false);
});

test('retry removes the card before invoking the callback synchronously', () => {
  const onRetry = jest.fn(() => expect(card()).toBeNull());
  showLocationFeedback('timeout', onRetry);
  retry().focus();
  retry().click();
  expect(onRetry).toHaveBeenCalledTimes(1);
  expect(document.activeElement?.id).toBe('recenter-btn');
});

test('dismiss restores focus without starting a retry or removing other UI', () => {
  const onRetry = jest.fn();
  showLocationFeedback('denied', onRetry);
  const unrelated = document.createElement('div');
  unrelated.id = 'unrelated';
  document.querySelector('.map-container')!.append(unrelated);
  expect(dismiss().getAttribute('aria-label')).toBe('Dismiss location message');
  dismiss().focus();
  dismiss().click();
  expect(card()).toBeNull();
  expect(document.activeElement?.id).toBe('recenter-btn');
  expect(onRetry).not.toHaveBeenCalled();
  expect(unrelated.isConnected).toBe(true);
});

test('repeated failures reuse one card, keep focus, and replace the callback', () => {
  const firstRetry = jest.fn();
  const latestRetry = jest.fn();
  showLocationFeedback('denied', firstRetry);
  const initial = card();
  const summary = help().querySelector('summary')!;
  help().open = true;
  summary.focus();
  showLocationFeedback('denied', latestRetry, true);
  expect(document.querySelectorAll('#location-feedback')).toHaveLength(1);
  expect(card()).toBe(initial);
  expect(document.activeElement).toBe(summary);
  expect(help().open).toBe(true);
  expect(card()?.textContent).toContain('Showing your last known location.');
  retry().click();
  expect(firstRetry).not.toHaveBeenCalled();
  expect(latestRetry).toHaveBeenCalledTimes(1);
});

test('unsupported location hides retry and moves focus off the hidden control', () => {
  const onRetry = jest.fn();
  showLocationFeedback('unavailable', onRetry);
  retry().focus();
  showLocationFeedback('unsupported', onRetry);
  expect(retry().hidden).toBe(true);
  expect(help().hidden).toBe(true);
  expect(document.activeElement).toBe(dismiss());
  retry().click();
  expect(onRetry).not.toHaveBeenCalled();
});

test('detached controls cannot retry again or clear newer feedback', () => {
  const onRetry = jest.fn();
  showLocationFeedback('timeout', onRetry);
  const oldRetry = retry();
  const oldDismiss = dismiss();
  oldRetry.click();
  showLocationFeedback('unavailable', jest.fn());
  oldRetry.click();
  oldDismiss.click();
  expect(onRetry).toHaveBeenCalledTimes(1);
  expect(card()?.querySelector('h2')?.textContent).toBe(
    'Your location is temporarily unavailable'
  );
});

test('changing away from denied does not leave focus inside hidden help', () => {
  showLocationFeedback('denied', jest.fn());
  help().querySelector('summary')!.focus();
  showLocationFeedback('unavailable', jest.fn());
  expect(document.activeElement).toBe(retry());
});

test('uses DOM text nodes and safely handles an unexpected failure value', () => {
  const htmlSetter = jest
    .spyOn(Element.prototype, 'innerHTML', 'set')
    .mockImplementation(() => {
      throw new Error('Feedback must not parse HTML');
    });
  showLocationFeedback(
    '<img src=x onerror=alert(1)>' as LocationFailure,
    jest.fn()
  );
  expect(htmlSetter).not.toHaveBeenCalled();
  expect(card()?.querySelector('img, script, svg')).toBeNull();
  expect(card()?.querySelector('h2')?.textContent).toBe(
    'Your location is temporarily unavailable'
  );
});

test('clearing is idempotent and does not steal focus from another action', () => {
  showLocationFeedback('timeout', jest.fn());
  document.querySelector<HTMLButtonElement>('#elsewhere')!.focus();
  clearLocationFeedback();
  clearLocationFeedback();
  expect(document.activeElement?.id).toBe('elsewhere');
});

test('clearing tolerates a missing recenter button without leaving a card', () => {
  showLocationFeedback('timeout', jest.fn());
  retry().focus();
  document.querySelector('#recenter-btn')!.remove();
  expect(clearLocationFeedback).not.toThrow();
  expect(card()).toBeNull();
});

test('showing without a map is safe and can recover after the map mounts', () => {
  document.querySelector('.map-container')!.remove();
  showLocationFeedback('timeout', jest.fn());
  expect(card()).toBeNull();
  const container = document.createElement('div');
  container.className = 'map-container';
  document.body.append(container);
  showLocationFeedback('timeout', jest.fn());
  expect(card()?.parentElement).toBe(container);
});

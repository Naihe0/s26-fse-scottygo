/** @jest-environment jsdom */

import { LiveTrackingStatus } from '../../client/scripts/components/live-tracking-status';

describe('compact tracking status disclosure', () => {
  let status: LiveTrackingStatus;
  const panel = () =>
    document.querySelector<HTMLDetailsElement>('.live-tracking-status')!;

  beforeEach(() => {
    document.body.innerHTML = '<div class="map-container"></div>';
    status = new LiveTrackingStatus();
  });

  test('shows only a short bus count until the rider opens tracking details', () => {
    const message =
      '4 buses tracked · movement between reports may be estimated';
    status.show('live', message);
    const summary = panel().querySelector('summary')!;
    expect(summary.textContent).toBe('4 buses tracked');
    expect(panel().open).toBe(false);
    expect(panel().querySelector('p')?.textContent).toBe(message);
    summary.click();
    expect(panel().open).toBe(true);
    expect(panel().querySelector('[role="status"]')?.textContent).toBe(
      '4 buses tracked'
    );
  });

  test.each([
    ['loading', 'Finding buses'],
    ['empty', 'No active buses'],
    ['delayed', 'Location updates delayed'],
    ['unavailable', 'Tracking unavailable'],
    ['partial', 'Some updates delayed'],
    ['paused', 'Tracking paused']
  ] as const)(
    'keeps the %s state concise and exposes its explanation',
    (state, label) => {
      status.show(state, 'A longer explanation with recovery guidance.');
      expect(panel().querySelector('summary')?.textContent).toBe(label);
      expect(panel().querySelector('p')?.textContent).toBe(
        'A longer explanation with recovery guidance.'
      );
      expect(panel().open).toBe(false);
    }
  );

  test('keeps an open disclosure and its focused summary through live updates', () => {
    status.show('live', '1 bus tracked · estimated movement');
    const summary = panel().querySelector('summary')!;
    summary.click();
    summary.focus();
    status.show('live', '2 buses tracked · estimated movement');
    expect(panel().querySelector('summary')).toBe(summary);
    expect(panel().open).toBe(true);
    expect(document.activeElement).toBe(summary);
    expect(summary.textContent).toBe('2 buses tracked');
  });

  test('Escape collapses details and returns focus to the disclosure', () => {
    status.show('delayed', 'Waiting for an update.');
    panel().open = true;
    panel().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(panel().open).toBe(false);
    expect(document.activeElement).toBe(panel().querySelector('summary'));
  });

  test('hiding resets disclosure and a new map gets a new functional panel', () => {
    status.show('live', '2 buses tracked');
    panel().open = true;
    status.hide();
    expect(panel().hidden).toBe(true);
    expect(panel().open).toBe(false);
    status.show('empty', 'No active buses reported for this selection.');
    expect(panel().hidden).toBe(false);
    expect(panel().open).toBe(false);
    document.body.innerHTML = '<div class="map-container"></div>';
    status.show('live', '1 bus tracked');
    panel().querySelector('summary')!.click();
    expect(panel().open).toBe(true);
  });
});

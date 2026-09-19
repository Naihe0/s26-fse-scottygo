/** @jest-environment jsdom */

import { readFileSync } from 'fs';
import { join } from 'path';
jest.mock('../../client/scripts/components/app-header', () => ({}));
jest.mock('../../client/scripts/components/live-notifications', () => ({}));
const mockFetch = jest.fn();
const result = (payload: unknown, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => ({ payload })
});
async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

describe('subscription failures and dialog accessibility', () => {
  beforeEach(async () => {
    jest.resetModules();
    jest.useFakeTimers();
    localStorage.setItem('token', 'test-token');
    global.fetch = mockFetch;
    mockFetch.mockReset().mockImplementation((url: string) =>
      Promise.resolve(
        result(
          url === '/transit/routes'
            ? [
                {
                  id: 'CMU-1',
                  name: '<img src=x onerror=alert(1)>',
                  system: 'CMU'
                }
              ]
            : []
        )
      )
    );
    document.body.innerHTML = readFileSync(
      join(__dirname, '../../client/pages/subscriptions.html'),
      'utf8'
    ).match(/<body>([\s\S]*)<\/body>/)![1];
    await import('../../client/scripts/subscriptions');
    await flush();
  });
  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  test('the add dialog has a close control and Escape restores focus', () => {
    const opener = document.getElementById('add-route-btn')!;
    opener.click();
    const sheet = document.getElementById('bottom-sheet')!;
    expect(sheet.getAttribute('role')).toBe('dialog');
    expect(sheet.hasAttribute('inert')).toBe(false);
    expect(document.querySelector('img')).toBeNull();
    expect(sheet.textContent).toContain('<img src=x onerror=alert(1)>');
    sheet.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })
    );
    expect(sheet.hasAttribute('inert')).toBe(true);
    expect(document.activeElement).toBe(opener);
  });

  test('network failure is visible and restores the subscribe button for retry', async () => {
    document.getElementById('add-route-btn')!.click();
    mockFetch.mockRejectedValueOnce(new Error('offline'));
    const button =
      document.querySelector<HTMLButtonElement>('.result-add-btn')!;
    button.click();
    expect(button.disabled).toBe(true);
    await flush();
    expect(
      document.querySelector('.toast-notification')!.textContent
    ).toContain('Could not update');
    expect(
      document.querySelector<HTMLButtonElement>('.result-add-btn')!.disabled
    ).toBe(false);
    expect(document.getElementById('route-count')!.textContent).toBe('0/10');
  });
});

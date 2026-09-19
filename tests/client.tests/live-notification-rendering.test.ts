/** @jest-environment jsdom */

const mockHandlers = new Map<string, (value: unknown) => void>();
jest.mock('socket.io-client', () => ({
  io: () => ({
    on: (name: string, handler: (value: unknown) => void) =>
      mockHandlers.set(name, handler),
    emit: jest.fn()
  })
}));

test('a live notification treats a stored report as text', async () => {
  jest.useFakeTimers();
  localStorage.setItem('token', 'test-token');
  global.fetch = jest
    .fn()
    .mockResolvedValue({ ok: true, json: async () => ({ payload: [] }) });
  await import('../../client/scripts/components/live-notifications');
  document.dispatchEvent(new Event('DOMContentLoaded'));
  const message = '<img src=x onerror=alert(1)>';
  mockHandlers.get('liveNotification')!({
    routeId: '61D',
    vid: message,
    message,
    createdAt: new Date().toISOString()
  });
  expect(document.querySelector('img')).toBeNull();
  expect(document.querySelector('.live-notif-body')!.textContent).toBe(message);
  jest.clearAllTimers();
  jest.useRealTimers();
});

/** @jest-environment jsdom */
const mockHandlers = new Map<string, (value: unknown) => void>();
const mockDisconnect = jest.fn();
const mockConnect = jest.fn();
jest.mock('socket.io-client', () => ({
  io: () => ({
    on: (name: string, handler: (value: unknown) => void) =>
      mockHandlers.set(name, handler),
    emit: jest.fn(),
    disconnect: mockDisconnect,
    connect: mockConnect
  })
}));

test('pagehide rejects late popup delivery and persisted pageshow resumes', async () => {
  jest.useFakeTimers();
  localStorage.setItem('token', 'test-token');
  global.fetch = jest
    .fn()
    .mockResolvedValue({ ok: true, json: async () => ({ payload: [] }) });
  await import('../../client/scripts/components/live-notifications');
  document.dispatchEvent(new Event('DOMContentLoaded'));
  const notification = {
    routeId: '61C',
    vid: '3400',
    message: 'Bus update',
    changedFields: [],
    createdAt: new Date().toISOString()
  };
  window.dispatchEvent(
    new PageTransitionEvent('pagehide', { persisted: true })
  );
  expect(mockDisconnect).toHaveBeenCalledTimes(1);
  mockHandlers.get('liveNotification')!(notification);
  expect(document.querySelector('.live-notif-card')).toBeNull();
  window.dispatchEvent(
    new PageTransitionEvent('pageshow', { persisted: true })
  );
  expect(mockConnect).toHaveBeenCalledTimes(1);
  mockHandlers.get('liveNotification')!(notification);
  expect(document.querySelector('.live-notif-card')).not.toBeNull();
  window.dispatchEvent(new PageTransitionEvent('pagehide'));
  expect(jest.getTimerCount()).toBe(0);
  jest.useRealTimers();
});

/** @jest-environment jsdom */

import axios from 'axios';
import { authService } from '../../client/scripts/services/auth.service';
jest.mock('axios');

test.each([200, 401])(
  'an old user lookup with status %s cannot return old data or clear the new session',
  async (status) => {
    let finish!: (value: unknown) => void;
    jest.mocked(axios.request).mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      })
    );
    localStorage.setItem('token', 'first-user');
    localStorage.setItem('username', 'first');
    const lookup = authService.getUser('first');
    localStorage.setItem('token', 'second-user');
    localStorage.setItem('username', 'second');
    finish({
      status,
      data: {
        name: status === 200 ? 'UserFound' : 'UnauthorizedRequest',
        payload: { credentials: { username: 'first' } }
      }
    });
    expect(await lookup).toBeNull();
    expect(localStorage.getItem('token')).toBe('second-user');
    expect(localStorage.getItem('username')).toBe('second');
  }
);

test('subscription cache is cleared when the authenticated token changes or is removed', () => {
  localStorage.setItem('token', 'first-user');
  authService.addSubscription('61D');
  expect(authService.isRouteSubscribed('61D')).toBe(true);
  localStorage.setItem('token', 'second-user');
  expect(authService.isRouteSubscribed('61D')).toBe(false);
  authService.addSubscription('71A');
  localStorage.removeItem('token');
  expect(authService.isRouteSubscribed('71A')).toBe(false);
});

test('an earlier user subscription response cannot populate a newer session', async () => {
  let finish!: (value: unknown) => void;
  jest.mocked(axios.get).mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    })
  );
  localStorage.setItem('token', 'first-user');
  const syncing = authService.syncSubscriptionsFromServer();
  localStorage.setItem('token', 'second-user');
  finish({
    status: 200,
    data: { name: 'SubscriptionsRetrieved', payload: [{ routeId: '61D' }] }
  });
  await syncing;
  expect(authService.isRouteSubscribed('61D')).toBe(false);
});

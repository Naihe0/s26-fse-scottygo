/** @jest-environment jsdom */
const mockRequest = jest.fn();
const mockLoggedIn = jest.fn();
const mockNavigate = jest.fn();
jest.mock('axios', () => ({ request: mockRequest, post: jest.fn() }));
jest.mock('../../client/scripts/components/app-header', () => ({}));
jest.mock('../../client/scripts/services/auth.service', () => ({
  authService: { isLoggedIn: mockLoggedIn }
}));
jest.mock('../../client/scripts/utils/map-auth-return', () => {
  const actual = jest.requireActual(
    '../../client/scripts/utils/map-auth-return'
  );
  return {
    ...actual,
    returnToMapView: () => mockNavigate(actual.mapReturnPath())
  };
});
const flush = async () => {
  for (let i = 0; i < 16; i++) await Promise.resolve();
};
const authenticated = {
  status: 200,
  data: {
    name: 'AuthenticatedUser',
    payload: {
      token: 'new-session',
      user: { credentials: { username: 'member' }, agreed: true }
    }
  }
};

beforeEach(() => {
  jest.resetModules();
  jest.useFakeTimers();
  mockRequest.mockReset();
  mockLoggedIn.mockReset().mockResolvedValue(false);
  mockNavigate.mockReset();
  localStorage.clear();
  history.replaceState(
    null,
    '',
    '/auth?returnTo=https://evil.example#/map?r=61C&s=PRT%2CCMU&dir=OB&token=private&lat=40.412345'
  );
  document.body.innerHTML =
    '<form id="login-form"><input id="login-username" value="member"><input id="login-password" value="password"><button id="login-btn">Login</button></form><p id="status"></p><div id="terms-modal" inert><button id="terms-accept">Accept</button><button id="terms-decline">Decline</button></div>';
});
afterEach(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
  document.body.innerHTML = '';
});

test('successful sign-in returns the recipient to the sanitized shared map filters', async () => {
  mockRequest.mockResolvedValueOnce(authenticated);
  await import('../../client/scripts/auth');
  document
    .querySelector('form')!
    .dispatchEvent(new Event('submit', { cancelable: true }));
  await flush();
  await jest.advanceTimersByTimeAsync(1200);
  expect(localStorage.getItem('token')).toBe('new-session');
  expect(mockNavigate).toHaveBeenCalledWith('/#/map?r=61C&s=PRT%2CCMU&dir=OB');
  expect(mockLoggedIn).not.toHaveBeenCalled();
});

test('terms acceptance and refreshed login keep the same shared map handoff', async () => {
  mockRequest
    .mockResolvedValueOnce({
      status: 401,
      data: { name: 'UnauthorizedRequest' }
    })
    .mockResolvedValueOnce({ status: 200, data: {} })
    .mockResolvedValueOnce(authenticated);
  await import('../../client/scripts/auth');
  document
    .querySelector('form')!
    .dispatchEvent(new Event('submit', { cancelable: true }));
  await flush();
  document.getElementById('terms-accept')!.click();
  await flush();
  await jest.advanceTimersByTimeAsync(1200);
  expect(mockRequest).toHaveBeenCalledTimes(3);
  expect(mockNavigate).toHaveBeenCalledWith('/#/map?r=61C&s=PRT%2CCMU&dir=OB');
});

test('a validated existing session follows the safe map handoff without signing in again', async () => {
  localStorage.setItem('token', 'existing-session');
  mockLoggedIn.mockResolvedValueOnce(true);
  await import('../../client/scripts/auth');
  await flush();
  expect(mockLoggedIn).toHaveBeenCalledTimes(1);
  expect(mockNavigate).toHaveBeenCalledWith('/#/map?r=61C&s=PRT%2CCMU&dir=OB');
  expect(mockRequest).not.toHaveBeenCalled();
});

test.each(['/auth', '/auth?returnTo=https://evil.example', '/auth#/account'])(
  'ordinary or non-map auth URL %s does not activate the session shortcut',
  async (path) => {
    history.replaceState(null, '', path);
    localStorage.setItem('token', 'existing-session');
    mockLoggedIn.mockResolvedValueOnce(true);
    await import('../../client/scripts/auth');
    await flush();
    expect(mockLoggedIn).not.toHaveBeenCalled();
    expect(mockNavigate).not.toHaveBeenCalled();
  }
);

test('a rejected session or failed login keeps the shared filters available for retry', async () => {
  localStorage.setItem('token', 'expired-session');
  mockRequest.mockResolvedValueOnce({
    status: 503,
    data: { message: 'Please retry' }
  });
  await import('../../client/scripts/auth');
  await flush();
  document
    .querySelector('form')!
    .dispatchEvent(new Event('submit', { cancelable: true }));
  await flush();
  await jest.advanceTimersByTimeAsync(1200);
  expect(mockNavigate).not.toHaveBeenCalled();
  expect(window.location.hash).toContain('r=61C');
  expect(document.getElementById('status')!.textContent).toContain(
    'Please retry'
  );
});

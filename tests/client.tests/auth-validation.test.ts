/** @jest-environment jsdom */

const mockPost = jest.fn();
const mockRequest = jest.fn();
jest.mock('axios', () => ({ post: mockPost, request: mockRequest }));
jest.mock('../../client/scripts/components/app-header', () => ({}));

async function flush(): Promise<void> {
  for (let i = 0; i < 12; i++) await Promise.resolve();
}

function input(id: string, value: string): void {
  const field = document.getElementById(id) as HTMLInputElement;
  field.value = value;
  field.dispatchEvent(new Event('input'));
}

describe('registration validation and agreement recovery', () => {
  beforeEach(async () => {
    jest.resetModules();
    jest.useFakeTimers();
    mockPost.mockReset().mockResolvedValue({ status: 200 });
    mockRequest.mockReset();
    localStorage.clear();
    document.body.innerHTML = `
      <form id="login-form"><input id="login-username"><input id="login-password"><button id="login-btn">Login</button></form>
      <form id="register-form" hidden><input id="reg-username"><input id="reg-email"><input id="reg-password"><input id="reg-confirm-password"><input id="tos" type="checkbox"><button id="register-btn" disabled>Register</button></form>
      <button id="show-register-btn"></button><button id="show-login-btn"></button>
      <span id="reg-username-hint"></span><span id="reg-email-hint"></span><span id="reg-password-hint"></span><span id="reg-confirm-hint"></span><p id="status"></p>
      <div id="confirm-modal" inert><button id="confirm-yes"></button><button id="confirm-no"></button></div>
      <div id="terms-modal" inert><button id="terms-accept">Accept</button><button id="terms-decline"></button></div>`;
    await import('../../client/scripts/auth');
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  test('editing a previously valid field immediately disables registration', async () => {
    document.getElementById('show-register-btn')!.click();
    input('reg-username', 'validuser');
    input('reg-email', 'valid@cmu.edu');
    input('reg-password', 'Password123!');
    input('reg-confirm-password', 'Password123!');
    const tos = document.getElementById('tos') as HTMLInputElement;
    tos.checked = true;
    tos.dispatchEvent(new Event('change'));
    await jest.advanceTimersByTimeAsync(300);
    const button = document.getElementById('register-btn') as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    input('reg-username', 'x');
    expect(button.disabled).toBe(true);
    document
      .getElementById('register-form')!
      .dispatchEvent(new Event('submit', { cancelable: true }));
    expect(
      document.getElementById('confirm-modal')!.classList.contains('is-open')
    ).toBe(false);
  });

  test('a stale successful response cannot overwrite a newer validation error', async () => {
    let resolveOld!: (value: unknown) => void;
    mockPost.mockImplementation((_url, body: { value: string }) =>
      body.value === 'oldvalue'
        ? new Promise((resolve) => {
            resolveOld = resolve;
          })
        : Promise.resolve({ status: 400, data: { message: 'Too short' } })
    );
    input('reg-username', 'oldvalue');
    await jest.advanceTimersByTimeAsync(300);
    input('reg-username', 'x');
    await jest.advanceTimersByTimeAsync(300);
    resolveOld({ status: 200 });
    await flush();
    expect(document.getElementById('reg-username-hint')!.textContent).toContain(
      'Too short'
    );
  });

  test('a throttled login shows its retry message without opening terms', async () => {
    mockRequest.mockResolvedValueOnce({
      status: 429,
      data: {
        name: 'UnauthorizedRequest',
        message: 'Too many login attempts. Please try again in a minute.'
      }
    });
    input('login-username', 'member');
    input('login-password', 'password');
    document
      .getElementById('login-form')!
      .dispatchEvent(new Event('submit', { cancelable: true }));
    await flush();
    expect(document.getElementById('status')!.textContent).toContain(
      'Too many login attempts'
    );
    expect(
      document.getElementById('terms-modal')!.classList.contains('is-open')
    ).toBe(false);
    expect(
      (document.getElementById('login-btn') as HTMLButtonElement).disabled
    ).toBe(false);
    expect(localStorage.getItem('token')).toBeNull();
  });

  test('failed login after accepting terms remains retryable without claiming success', async () => {
    mockRequest
      .mockResolvedValueOnce({
        status: 401,
        data: { name: 'UnauthorizedRequest' }
      })
      .mockResolvedValueOnce({ status: 200, data: {} })
      .mockResolvedValueOnce({
        status: 503,
        data: { message: 'Login temporarily unavailable' }
      })
      .mockResolvedValueOnce({ status: 200, data: {} })
      .mockResolvedValueOnce({
        status: 200,
        data: {
          name: 'AuthenticatedUser',
          payload: {
            token: 'test-token',
            user: { credentials: { username: 'member' }, agreed: true }
          }
        }
      });
    input('login-username', 'member');
    input('login-password', 'password');
    document
      .getElementById('login-form')!
      .dispatchEvent(new Event('submit', { cancelable: true }));
    await flush();
    document.getElementById('terms-accept')!.click();
    await flush();
    expect(
      document.getElementById('terms-modal')!.classList.contains('is-open')
    ).toBe(true);
    expect(document.getElementById('status')!.textContent).toContain(
      'Login temporarily unavailable'
    );
    expect(localStorage.getItem('token')).toBeNull();
    document.getElementById('terms-accept')!.click();
    await flush();
    expect(mockRequest).toHaveBeenCalledTimes(5);
    expect(localStorage.getItem('token')).toBe('test-token');
    expect(
      document.getElementById('terms-modal')!.classList.contains('is-open')
    ).toBe(false);
  });
});

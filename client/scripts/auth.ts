import axios, { AxiosResponse } from 'axios';
import './components/app-header';
import type { ILogin, IUser } from '../../common/user.interface';
import type {
  IAuthenticatedUser,
  IResponse
} from '../../common/server.responses';
import { isSuccess } from '../../common/server.responses';

export {};

// ── Helpers ─────────────────────────────────────────────────────────

const storeAuth = (token: string, username: string): void => {
  localStorage.setItem('token', token);
  localStorage.setItem('username', username);
};

const hasSuccessStatus = (status: number): boolean =>
  status >= 200 && status < 300;

const getAuthenticatedPayload = (
  data: IResponse | null
): IAuthenticatedUser | null => {
  if (data && isSuccess(data) && data.payload && 'user' in data.payload) {
    return data.payload as IAuthenticatedUser;
  }
  return null;
};

const storeAuthFromResponse = (data: IResponse | null): void => {
  const payload = getAuthenticatedPayload(data);
  if (payload?.token && payload?.user) {
    storeAuth(payload.token, payload.user.credentials.username);
  }
};

const getResponseMessage = (
  data: IResponse | null,
  fallback: string
): string => {
  if (!data) return fallback;
  const errorName = 'name' in data ? data.name : '';
  const errorMessages: Record<string, string> = {
    UserExists: 'Username exists, Log in or try another username',
    IncorrectPassword: 'Incorrect username or password',
    InvalidUsername: 'Username less than 4 characters or invalid',
    InvalidPassword: 'Password should be at least 4 characters',
    InvalidEmail: 'You are ineligible, ScottyGo is CMU ONLY',
    MissingUsername: 'Missing Username',
    MissingPassword: 'Missing Password',
    InactiveAccount:
      'Your account is inactive. Please contact an administrator to reactivate your account.'
  };
  if (errorName in errorMessages) return errorMessages[errorName];
  if (
    'message' in data &&
    typeof data.message === 'string' &&
    data.message.length > 0
  )
    return data.message;
  if (typeof errorName === 'string' && errorName.length > 0) return errorName;
  return fallback;
};

// ── DOM References ──────────────────────────────────────────────────

const loginForm = document.getElementById(
  'login-form'
) as HTMLFormElement | null;
const registerForm = document.getElementById(
  'register-form'
) as HTMLFormElement | null;
const statusEl = document.getElementById(
  'status'
) as HTMLParagraphElement | null;

// Login view inputs
const loginUsername = document.getElementById(
  'login-username'
) as HTMLInputElement | null;
const loginPassword = document.getElementById(
  'login-password'
) as HTMLInputElement | null;
const loginBtn = document.getElementById(
  'login-btn'
) as HTMLButtonElement | null;
const showRegisterBtn = document.getElementById(
  'show-register-btn'
) as HTMLButtonElement | null;

// Register view inputs
const regUsername = document.getElementById(
  'reg-username'
) as HTMLInputElement | null;
const regEmail = document.getElementById(
  'reg-email'
) as HTMLInputElement | null;
const regPassword = document.getElementById(
  'reg-password'
) as HTMLInputElement | null;
const regConfirm = document.getElementById(
  'reg-confirm-password'
) as HTMLInputElement | null;
const registerBtn = document.getElementById(
  'register-btn'
) as HTMLButtonElement | null;
const showLoginBtn = document.getElementById(
  'show-login-btn'
) as HTMLButtonElement | null;

// Validation hints
const usernameHint = document.getElementById(
  'reg-username-hint'
) as HTMLSpanElement | null;
const emailHint = document.getElementById(
  'reg-email-hint'
) as HTMLSpanElement | null;
const passwordHint = document.getElementById(
  'reg-password-hint'
) as HTMLSpanElement | null;
const confirmHint = document.getElementById(
  'reg-confirm-hint'
) as HTMLSpanElement | null;

// Shared elements (present in both views)
const tosInput = document.getElementById('tos') as HTMLInputElement | null;

// Modals
const confirmModal = document.getElementById(
  'confirm-modal'
) as HTMLDivElement | null;
const confirmYes = document.getElementById(
  'confirm-yes'
) as HTMLButtonElement | null;
const confirmNo = document.getElementById(
  'confirm-no'
) as HTMLButtonElement | null;
const termsModal = document.getElementById(
  'terms-modal'
) as HTMLDivElement | null;
const termsAccept = document.getElementById(
  'terms-accept'
) as HTMLButtonElement | null;
const termsDecline = document.getElementById(
  'terms-decline'
) as HTMLButtonElement | null;
const termsLink = document.getElementById(
  'terms-link'
) as HTMLButtonElement | null;
const declineModal = document.getElementById(
  'decline-modal'
) as HTMLDivElement | null;
const declineOk = document.getElementById(
  'decline-ok'
) as HTMLButtonElement | null;

// ── State ───────────────────────────────────────────────────────────

let pendingRegisterPayload: IUser | null = null;
let pendingAgreementUsername: string | null = null;
let pendingAgreementPassword: string | null = null;
let pendingRedirectToHome = false;
let agreementSubmitting = false;
let registrationSubmitting = false;

// Track which fields have been touched for validation
const touched: Record<string, boolean> = {
  username: false,
  email: false,
  password: false,
  confirm: false
};

// Track per-field validation state
const fieldValid: Record<string, boolean> = {
  username: false,
  email: false,
  password: false,
  confirm: false
};

// ── Status & Error Helpers ──────────────────────────────────────────

const setStatus = (message: string, isError = false): void => {
  if (!statusEl) return;
  statusEl.textContent = message;
  statusEl.classList.toggle('status--error', isError);
};

const setHint = (
  el: HTMLSpanElement | null,
  valid: boolean,
  message: string
): void => {
  if (!el) return;
  el.textContent = message;
  el.className = valid
    ? 'field-hint field-hint--valid'
    : 'field-hint field-hint--invalid';
};

const clearHint = (el: HTMLSpanElement | null): void => {
  if (!el) return;
  el.textContent = '';
  el.className = 'field-hint';
};

const setInputError = (errorName: string): void => {
  // Highlight relevant inputs in the currently-visible form
  const u = loginForm?.hidden ? regUsername : loginUsername;
  const p = loginForm?.hidden ? regPassword : loginPassword;
  const e = regEmail;
  u?.classList.remove('form-input--error');
  p?.classList.remove('form-input--error');
  e?.classList.remove('form-input--error');

  switch (errorName) {
    case 'MissingUsername':
    case 'InvalidUsername':
    case 'UserExists':
      u?.classList.add('form-input--error');
      break;
    case 'MissingPassword':
    case 'InvalidPassword':
      p?.classList.add('form-input--error');
      break;
    case 'IncorrectPassword':
      u?.classList.add('form-input--error');
      p?.classList.add('form-input--error');
      break;
    case 'MissingEmail':
    case 'InvalidEmail':
      e?.classList.add('form-input--error');
      break;
  }
};

// ── View Switching ──────────────────────────────────────────────────

const switchToRegister = (): void => {
  if (loginForm) loginForm.hidden = true;
  if (registerForm) registerForm.hidden = false;
  setStatus('');
  // Reset touched state and hints
  Object.keys(touched).forEach((k) => {
    touched[k] = false;
  });
  Object.keys(fieldValid).forEach((k) => {
    fieldValid[k] = false;
    validationVersions[k] = (validationVersions[k] ?? 0) + 1;
    clearTimeout(validateTimers[k]);
  });
  clearHint(usernameHint);
  clearHint(emailHint);
  clearHint(passwordHint);
  clearHint(confirmHint);
  updateRegisterButton();
};

const switchToLogin = (): void => {
  if (registerForm) registerForm.hidden = true;
  if (loginForm) loginForm.hidden = false;
  setStatus('');
};

showRegisterBtn?.addEventListener('click', switchToRegister);
showLoginBtn?.addEventListener('click', switchToLogin);

// ── Backend Validation ──────────────────────────────────────────────

const validateTimers: Record<string, ReturnType<typeof setTimeout>> = {};
const validationVersions: Record<string, number> = {};

const validateFieldDebounced = (
  field: 'username' | 'email' | 'password',
  value: string,
  hintEl: HTMLSpanElement | null,
  successMsg: string
): void => {
  if (validateTimers[field]) clearTimeout(validateTimers[field]);
  const version = (validationVersions[field] ?? 0) + 1;
  validationVersions[field] = version;
  fieldValid[field] = false;
  clearHint(hintEl);
  updateRegisterButton();

  if (!value) {
    fieldValid[field] = false;
    clearHint(hintEl);
    updateRegisterButton();
    return;
  }

  validateTimers[field] = setTimeout(async () => {
    try {
      const res: AxiosResponse = await axios.post(
        '/auth/validate',
        { field, value },
        { validateStatus: () => true }
      );
      if (validationVersions[field] !== version) return;
      if (res.status === 200) {
        fieldValid[field] = true;
        setHint(hintEl, true, `✓ ${successMsg}`);
      } else {
        fieldValid[field] = false;
        const msg = res.data?.message || 'Invalid';
        setHint(hintEl, false, `✗ ${msg}`);
      }
    } catch {
      if (validationVersions[field] !== version) return;
      fieldValid[field] = false;
      setHint(hintEl, false, '✗ Could not validate');
    }
    updateRegisterButton();
  }, 300);
};

const validateConfirmPassword = (): void => {
  if (!touched.confirm) return;
  const pw = regPassword?.value ?? '';
  const cpw = regConfirm?.value ?? '';
  if (!cpw) {
    fieldValid.confirm = false;
    clearHint(confirmHint);
  } else if (pw === cpw) {
    fieldValid.confirm = true;
    setHint(confirmHint, true, '✓ Passwords match');
  } else {
    fieldValid.confirm = false;
    setHint(confirmHint, false, '✗ Passwords do not match');
  }
  updateRegisterButton();
};

const updateRegisterButton = (): void => {
  if (!registerBtn) return;
  const allValid =
    fieldValid.username &&
    fieldValid.email &&
    fieldValid.password &&
    fieldValid.confirm &&
    !!tosInput?.checked;
  registerBtn.disabled =
    !allValid || registrationSubmitting || agreementSubmitting;
};

// Wire up validation listeners
regUsername?.addEventListener('input', () => {
  touched.username = true;
  validateFieldDebounced(
    'username',
    regUsername.value.trim(),
    usernameHint,
    'Looks good'
  );
});
regUsername?.addEventListener('blur', () => {
  touched.username = true;
  validateFieldDebounced(
    'username',
    regUsername.value.trim(),
    usernameHint,
    'Looks good'
  );
});

regEmail?.addEventListener('input', () => {
  touched.email = true;
  validateFieldDebounced(
    'email',
    regEmail.value.trim(),
    emailHint,
    'Valid CMU email'
  );
});
regEmail?.addEventListener('blur', () => {
  touched.email = true;
  validateFieldDebounced(
    'email',
    regEmail.value.trim(),
    emailHint,
    'Valid CMU email'
  );
});

regPassword?.addEventListener('input', () => {
  touched.password = true;
  validateFieldDebounced(
    'password',
    regPassword.value,
    passwordHint,
    'Strong password'
  );
  validateConfirmPassword(); // re-check confirm match
});
regPassword?.addEventListener('blur', () => {
  touched.password = true;
  validateFieldDebounced(
    'password',
    regPassword.value,
    passwordHint,
    'Strong password'
  );
});

regConfirm?.addEventListener('input', () => {
  touched.confirm = true;
  validateConfirmPassword();
});
regConfirm?.addEventListener('blur', () => {
  touched.confirm = true;
  validateConfirmPassword();
});

tosInput?.addEventListener('change', updateRegisterButton);

// ── API Calls ───────────────────────────────────────────────────────

const registerUser = async (
  body: IUser
): Promise<{ status: number; data: IResponse | null }> => {
  try {
    const res: AxiosResponse<IResponse> = await axios.request({
      method: 'post',
      headers: { 'Content-Type': 'application/json' },
      data: body,
      url: '/auth/users',
      validateStatus: () => true
    });
    return { status: res.status, data: res.data };
  } catch {
    return { status: 500, data: null };
  }
};

const loginUser = async (
  username: string,
  password: string
): Promise<{ status: number; data: IResponse | null }> => {
  try {
    const res: AxiosResponse<IResponse> = await axios.request({
      method: 'post',
      headers: { 'Content-Type': 'application/json' },
      data: { password },
      url: `/auth/tokens/${encodeURIComponent(username)}`,
      validateStatus: () => true
    });
    return { status: res.status, data: res.data };
  } catch {
    return { status: 500, data: null };
  }
};

const confirmAgreement = async (
  username: string,
  password: string
): Promise<{ status: number; data: IResponse | null }> => {
  try {
    const res: AxiosResponse<IResponse> = await axios.request({
      method: 'patch',
      headers: { 'Content-Type': 'application/json' },
      data: { password },
      url: `/auth/users/${encodeURIComponent(username)}`,
      validateStatus: () => true
    });
    return { status: res.status, data: res.data };
  } catch {
    return { status: 500, data: null };
  }
};

const redirectToDirectory = (message: string): void => {
  setStatus(message);
  window.setTimeout(() => {
    window.location.href = '/';
  }, 1200);
};

const agreeAndRefreshSession = async (
  username: string,
  password: string
): Promise<{ ok: true } | { ok: false; message: string }> => {
  const agreementResult = await confirmAgreement(username, password);
  if (!hasSuccessStatus(agreementResult.status)) {
    return {
      ok: false,
      message: getResponseMessage(
        agreementResult.data,
        'Agreement update failed.'
      )
    };
  }
  const loginResult = await loginUser(username, password);
  if (
    !hasSuccessStatus(loginResult.status) ||
    !getAuthenticatedPayload(loginResult.data)?.token
  ) {
    return {
      ok: false,
      message: getResponseMessage(
        loginResult.data,
        'Agreement saved, but login failed. Please try again.'
      )
    };
  }
  storeAuthFromResponse(loginResult.data);
  return { ok: true };
};

// ── Modal Helpers ───────────────────────────────────────────────────

const openModal = (modal: HTMLDivElement | null): void => {
  if (!modal) return;
  modal.classList.add('is-open');
  modal.removeAttribute('inert');
};

const closeModal = (modal: HTMLDivElement | null): void => {
  if (!modal) return;
  modal.classList.remove('is-open');
  modal.setAttribute('inert', '');
};

const openTermsModal = (
  username: string,
  password: string,
  shouldRedirect: boolean
): void => {
  pendingAgreementUsername = username;
  pendingAgreementPassword = password;
  pendingRedirectToHome = shouldRedirect;
  openModal(termsModal);
};

const setSubmitting = (
  btn: HTMLButtonElement | null,
  isSubmitting: boolean,
  label: string
): void => {
  if (!btn) return;
  btn.disabled = isSubmitting;
  btn.textContent = isSubmitting ? 'Submitting...' : label;
};

// ── Login Submit ────────────────────────────────────────────────────

loginForm?.addEventListener('submit', async (event: SubmitEvent) => {
  event.preventDefault();
  setStatus('');

  const username = loginUsername?.value.trim() ?? '';
  const password = loginPassword?.value ?? '';

  if (!username || !password) {
    setStatus(username ? 'Missing Password' : 'Missing Username', true);
    return;
  }

  setSubmitting(loginBtn, true, 'Login');

  try {
    const { status, data } = await loginUser(username, password);

    if (!hasSuccessStatus(status)) {
      const errorName = data && 'name' in data ? data.name : '';

      if (errorName === 'InactiveAccount') {
        setStatus(getResponseMessage(data, 'Your account is inactive.'), true);
        return;
      }

      if (status === 401 && errorName === 'UnauthorizedRequest') {
        openTermsModal(username, password, true);
        return;
      }

      setInputError(errorName);
      setStatus(getResponseMessage(data, 'Login failed.'), true);
      return;
    }

    const authPayload = getAuthenticatedPayload(data);
    const authenticatedUser = authPayload?.user ?? null;

    if (authenticatedUser && authenticatedUser.agreed === false) {
      openTermsModal(authenticatedUser.credentials.username, password, true);
      return;
    }

    storeAuthFromResponse(data);
    redirectToDirectory('Login successful. Redirecting...');
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : 'Network error. Please try again.';
    setStatus(message, true);
  } finally {
    setSubmitting(loginBtn, false, 'Login');
  }
});

// ── Register Submit ─────────────────────────────────────────────────

registerForm?.addEventListener('submit', async (event: SubmitEvent) => {
  event.preventDefault();
  updateRegisterButton();
  if (registerBtn?.disabled) return;
  setStatus('');

  const credentials: ILogin = {
    username: regUsername?.value.trim() ?? '',
    password: regPassword?.value ?? ''
  };
  const email = regEmail?.value.trim() ?? '';
  const shouldAgree = !!tosInput?.checked;

  pendingRegisterPayload = {
    credentials,
    email,
    agreed: shouldAgree
  };
  openModal(confirmModal);
});

// ── Confirm Registration Modal ──────────────────────────────────────

confirmYes?.addEventListener('click', async () => {
  if (registrationSubmitting) return;
  if (!pendingRegisterPayload) {
    closeModal(confirmModal);
    return;
  }

  closeModal(confirmModal);
  registrationSubmitting = true;
  setSubmitting(registerBtn, true, 'Register');

  const shouldAgree = pendingRegisterPayload.agreed;
  const registerBody: IUser = {
    ...pendingRegisterPayload,
    agreed: false
  };

  try {
    const { status, data } = await registerUser(registerBody);

    if (status < 200 || status >= 300) {
      const message = getResponseMessage(data, 'Registration failed.');
      const errorName = data && 'name' in data ? data.name : '';
      setInputError(errorName);
      setStatus(message, true);
      return;
    }

    const user =
      data && isSuccess(data) && data.payload && 'credentials' in data.payload
        ? (data.payload as IUser)
        : null;

    if (!user) {
      setStatus('Registration succeeded but user data is missing.', true);
      return;
    }

    if (shouldAgree) {
      const agreementOutcome = await agreeAndRefreshSession(
        user.credentials.username,
        registerBody.credentials.password
      );
      if (!agreementOutcome.ok) {
        setStatus(agreementOutcome.message, true);
        return;
      }
      redirectToDirectory('Registered successfully. Redirecting...');
      return;
    }

    openTermsModal(
      user.credentials.username,
      registerBody.credentials.password,
      true
    );
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : 'Network error. Please try again.';
    setStatus(message, true);
  } finally {
    pendingRegisterPayload = null;
    registrationSubmitting = false;
    setSubmitting(registerBtn, false, 'Register');
    updateRegisterButton();
  }
});

confirmNo?.addEventListener('click', () => {
  pendingRegisterPayload = null;
  closeModal(confirmModal);
});

// ── Terms Modal ─────────────────────────────────────────────────────

const handleAgreementAccept = async (): Promise<void> => {
  if (agreementSubmitting) return;
  if (!pendingAgreementUsername || !pendingAgreementPassword) {
    if (tosInput) tosInput.checked = true;
    closeModal(termsModal);
    updateRegisterButton();
    return;
  }

  agreementSubmitting = true;
  setSubmitting(termsAccept, true, 'Accept');
  updateRegisterButton();
  try {
    const agreementOutcome = await agreeAndRefreshSession(
      pendingAgreementUsername,
      pendingAgreementPassword
    );
    if (!agreementOutcome.ok) {
      setStatus(agreementOutcome.message, true);
      return;
    }

    if (tosInput) tosInput.checked = true;
    closeModal(termsModal);
    updateRegisterButton();

    setStatus('Agreement accepted. Redirecting...');
    if (pendingRedirectToHome) {
      redirectToDirectory('Agreement accepted. Redirecting...');
    }
    pendingAgreementUsername = null;
    pendingAgreementPassword = null;
    pendingRedirectToHome = false;
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : 'Network error. Please try again.';
    setStatus(message, true);
  } finally {
    agreementSubmitting = false;
    setSubmitting(termsAccept, false, 'Accept');
    updateRegisterButton();
    setSubmitting(loginBtn, false, 'Login');
  }
};

termsAccept?.addEventListener('click', async () => {
  await handleAgreementAccept();
});

termsLink?.addEventListener('click', () => {
  pendingAgreementUsername = null;
  pendingAgreementPassword = null;
  pendingRedirectToHome = false;
  openModal(termsModal);
});

termsDecline?.addEventListener('click', () => {
  closeModal(termsModal);
  openModal(declineModal);
});

declineOk?.addEventListener('click', () => {
  closeModal(declineModal);
  window.location.href = '/';
});

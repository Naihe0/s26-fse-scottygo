// The signed-in session lives in localStorage: the bearer token from login
// and the username it was issued to.

const TOKEN_KEY = 'token';
const USERNAME_KEY = 'username';

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function getUsername(): string | null {
  return localStorage.getItem(USERNAME_KEY);
}

export function storeSession(token: string, username: string): void {
  localStorage.setItem(TOKEN_KEY, token);
  setUsername(username);
}

/** Keep the stored username current after the account is renamed. */
export function setUsername(username: string): void {
  localStorage.setItem(USERNAME_KEY, username);
}

export function clearSession(): void {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USERNAME_KEY);
}

/** Authorization header for API requests; empty when signed out. */
export function authHeaders(): Record<string, string> {
  const token = getToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/** Clear the session and leave for the sign-in page. */
export function signOut(signInPath = '/auth'): void {
  clearSession();
  window.location.replace(signInPath);
}

/**
 * True while the session that started an async operation is still active,
 * so responses from a previous user never update the current page.
 */
export function isSameSession(token: string | null): boolean {
  return getToken() === token;
}

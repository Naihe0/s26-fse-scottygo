/** @jest-environment jsdom */

import '../../client/scripts/components/app-header';

function mount(path = '/'): HTMLElement {
  window.history.replaceState({}, '', path);
  const header = document.createElement('app-header');
  document.body.appendChild(header);
  return header;
}

function menuButton(header: HTMLElement): HTMLButtonElement {
  return header.querySelector<HTMLButtonElement>('#menu-icon')!;
}

afterEach(() => {
  document.body.replaceChildren();
  localStorage.clear();
  window.history.replaceState({}, '', '/');
  jest.restoreAllMocks();
});

test.each([
  ['/', 'Map', '/'],
  ['/map', 'Map', '/'],
  ['/subscriptions', 'Saved routes', '/subscriptions'],
  ['/notifications', 'Alerts', '/notifications'],
  ['/account/', 'Account', '/account'],
  ['/auth', 'Sign in', '/auth']
])(
  'identifies the current page at %s and keeps a direct map link',
  (path, label, link) => {
    const header = mount(path);
    expect(header.getAttribute('role')).toBe('banner');
    expect(header.querySelector('.app-page-context')!.textContent).toBe(label);
    const current = header.querySelectorAll('[aria-current="page"]');
    expect(current).toHaveLength(1);
    expect(current[0].getAttribute('href')).toBe(link);
    expect(header.querySelector('.app-brand')!.getAttribute('href')).toBe('/');
    expect(
      header.querySelector('.dropdown-item[href="/"]')!.textContent
    ).toContain('Map');
  }
);

test('offers sign in without a session and log out with a session', () => {
  const header = mount('/auth');
  expect(header.querySelector('.dropdown-session')!.textContent).toContain(
    'Sign in'
  );
  expect(header.querySelector('#menu-logout-btn')).toBeNull();
  header.remove();
  localStorage.setItem('token', 'fixture-session');
  const authenticatedHeader = mount('/account');
  expect(
    authenticatedHeader.querySelector('#menu-logout-btn')!.textContent
  ).toContain('Log out');
});

test('menu announces open and closed actions, and Escape returns focus', () => {
  const header = mount('/notifications');
  const button = menuButton(header);
  button.click();
  expect(button.getAttribute('aria-label')).toBe('Close navigation menu');
  expect(button.getAttribute('aria-expanded')).toBe('true');
  const link = header.querySelector<HTMLAnchorElement>('.dropdown-item')!;
  link.focus();
  link.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })
  );
  expect(button.getAttribute('aria-label')).toBe('Open navigation menu');
  expect(header.querySelector('#dropdown-menu')!.hasAttribute('inert')).toBe(
    true
  );
  expect(document.activeElement).toBe(button);
});

test('tabbing out closes navigation without stealing the next control focus', () => {
  const header = mount();
  const next = document.createElement('button');
  next.textContent = 'Map control';
  document.body.appendChild(next);
  menuButton(header).click();
  header.querySelector<HTMLAnchorElement>('.dropdown-item')!.focus();
  next.focus();
  expect(menuButton(header).getAttribute('aria-expanded')).toBe('false');
  expect(document.activeElement).toBe(next);
});

test('outside click does not leave focus inside the now inert navigation', () => {
  const header = mount();
  menuButton(header).click();
  header.querySelector<HTMLAnchorElement>('.dropdown-item')!.focus();
  document.body.click();
  expect(menuButton(header).getAttribute('aria-expanded')).toBe('false');
  expect(document.activeElement).toBe(menuButton(header));
});

test('Escape with a closed menu preserves the current header control', () => {
  const header = mount();
  const brand = header.querySelector<HTMLAnchorElement>('.app-brand')!;
  brand.focus();
  brand.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })
  );
  expect(document.activeElement).toBe(brand);
});

test('reconnecting the header starts closed and never focuses a discarded menu button', () => {
  const header = mount();
  const oldButton = menuButton(header);
  oldButton.click();
  header.remove();
  const oldFocus = jest.spyOn(oldButton, 'focus');
  document.body.appendChild(header);
  const button = menuButton(header);
  expect(button.getAttribute('aria-expanded')).toBe('false');
  button.click();
  header.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })
  );
  expect(oldFocus).not.toHaveBeenCalled();
  expect(document.activeElement).toBe(button);
});

test('the optional back action is a button and follows browser history', () => {
  const back = jest
    .spyOn(window.history, 'back')
    .mockImplementation(() => undefined);
  const header = document.createElement('app-header');
  header.setAttribute('back', '');
  document.body.appendChild(header);
  const button = header.querySelector<HTMLButtonElement>('#back-icon')!;
  expect(button.tagName).toBe('BUTTON');
  button.click();
  expect(back).toHaveBeenCalledTimes(1);
});

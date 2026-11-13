/** @jest-environment jsdom */

import '../../client/scripts/components/app-header';

function mount(path = '/', back = false): HTMLElement {
  window.history.replaceState({}, '', path);
  const header = document.createElement('app-header');
  if (back) header.setAttribute('back', '');
  document.body.appendChild(header);
  return header;
}

function menuButton(header: HTMLElement): HTMLButtonElement {
  return header.querySelector<HTMLButtonElement>('#menu-icon')!;
}

afterEach(() => {
  document.body.replaceChildren();
  localStorage.clear();
  sessionStorage.clear();
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

test('the back action follows an existing ScottyGo visit', () => {
  jest
    .spyOn(document, 'referrer', 'get')
    .mockReturnValue(window.location.origin + '/subscriptions');
  jest.spyOn(window.history, 'length', 'get').mockReturnValue(2);
  const back = jest
    .spyOn(window.history, 'back')
    .mockImplementation(() => undefined);
  const header = mount('/account', true);
  const button = header.querySelector<HTMLButtonElement>('#back-icon')!;
  expect(button.tagName).toBe('BUTTON');
  button.click();
  expect(back).toHaveBeenCalledTimes(1);
});

const sessionFor = (userId: string) =>
  localStorage.setItem(
    'token',
    `test.${btoa(JSON.stringify({ userId }))}.fixture`
  );

test('returning from alerts restores the last public route, stop and filters captured on departure', () => {
  sessionFor('first-rider');
  const map = mount('/#/map?r=old');
  window.history.replaceState(
    {},
    '',
    '/#/map?r=61C&stop=123&s=PRT&dir=IB&lat=40.4&token=private'
  );
  window.dispatchEvent(new Event('pagehide'));
  map.remove();
  const alerts = mount('/notifications', true);
  const destinations = alerts.querySelectorAll('[data-map-return]');
  // Back, brand, the Map section tab and the menu's Map item.
  expect(destinations).toHaveLength(4);
  expect(
    alerts.querySelector('.app-primary-nav [data-map-return]')
  ).not.toBeNull();
  for (const link of destinations) {
    expect(link.getAttribute('href')).toBe(
      '/#/map?r=61C&stop=123&s=PRT&dir=IB'
    );
  }
  expect(alerts.querySelector('a[aria-label="Return to map"]')).not.toBeNull();
});

test('a previous account’s map does not carry over, including a session change before departure', () => {
  sessionFor('first-rider');
  const map = mount('/#/map?r=61C');
  menuButton(map).click();
  sessionFor('second-rider');
  window.dispatchEvent(new Event('pagehide'));
  map.remove();
  const header = mount('/subscriptions');
  expect(header.querySelector('.app-brand')!.getAttribute('href')).toBe('/');
});

test('a cleared map and a storage failure both lead back to the main map', () => {
  sessionFor('rider');
  const map = mount('/#/map?r=61C');
  menuButton(map).click();
  window.history.replaceState({}, '', '/#/map');
  window.dispatchEvent(new Event('pagehide'));
  map.remove();
  const header = mount('/account');
  expect(header.querySelector('.app-brand')!.getAttribute('href')).toBe('/');
  jest.spyOn(Storage.prototype, 'getItem').mockImplementation(function (
    this: Storage
  ) {
    if (this === sessionStorage) throw new Error('Unavailable');
    return `test.${btoa(JSON.stringify({ userId: 'rider' }))}.fixture`;
  });
  window.dispatchEvent(new Event('pageshow'));
  expect(header.querySelector('.app-brand')!.getAttribute('href')).toBe('/');
});

test('a direct signed-out sign-in has no dead Back button; an external referral keeps the rider in the app', () => {
  const auth = mount('/auth', true);
  expect(auth.querySelector('.back-icon')).toBeNull();
  auth.remove();
  jest
    .spyOn(document, 'referrer', 'get')
    .mockReturnValue('https://outside.example/article');
  jest.spyOn(window.history, 'length', 'get').mockReturnValue(3);
  const header = mount('/subscriptions', true);
  expect(header.querySelector('.back-icon')!.getAttribute('href')).toBe('/');
});

test.each([
  ['/', '/'],
  ['/map', '/'],
  ['/subscriptions', '/subscriptions'],
  ['/notifications', '/notifications'],
  ['/account', '/account']
])(
  'a signed-in rider reaches every section in one tap from %s',
  (path, currentHref) => {
    sessionFor('rider');
    const header = mount(path, path !== '/' && path !== '/map');
    const nav = header.querySelector('nav.app-primary-nav')!;
    expect(nav.getAttribute('aria-label')).toBe('ScottyGo sections');
    const links = [...nav.querySelectorAll<HTMLAnchorElement>('a')];
    expect(links.map((link) => link.textContent!.trim())).toEqual([
      'Map',
      'Saved routes',
      'Alerts',
      'Account'
    ]);
    const current = nav.querySelectorAll('[aria-current="page"]');
    expect(current).toHaveLength(1);
    expect(current[0].getAttribute('href')).toBe(currentHref);
    // The menu still marks the same page for riders who open it.
    expect(
      header.querySelectorAll('#dropdown-menu [aria-current="page"]')
    ).toHaveLength(1);
    expect(header.querySelector('#menu-logout-btn')).not.toBeNull();
  }
);

test('signed-out and sign-in pages show no section bar', () => {
  expect(mount('/account').querySelector('.app-primary-nav')).toBeNull();
  document.body.replaceChildren();
  sessionFor('rider');
  expect(mount('/auth', true).querySelector('.app-primary-nav')).toBeNull();
});

test('tapping the open section returns to its top without reloading', () => {
  sessionFor('rider');
  const main = document.createElement('main');
  const scrollTo = jest.fn();
  Object.defineProperty(main, 'scrollTo', { value: scrollTo });
  document.body.appendChild(main);
  const header = mount('/notifications', true);
  const alerts = header.querySelector<HTMLAnchorElement>(
    '.app-primary-nav [href="/notifications"]'
  )!;
  const tap = new MouseEvent('click', { bubbles: true, cancelable: true });
  alerts.dispatchEvent(tap);
  expect(tap.defaultPrevented).toBe(true);
  expect(scrollTo).toHaveBeenCalledWith({ top: 0, behavior: 'smooth' });
  const other = new MouseEvent('click', { bubbles: true, cancelable: true });
  header
    .querySelector('.app-primary-nav [href="/account"]')!
    .dispatchEvent(other);
  expect(other.defaultPrevented).toBe(false);
});

test('the Map tab on the map keeps the current view instead of reloading', () => {
  sessionFor('rider');
  const header = mount('/#/map?r=61C');
  const mapTab = header.querySelector<HTMLAnchorElement>(
    '.app-primary-nav [href="/"]'
  )!;
  const tap = new MouseEvent('click', { bubbles: true, cancelable: true });
  mapTab.dispatchEvent(tap);
  expect(tap.defaultPrevented).toBe(true);
  expect(window.location.hash).toBe('#/map?r=61C');
});

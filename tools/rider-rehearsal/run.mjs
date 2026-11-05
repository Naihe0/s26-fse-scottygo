/**
 * Run against built pages with deterministic buses, GPS, accounts and SDK responses.
 * Set PLAYWRIGHT_MODULE to a Playwright installation if it isn't in node_modules.
 * Use --production-assets to rehearse the published pages with the same isolated
 * data. All interactions and writes take place on a disposable loopback origin.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { installMapFixture } from './map-fixture.mjs';
import { apiFixture } from './feeds.mjs';
import { socketFixture } from './socket-fixture.mjs';

const require = createRequire(import.meta.url);
const { webkit, chromium, devices } = require(
  process.env.PLAYWRIGHT_MODULE || 'playwright'
);
const socket = await socketFixture();
const origin = socket.origin;
const prod = 'https://scottygo-ningrui.onrender.com';
const pages = new Map([
  ['/', 'map.html'],
  ['/auth', 'auth.html'],
  ['/account', 'account.html'],
  ['/subscriptions', 'subscriptions.html'],
  ['/notifications', 'notifications.html']
]);
const productionAssets = process.argv.includes('--production-assets');
const desktop = process.argv.includes('--desktop');
const result = [];
const browser = desktop
  ? await chromium.launch({ channel: 'chrome' })
  : await webkit.launch();
const context = await browser.newContext({
  ...(desktop
    ? { viewport: { width: 1220, height: 820 } }
    : devices['iPhone 15']),
  geolocation: { latitude: 40.4433, longitude: -79.9436 },
  permissions: ['geolocation']
});
const page = await context.newPage();
const fixture = apiFixture();
const failures = [];
let abortedPolls = 0;
// WebKit cancels any outstanding Socket.IO long poll when its document unloads.
page.on('pageerror', (err) => {
  if (
    err.message.includes('/socket.io/?EIO=4&transport=polling') &&
    err.message.endsWith('due to access control checks.')
  )
    abortedPolls++;
  else failures.push(err.message);
});
page.setDefaultTimeout(6500);
await context.addInitScript(installMapFixture);
const assets = new Map();
await context.route('**/*', async (intercepted) => {
  const req = intercepted.request();
  const url = new URL(req.url());
  if (url.origin !== origin) return intercepted.abort();
  if (url.pathname.startsWith('/socket.io/')) return intercepted.continue();
  const api = fixture.handle(url, req);
  if (api) return intercepted.fulfill(api);
  const name =
    pages.get(url.pathname) ||
    (/^\/[\w.-]+\.(js|css)$/.test(url.pathname) ? url.pathname.slice(1) : null);
  if (!name || req.method() !== 'GET')
    return intercepted.fulfill({
      status: 404,
      body: 'Unconfigured rehearsal route'
    });
  if (!assets.has(name)) {
    const asset = productionAssets
      ? await fetch(prod + url.pathname, { signal: AbortSignal.timeout(30000) })
      : null;
    if (asset && !asset.ok) throw Error('Static asset HTTP ' + asset.status);
    assets.set(
      name,
      asset
        ? Buffer.from(await asset.arrayBuffer())
        : await readFile(path.resolve('.dist/client', name))
    );
  }
  return intercepted.fulfill({
    body: assets.get(name),
    contentType:
      { js: 'text/javascript', css: 'text/css', html: 'text/html' }[
        name.split('.').at(-1)
      ] + '; charset=utf-8'
  });
});
const go = (relative) =>
  page.goto(origin + relative, { waitUntil: 'domcontentloaded' });
const click = (selector) => page.locator(selector).click();
async function activateFilter(selector) {
  const item = page.locator(selector);
  try {
    await item.click({ timeout: 700 });
  } catch (error) {
    if (
      !process.argv.includes('--allow-known-overlap') ||
      !String(error.message).includes('intercepts pointer events')
    )
      throw error;
    console.log('OBS blocked filter touch, used keyboard', selector);
    await item.press('Enter');
  }
}
async function step(id, action) {
  await action();
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth
    ),
    'Horizontal overflow in ' + id
  );
  result.push(id);
  console.log('PASS', id);
}
try {
  await go('/auth');
  await step(
    'UC01 Registration guidance, password reveal and terms',
    async () => {
      await click('#show-register-btn');
      await page.locator('#reg-username').fill('campusrider');
      await click('#terms-link');
      await click('#terms-return');
      assert.equal(
        await page.locator('#reg-username').inputValue(),
        'campusrider'
      );
      assert.equal(await page.locator('#tos').isChecked(), false);
      await click('#show-login-btn');
      const reveal = page.locator('[aria-controls="login-password"]');
      await reveal.click();
      assert.equal(
        await page.locator('#login-password').getAttribute('type'),
        'text'
      );
      await reveal.click();
    }
  );
  await step('UC02 Sign in and open map', async () => {
    await page.locator('#login-username').fill('rider');
    await page.locator('#login-password').fill('Demo1!');
    await click('#login-btn');
    await page.locator('#map[data-ready]').waitFor();
    await page.waitForFunction(
      () =>
        document.querySelector('#location-search-current-sublabel')
          ?.textContent === 'Using GPS'
    );
  });
  await step('UC03 Tour and map key', async () => {
    await click('.map-key__toggle');
    await page.getByRole('button', { name: 'Take the map tour' }).click();
    const guide = page.locator('dialog.rider-guide[open]');
    await guide.locator('select').selectOption({ index: 1 });
    await guide.getByRole('button', { name: 'Back', exact: true }).click();
    await guide.getByRole('button', { name: 'End tour' }).click();
  });
  await step('UC04 GPS and alternate planning origin', async () => {
    await click('#recenter-btn');
    await click('#transit-search-input');
    await click('.location-search-custom');
    const place = page.getByRole('textbox', { name: 'Search for a location' });
    await place.fill('Campus Library');
    await place.press('Enter');
    await page
      .locator('.location-search-dropdown')
      .waitFor({ state: 'hidden' });
  });
  await step('UC05 Filters, layers and route choice', async () => {
    await click('#layers-btn');
    await click('#zoom-in-btn');
    await click('#zoom-out-btn');
    await click('#system-filter-btn');
    await page.locator('#system-panel .filter-section').first().click();
    await activateFilter('#system-panel .cancel-btn');
    await click('#direction-filter-btn');
    await page.locator('#direction-panel .filter-section').first().click();
    await activateFilter('#direction-panel .ok-btn');
    await click('#clear-filters-btn');
    await click('#route-filter-btn');
    await page.locator('[data-picker-order]').selectOption('name');
    await page.locator('.route-search-input').fill('McKeesport');
    assert.match(await page.locator('.route-btn[data-route="61C"]').innerText(), /McKeesport/i);
    await page.locator('.route-search-input').press('Enter');
    await page.waitForURL(/r=61C/);
  });
  await step('UC06 Tap overlapping map objects and dismiss', async () => {
    await page.locator('#map').click({ position: { x: 170, y: 160 } });
    const choices = page.locator('.map-selection');
    await choices.waitFor();
    assert.ok((await choices.locator('.map-selection__choice').count()) >= 2);
    await page.keyboard.press('Escape');
  });
  await step('UC07 Search and open a platform', async () => {
    await page.locator('#transit-search-input').fill('7117');
    await click('.search-result-stop[data-stop-id="7117"]');
    await page.locator('.stop-arrival-board').waitFor();
  });
  await step('UC10+14 Stop arrivals, share, save and restore', async () => {
    const pop = page.locator('#map-popup');
    await pop.locator('.stop-arrival-board summary').click();
    await pop.locator('[data-clock]').check();
    const checked = fixture.events.checks;
    await Promise.all([
      page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname ===
            '/transit/stops/7117/predictions' && response.ok()
      ),
      pop.locator('[data-refresh]').click()
    ]);
    assert.ok(
      fixture.events.checks > checked,
      'Refresh made no predictions request'
    );
    await pop.locator('.map-popup__share-stop').click();
    assert.equal(
      await page.evaluate(() => window.sharedPublicLink),
      origin + '/#/map?stop=7117'
    );
    await pop.locator('.map-popup__save-stop').click();
    await pop.getByRole('button', { name: 'Minimize' }).click();
    await click('.map-popup-tab[data-type="stop"]');
    await page.locator('.stop-arrival-board').waitFor();
  });
  await step('UC12 Walk to stop and exit', async () => {
    await click('#map-popup [data-directions-label]');
    await page
      .locator('#directions-panel .directions-panel__duration')
      .waitFor();
    assert.match(await page.locator('.directions-panel__distance').innerText(), /210 m/);
    await click('[data-walk-action="steps"]');
    assert.match(await page.locator('#walk-details ol').innerText(), /Turn toward the platform/);
    await click('[data-walk-action="compact"]');
    assert.equal(await page.locator('#walk-details').isVisible(), false);
    await click('[data-walk-action="compact"]');
    await click('.directions-panel__close');
    await page.locator('#directions-panel').waitFor({ state: 'hidden' });
  });
  await step('UC08 Nearby stops and arrivals', async () => {
    await click('.nearby-stops__launch');
    const near = page.locator('nearby-stops-panel dialog[open]');
    await near.getByRole('searchbox').fill('Forbes');
    await near.locator('[data-stop-id]').first().waitFor();
    await near.getByRole('button', { name: 'Close nearby stops' }).click();
  });
  await step('UC13 Saved stops, places, history and views', async () => {
    await click('.rider-shortcuts__trigger');
    const places = page.locator('.rider-shortcuts-dialog[open]');
    await places.getByRole('tab', { name: /Saved stops/ }).click();
    await places.getByRole('searchbox').fill('7117');
    await places
      .getByText('Forbes at Campus', { exact: true })
      .first()
      .waitFor();
    await places.getByRole('tab', { name: /Places/ }).click();
    await places.getByRole('tab', { name: /Views/ }).click();
    await places.getByRole('tab', { name: /Recent/ }).click();
    await places.getByLabel('Recent item type').selectOption('stop');
    await places.getByRole('button', { name: 'Close My places' }).click();
  });
  await step('UC09+11 Explore route and follow selected vehicle', async () => {
    await go('/#/map?r=61C');
    await click('.route-explorer__trigger');
    const explorer = page.locator('route-explorer dialog[open]');
    await explorer.locator('[data-stops] button').first().waitFor();
    await explorer
      .getByRole('combobox', { name: 'Order stops' })
      .selectOption('distance');
    await explorer.getByRole('tab', { name: /Buses/ }).click();
    await explorer.locator('[data-buses] button').first().click();
    const follow = page.locator('.map-popup__action-btn--follow');
    await follow.click();
    assert.equal(await follow.getAttribute('aria-pressed'), 'true');
    await follow.click();
  });
  await step(
    'UC18 Review, edit and send a bus report to isolated endpoint',
    async () => {
      await click('.map-popup__action-btn--report');
      await page.getByRole('button', { name: 'Many seats open' }).click();
      await page
        .getByLabel('Report section')
        .selectOption({ label: 'Review report' });
      assert.equal(fixture.events.reports.length, 0);
      await page.getByRole('button', { name: 'Edit Crowding' }).click();
      await page
        .getByRole('button', { name: 'Standing room', exact: true })
        .click();
      await click('#bus-report-next');
      await page.getByRole('button', { name: 'Submit report' }).click();
      await page
        .locator('dialog.bus-report[open]')
        .waitFor({ state: 'hidden' });
      assert.equal(fixture.events.reports.length, 1);
      assert.equal(fixture.events.reports[0].crowdedness, 'Standing Room');
    }
  );
  await step('UC17 Read and dismiss a foreground notification', async () => {
    socket.notify();
    await page.locator('.live-notif-card').waitFor();
    await click('.live-notif-dismiss');
    await page.locator('.live-notif-card').waitFor({ state: 'hidden' });
  });
  await step('UC15 Saved routes, muting and agency picker', async () => {
    await go('/subscriptions');
    const bell = page.locator('.card-bell').first();
    await bell.click();
    assert.equal(await bell.getAttribute('aria-pressed'), 'true');
    await click('#add-route-btn');
    await page.locator('#sheet-system').selectOption('CMU');
    await page.locator('#sheet-unsaved').check();
    await page.locator('.result-add-btn').first().click();
    await click('#sheet-close');
    assert.equal(await page.locator('.card-bell').count(), 2);
  });
  await step('UC16 Filter and read a service alert', async () => {
    await go('/notifications');
    await click('#notif-more-options summary');
    await page.locator('#notif-route').selectOption('61C');
    await page.locator('#notif-severity').selectOption('elevated');
    await page
      .getByText('Forbes stop relocated', { exact: true })
      .first()
      .waitFor();
    await click('#notif-mark-shown-read');
    await click('#notif-undo');
    await click('#notif-reset');
  });
  await step('UC19 Account edit and cancel', async () => {
    await go('/account');
    await click('#edit-btn');
    await page.locator('#field-password').fill('NewDemo2!');
    await click('#cancel-btn');
    assert.equal(await page.locator('#field-password').isVisible(), false);
  });
  await step('UC02 Sign out', async () => {
    await click('#menu-icon');
    await click('#menu-logout-btn');
    await page.waitForURL(/\/auth/);
    assert.equal(
      await page.evaluate(() => localStorage.getItem('token')),
      null
    );
  });
  assert.deepEqual(failures, [], 'Uncaught browser exceptions');
  console.log(
    JSON.stringify({
      engine: desktop ? 'desktop Chrome' : 'iPhone 15 WebKit',
      assets: productionAssets ? 'published' : 'built',
      mapPageDigest: createHash('sha256')
        .update(assets.get('map.html'))
        .digest('hex'),
      steps: result.length,
      reported: fixture.events.reports.length,
      abortedPolls
    })
  );
} catch (error) {
  console.error(
    'Completed',
    result.length,
    'steps;',
    String(error.message).split('\n').slice(0, 19).join('\n'),
    failures
  );
  process.exitCode = 1;
} finally {
  await browser.close();
  await socket.close();
}

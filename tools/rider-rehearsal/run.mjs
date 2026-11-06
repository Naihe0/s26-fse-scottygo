import { rehearseWalkingOptions, rehearseWalkingRecovery } from './walking.mjs';
import { rehearseReadingList } from './reading-list.mjs';
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
import { rehearseMyPlaces } from './my-places.mjs';
import { rehearseDepartureWatch } from './departure-watch.mjs';
import { rehearsePopupPreferences } from './subscriptions.mjs';
import { rehearseRouteExplorer } from './route-explorer.mjs';
import { recordEvidence } from './evidence.mjs';

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
  const flowId = id.match(/^UC\d{2}(?:-A\d+)?/)[0];
  const outcome = {
    flowId: flowId.includes('-') ? flowId : flowId + '-M',
    action: id,
    method: 'interactive-browser-with-controlled-services',
    startedAt: new Date().toISOString(),
    status: 'running'
  };
  const started = Date.now();
  try {
    await action();
    assert.ok(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth
      ),
      'Horizontal overflow in ' + id
    );
    outcome.status = 'passed';
    console.log('PASS', id);
  } catch (error) {
    outcome.status = 'failed';
    outcome.error = error.message;
    throw error;
  } finally {
    outcome.durationMs = Date.now() - started;
    result.push(outcome);
  }
}
try {
  await go('/auth');
  await step(
    'UC01 Create an account, review identity and accept terms',
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
      await click('#show-register-btn');
      await page.locator('#reg-email').fill('campusrider@andrew.cmu.edu');
      await page.locator('#reg-password').fill('Demo1!');
      await page.locator('#reg-confirm-password').fill('Demo1!');
      await page.locator('#reg-confirm-password').blur();
      await page.locator('#tos').check();
      await click('#register-btn');
      assert.equal(
        await page.locator('#review-username').innerText(),
        'campusrider'
      );
      assert.equal(
        fixture.events.registrations.length,
        0,
        'Review must not create the account'
      );
      await click('#confirm-yes');
      await page.locator('#map[data-ready]').waitFor();
      assert.equal(fixture.events.registrations.length, 1);
      assert.deepEqual(fixture.events.agreements, ['campusrider']);
      await click('#menu-icon');
      await click('#menu-logout-btn');
      await page.waitForURL(/\/auth/);
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
    await click('[data-campus]');
    await click('#transit-search-input');
    assert.match(
      await page.locator('[data-current-start]').innerText(),
      /CMU campus/
    );
    await click('[data-center]');
    await click('#transit-search-input');
    assert.match(
      await page.locator('[data-current-start]').innerText(),
      /Map center/
    );
    await click('.location-search-custom');
    const place = page.getByRole('textbox', { name: 'Search for a location' });
    await place.fill('Campus Library');
    await page.locator('[data-place-result]').first().waitFor();
    await place.press('Enter');
    await page
      .locator('.location-search-dropdown')
      .waitFor({ state: 'hidden' });
  });
  await step('UC05 Filters, layers and route choice', async () => {
    await click('#layers-btn');
    const appearance = page.locator('.map-appearance[open]');
    await appearance.getByLabel('Base map').selectOption('satellite');
    await appearance.getByLabel('Map overlay').selectOption('transit');
    assert.equal(
      await page.locator('#map').getAttribute('data-map-type'),
      'hybrid'
    );
    await appearance.getByLabel('Base map').selectOption('road');
    await appearance.getByLabel('Stronger street labels').check();
    await appearance.getByRole('button', { name: 'Focus on map' }).click();
    assert.equal(
      await page.locator('#transit-search-input').isVisible(),
      false
    );
    assert.equal(await page.locator('#recenter-btn').isVisible(), true);
    await click('.map-focus-exit');
    await click('#layers-btn');
    await appearance.getByRole('button', { name: 'Reset appearance' }).click();
    await appearance
      .getByRole('button', { name: 'Close map appearance' })
      .click();
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
    assert.match(
      await page.locator('.route-btn[data-route="61C"]').innerText(),
      /McKeesport/i
    );
    await page.locator('.route-search-input').press('Enter');
    await page.waitForURL(/r=61C/);
  });
  await step(
    'UC06 Find an overlapping platform, line or bus and zoom here',
    async () => {
      // Opening the route after the keyboard Go action must keep its selection.
      await page
        .getByRole('button', { name: 'Explore stops and buses' })
        .click();
      const explorer = page.locator('route-explorer dialog[open]');
      await explorer.getByRole('tab', { name: /Buses/ }).click();
      await explorer.locator('[data-buses] button').first().waitFor();
      await explorer.getByRole('tab', { name: /Stops/ }).click();
      await explorer
        .getByRole('button', { name: 'Close route explorer' })
        .click();
      const routeCard = page.locator('#map-popup .map-popup__close');
      if (await routeCard.isVisible()) await routeCard.click();
      await page.locator('#map').click({ position: { x: 170, y: 160 } });
      const choices = page.locator('.map-selection');
      await choices.waitFor();
      assert.ok((await choices.locator('.map-selection__choice').count()) >= 2);
      const find = choices.getByRole('searchbox');
      const visible = choices.locator('.map-selection__choice:visible');
      await choices.getByRole('button', { name: 'Stops', exact: true }).click();
      await find.fill('7117');
      assert.equal(await visible.count(), 1);
      assert.match(await visible.innerText(), /Stop #7117/);
      await find.fill('McKeesport');
      assert.equal(await visible.count(), 0);
      await choices
        .getByRole('button', { name: 'Routes', exact: true })
        .click();
      assert.match(await visible.innerText(), /Route 61C[\s\S]*McKeesport/i);
      const zoom = Number(await page.locator('#map').getAttribute('data-zoom'));
      await choices.getByRole('button', { name: 'Zoom in here' }).click();
      await choices.waitFor({ state: 'hidden' });
      assert.equal(
        Number(await page.locator('#map').getAttribute('data-zoom')),
        Math.min(21, zoom + 2)
      );
      await page.locator('#map').click({ position: { x: 170, y: 160 } });
      await choices.getByRole('button', { name: 'Stops', exact: true }).click();
      await choices.getByRole('searchbox').fill('7117');
      await choices.locator('.map-selection__choice:visible').click();
      await page.locator('.stop-arrival-board').waitFor();
      assert.match(
        await page.locator('#map-popup .map-popup__title').innerText(),
        /Forbes/
      );
      await page.locator('#map-popup .map-popup__close').click();
    }
  );
  await step('UC07 Search and open a platform', async () => {
    await page.locator('#transit-search-input').fill('7117');
    await click('.search-result-stop[data-stop-id="7117"]');
    await page.locator('.stop-arrival-board').waitFor();
  });
  await step(
    'UC10 Compare, select, refresh and restore stop departures',
    async () => {
      const pop = page.locator('#map-popup');
      await pop.locator('.stop-arrival-board summary').click();
      const view = pop.getByLabel('Show departures');
      const boardRows = pop.locator('.stop-arrival-board [data-key]');
      await boardRows.first().click();
      await view.selectOption('selected');
      assert.equal(
        await boardRows.count(),
        1,
        'Only the chosen visit should be selected'
      );
      await view.selectOption('first');
      assert.equal(
        await boardRows.count(),
        1,
        'One next departure for fixture route 61C'
      );
      await view.selectOption('all');
      await pop.locator('[data-clear]').click();
      await pop.getByLabel('Time window').selectOption('15');
      await pop.getByLabel('Time window').selectOption('0');
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
      await pop.locator('.map-popup__save-stop').click();
      await rehearseDepartureWatch(page, fixture, desktop);
      await pop.getByRole('button', { name: 'Minimize' }).click();
      await click('.map-popup-tab[data-type="stop"]');
      await page.locator('.stop-arrival-board').waitFor();
    }
  );
  await step(
    'UC14 Share an exact platform and reopen through sign-in',
    async () => {
      await click('#map-popup .map-popup__share-stop');
      const link = await page.evaluate(() => window.sharedPublicLink);
      assert.equal(link, origin + '/#/map?stop=7117');
      await click('#menu-icon');
      await click('#menu-logout-btn');
      await page.waitForURL(/\/auth/);
      await go('/#/map?stop=7117');
      await page.waitForURL(/\/auth#\/map\?stop=7117/);
      await page.locator('#login-username').fill('rider');
      await page.locator('#login-password').fill('Demo1!');
      await click('#login-btn');
      await page.locator('.stop-arrival-board').waitFor();
      assert.equal(new URL(page.url()).hash, '#/map?stop=7117');
      assert.match(
        await page.locator('#map-popup .map-popup__title').innerText(),
        /Forbes/
      );
    }
  );
  await step('UC12 Walk to stop and exit', async () => {
    await page
      .locator('#map-popup .stop-arrival-board [data-key]')
      .first()
      .click();
    await click('#map-popup [data-directions-label]');
    await page
      .locator('#directions-panel .directions-panel__duration')
      .waitFor();
    await rehearseWalkingOptions({ page, fixture });
    await click('.directions-panel__close');
    await page.locator('#directions-panel').waitFor({ state: 'hidden' });
    await page.locator('#transit-search-input').fill('7117');
    await click('.search-result-stop[data-stop-id="7117"]');
    await page
      .locator('#map-popup .stop-arrival-board [data-key]')
      .first()
      .click();
    fixture.events.arrivalUnavailable = true;
    await click('#map-popup [data-refresh]');
    await page
      .locator('.arrival-recovery')
      .filter({ hasText: /paused/i })
      .waitFor();
    await click('#map-popup [data-directions-label]');
    await page
      .locator('#directions-panel .directions-panel__duration')
      .waitFor();
    assert.match(
      await page.locator('.directions-panel__distance').innerText(),
      /210 m/
    );
    await click('[data-walk-action="steps"]');
    assert.match(
      await page.locator('#walk-details ol').innerText(),
      /Turn toward the platform/
    );
    assert.match(
      await page.locator('.directions-panel__bus-list').innerText(),
      /ET · last known/
    );
    assert.equal(
      await page.locator('.directions-panel__connection').count(),
      0
    );
    await click('[data-walk-action="compact"]');
    assert.equal(await page.locator('#walk-details').isVisible(), false);
    await click('[data-walk-action="compact"]');
    await rehearseWalkingRecovery({ page, fixture });
    fixture.events.arrivalUnavailable = false;
  });
  await step('UC08 Nearby stops and arrivals', async () => {
    await click('.nearby-stops__launch');
    const near = page.locator('nearby-stops-panel dialog[open]');
    await near.getByRole('searchbox').fill('Forbes');
    await near.locator('[data-stop-id]').first().waitFor();
    const save = near.locator('.nearby-stop-save').first();
    const wasSaved = await save.getAttribute('aria-pressed');
    await save.click();
    assert.notEqual(await save.getAttribute('aria-pressed'), wasSaved);
    await save.click();
    await near.locator('.nearby-stops__settings summary').click();
    await near.getByLabel('Order stops').selectOption('boarding');
    await near.getByLabel('Connections').selectOption('transfer');
    await near.locator('[data-stop-id]').first().waitFor();
    await near.getByLabel('Connections').selectOption('all');
    await near.getByLabel('Order stops').selectOption('distance');
    await near.locator('[data-stop-id]').first().click();
    await page.locator('.stop-arrival-board').waitFor();
    assert.match(
      await page.locator('#map-popup .map-popup__title').innerText(),
      /Forbes/
    );
    await page.locator('#map-popup .map-popup__close').click();
  });
  await step('UC13 Saved stops, places, history and views', async () => {
    await click('.rider-shortcuts__trigger');
    const places = page.locator('.rider-shortcuts-dialog[open]');
    await rehearseMyPlaces(page, desktop);
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
    await places.getByRole('tab', { name: /Saved stops/ }).click();
    await places
      .locator('.rider-shortcuts__primary')
      .filter({ hasText: 'Forbes at Campus' })
      .click();
    await page.locator('.stop-arrival-board').waitFor();
    assert.match(
      await page.locator('#map-popup .map-popup__title').innerText(),
      /Forbes/
    );
  });
  await step('UC09 Explore route stops and choose a matching bus', async () => {
    await go('/#/map?r=61C');
    await click('.route-explorer__trigger');
    const explorer = page.locator('route-explorer dialog[open]');
    await rehearseRouteExplorer({ page, fixture, origin });
    await explorer
      .getByRole('combobox', { name: 'Order stops' })
      .selectOption('distance');
    await explorer.getByRole('tab', { name: /Buses/ }).click();
    await explorer.locator('[data-vehicle-tools] summary').click();
    await explorer.getByLabel('Find bus or reported stop').fill('7117');
    await explorer.getByLabel('Recent GPS only').check();
    await explorer.getByLabel('Order buses').selectOption('near');
    assert.match(
      await explorer.locator('[data-buses] li').first().innerText(),
      /4100[\s\S]*from start/
    );
    await explorer.locator('[data-buses] button').first().click();
    assert.match(
      await page.locator('#map-popup .map-popup__title').innerText(),
      /4100/
    );
  });
  await step('UC11 Inspect, minimize, restore and follow a bus', async () => {
    const busCard = page.locator('#map-popup');
    assert.match(
      await busCard.locator('.map-popup__subheader').innerText(),
      /Inbound/
    );
    assert.match(
      await busCard.locator('.bus-popup__route-name').innerText(),
      /McKeesport/
    );
    const next = busCard.locator('.bus-popup__next-stop');
    assert.match(await next.innerText(), /Next stop #7117.*Forbes/);
    assert.equal(
      new URL(await next.getAttribute('href'), origin).hash,
      '#/map?stop=7117'
    );
    await busCard.locator('summary').click();
    await busCard.getByLabel('Bus speed unit').selectOption('km/h');
    assert.match(
      await busCard.locator('.bus-reported-speed').innerText(),
      /7\.2 km\/h/
    );
    assert.match(await busCard.locator('.bus-gps-clock').innerText(), /E[DS]T/);
    assert.match(
      await busCard.locator('.bus-relative-distance').innerText(),
      /m · straight line to reported position/
    );
    await busCard.getByRole('button', { name: 'Minimize' }).click();
    await click('.map-popup-tab[data-type="bus"]');
    assert.equal(
      await busCard.getByLabel('Bus speed unit').inputValue(),
      'km/h'
    );
    await busCard.getByLabel('Bus speed unit').selectOption('mph');
    assert.match(
      await busCard.locator('.bus-reported-speed').innerText(),
      /4\.5 mph/
    );
    assert.match(
      await busCard.locator('.bus-popup__route-link').getAttribute('href'),
      /r=61C/
    );
    await busCard.locator('summary').click();
    const follow = page.locator('.map-popup__action-btn--follow');
    await follow.click();
    assert.equal(await follow.getAttribute('aria-pressed'), 'true');
    await follow.click();
  });
  await step(
    'UC18 Review, edit and send a bus report to isolated endpoint',
    async () => {
      await click('#layers-btn');
      await page
        .locator('.map-appearance[open]')
        .getByRole('button', { name: 'Focus on map' })
        .click();
      await click('.map-popup__action-btn--report');
      assert.equal(
        await page.locator('#transit-search-input').isVisible(),
        true
      );
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
      await click('.bus-popup__next-stop');
      await page.locator('.stop-arrival-board').waitFor();
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
    await rehearsePopupPreferences({ page, context, origin, socket });
  });
  await step('UC16 Filter and read a service alert', async () => {
    await go('/notifications');
    await click('#notif-more-options summary');
    const windowChoice = page.locator('#notif-window');
    const topicChoice = page.locator('#notif-topic');
    await windowChoice.selectOption('upcoming');
    await page.getByText('Weekend detour', { exact: true }).waitFor();
    assert.equal(await page.locator('.notif-card').count(), 1);
    await windowChoice.selectOption('');
    await topicChoice.selectOption('prioritySeating');
    await page
      .getByText('Priority seats available.', { exact: true })
      .waitFor();
    await topicChoice.selectOption('effect:STOP_MOVED');
    await page.locator('#notif-search-input').fill('7117');
    await page.getByText('Notice window open', { exact: true }).waitFor();
    const stopLink = page.getByRole('link', {
      name: 'View affected stop 7117 on map'
    });
    assert.equal(
      new URL(await stopLink.getAttribute('href'), origin).hash,
      '#/map?stop=7117'
    );
    await click('.notif-window summary');
    await page.getByText(/Pittsburgh time\. These are the agency/).waitFor();
    await page.locator('#notif-route').selectOption('61C');
    await page.locator('#notif-severity').selectOption('elevated');
    await page
      .getByText('Forbes stop relocated', { exact: true })
      .first()
      .waitFor();
    await click('#notif-mark-shown-read');
    await click('#notif-undo');
    await click('#notif-reset');
      await rehearseReadingList({ page, fixture });
  });
  await step(
    'UC19 Edit and persist profile then cancel a separate draft',
    async () => {
      await go('/account');
      await click('#edit-btn');
      await page.locator('#field-email').fill('rider.updated@andrew.cmu.edu');
      await page.locator('#field-email').blur();
      await click('#save-btn');
      await page.getByText('Changes saved!', { exact: true }).waitFor();
      assert.equal(fixture.events.accountWrites.length, 1);
      await page.reload();
      await page
        .getByText('rider.updated@andrew.cmu.edu', { exact: true })
        .waitFor();
      await click('#edit-btn');
      await page.locator('#field-password').fill('NewDemo2!');
      await click('#cancel-btn');
      assert.equal(await page.locator('#field-password').isVisible(), false);
    }
  );
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
  const covered = new Set(
    result.filter((r) => r.status === 'passed').map((r) => r.flowId)
  );
  for (let n = 1; n <= 19; n++)
    assert.ok(
      covered.has('UC' + String(n).padStart(2, '0') + '-M'),
      'Missing interactive primary UC' + n
    );
  await recordEvidence({
    engine: desktop ? 'desktop Chrome' : 'iPhone 15 WebKit',
    assets: productionAssets ? 'published' : 'built',
    mapPageDigest: createHash('sha256')
      .update(assets.get('map.html'))
      .digest('hex'),
    steps: result.length,
    flows: result,
    status: 'passed',
    scope:
      'Real client UI in browser; maps, GPS, feed and account writes use isolated controlled services. Native iPhone hardware and OS handoffs are not exercised.',
    reported: fixture.events.reports.length,
    abortedPolls
  });
} catch (error) {
  console.error(
    'Completed',
    result.length,
    'steps;',
    String(error.message).split('\n').slice(0, 19).join('\n'),
    failures
  );
  process.exitCode = 1;
  await recordEvidence({
    status: 'failed',
    engine: desktop ? 'desktop Chrome' : 'iPhone 15 WebKit',
    flows: result,
    error: error.message
  });
} finally {
  await browser.close();
  await socket.close();
}

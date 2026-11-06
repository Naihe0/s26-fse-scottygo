import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';

export async function rehearseDepartureWatch(page, fixture, desktop) {
  const pop = page.locator('#map-popup');
  const watch = pop.locator('.departure-watch');
  await pop.locator('[data-key]').first().click();
  await pop.locator('[data-watch-selected]').click();
  await watch.waitFor();
  assert.match(await watch.locator('[data-watch-countdown]').innerText(), /3 min/);
  assert.equal(await pop.locator('.map-popup__directions-btn').isVisible(), false);
  await watch.locator('[data-watch-reminder]').selectOption('5');
  await watch.locator('[data-watch-status]').filter({ hasText: 'expected within 5 min' }).waitFor();
  await watch.locator('[data-watch-next]').click();
  assert.match(await watch.locator('[data-watch-countdown]').innerText(), /8 min/);
  assert.equal(await watch.locator('[data-watch-reminder]').inputValue(), '5');
  await watch.locator('[data-watch-share]').click();
  const summary = await page.evaluate(() => window.sharedPublicSummary);
  assert.match(summary.text, /Route 61C[\s\S]*Forbes at Campus[\s\S]*Live estimate/);
  assert.equal(new URL(summary.url).hash, '#/map?stop=7117');
  assert.doesNotMatch(summary.text + summary.url, /token|latitude|longitude|rider@/i);

  // Healthy disappearance retains the watched visit. Outage retains its last
  // timestamp. Neither state may attach the card to another visit by this bus.
  fixture.events.arrivalMissingOccurrence = 8;
  await pop.locator('[data-refresh]').click();
  await watch.locator('[data-watch-status]').filter({ hasText: 'No longer' }).waitFor();
  assert.equal(await watch.locator('[data-watch-countdown]').innerText(), '—');
  assert.equal(await watch.locator('[data-watch-reminder]').isDisabled(), true);
  fixture.events.arrivalMissingOccurrence = null;
  await pop.locator('[data-refresh]').click();
  await watch.locator('[data-watch-countdown]').filter({ hasText: '8 min' }).waitFor();
  fixture.events.arrivalUnavailable = true;
  await pop.locator('[data-refresh]').click();
  await watch.locator('[data-watch-status]').filter({ hasText: 'Waiting for fresh' }).waitFor();
  fixture.events.arrivalUnavailable = false;
  await pop.getByRole('button', { name: 'Retry arrivals', exact: true }).click();
  await watch.locator('[data-watch-countdown]').filter({ hasText: '8 min' }).waitFor();
  await pop.getByRole('button', { name: 'Minimize', exact: true }).click();
  await page.locator('.map-popup-tab[data-type="stop"]').click();
  await watch.locator('[data-watch-countdown]').filter({ hasText: '8 min' }).waitFor();

  const viewport = page.viewportSize();
  await mkdir('output/playwright/flow-series', { recursive: true });
  for (const width of [320, 393, 430]) {
    await page.setViewportSize({ width, height: 700 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.screenshot({ path: `output/playwright/flow-series/flow-03-watch-${desktop ? 'desktop' : 'phone'}-${width}.png` });
  }
  await page.setViewportSize(viewport);
  await watch.locator('[data-watch-back]').click();
  await watch.waitFor({ state: 'hidden' });
  assert.match(await pop.locator('[data-directions-label]').innerText(), /1 bus/);
  await pop.locator('[data-clear]').click();
}

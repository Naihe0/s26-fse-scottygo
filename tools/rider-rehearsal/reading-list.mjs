import assert from 'node:assert/strict';

/** Keep a notice for the ride, follow its map link, then return and re-read it. */
export async function rehearseReadingList({ page, fixture }) {
  const more = page.locator('#notif-more-options');
  if (await more.getAttribute('open') !== null) await more.locator('summary').click();
  await page.locator('main.content').evaluate(el => { el.scrollTop = 0; });
  const card = page.locator('.notif-card[data-key="alert:61C-test"]');
  await card.waitFor();
  const top = (await card.boundingBox()).y;
  assert.ok(top < (await page.evaluate(() => innerHeight)) - 80, `First notice below usable first screen: ${top}`);
  await card.getByRole('button', { name: 'Save update to reading list' }).click();
  await page.locator('#notif-reading-list').click();
  assert.equal(await page.locator('.notif-card').count(), 1);
  assert.equal(await card.locator('.notif-saved-copy').count(), 0);
  await card.locator('.notif-window summary').click();
  const offset = await card.evaluate(el => el.getBoundingClientRect().top);
  await card.getByRole('link', { name: 'View Route 61C on map', exact: true }).click();
  await page.locator('#map[data-ready]').waitFor();
  await page.goBack({ waitUntil: 'domcontentloaded' });
  await card.waitFor();
  assert.equal(await page.locator('#notif-reading-list').getAttribute('aria-pressed'), 'true');
  assert.notEqual(await card.locator('.notif-window').getAttribute('open'), null);
  assert.ok(Math.abs(await card.evaluate(el => el.getBoundingClientRect().top) - offset) < 3);
  // A reload cannot rely on BFCache retaining the old DOM.
  await page.reload();
  await card.waitFor();
  assert.equal(await page.locator('#notif-reading-list').getAttribute('aria-pressed'), 'true');
  assert.notEqual(await card.locator('.notif-window').getAttribute('open'), null);
  fixture.events.hideAgencyAlerts = true;
  await page.locator('#notif-refresh').click();
  await card.getByText(/Saved copy · No longer in the current feed/).waitFor();
  assert.equal(await page.locator('.notif-card').count(), 1);
  await card.getByRole('button', { name: 'Remove from reading list' }).click();
  await page.getByText(/Your reading list is empty/).waitFor();
  fixture.events.hideAgencyAlerts = false;
  await page.locator('#notif-reading-list').click();
  await page.locator('#notif-refresh').click();
  await card.waitFor();
}

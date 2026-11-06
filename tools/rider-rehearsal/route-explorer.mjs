import assert from 'node:assert/strict';

/** Explore a transfer without abandoning the original platform search. */
export async function rehearseRouteExplorer({ page, fixture, origin }) {
  const explorer = page.locator('route-explorer dialog[open]');
  const search = explorer.getByRole('searchbox', {
    name: 'Search route stops'
  });
  const options = explorer.locator('[data-stop-options]');
  await explorer.locator('[data-explorer-stop]').first().waitFor();
  assert.equal(await options.getAttribute('open'), null);
  assert.match(
    await explorer.locator('[data-route-name]').innerText(),
    /McKeesport/
  );
  await search.fill('no matching stop');
  await explorer
    .getByText('No stops match your search.', { exact: true })
    .waitFor();
  assert.equal(
    await explorer.locator('.route-explorer__nearest').isVisible(),
    false
  );
  await explorer.locator('[data-clear-stops]').click();
  assert.equal(await search.inputValue(), '');
  await search.fill('Forbes');
  assert.match(
    await explorer.locator('.route-explorer__nearest').innerText(),
    /Forbes/
  );

  await options.locator('summary').click();
  await explorer
    .getByRole('combobox', { name: 'Route direction' })
    .selectOption('OUTBOUND');
  await explorer.locator('[data-explorer-stop="7117"]').waitFor();
  await explorer
    .getByRole('combobox', { name: 'Order stops' })
    .selectOption('distance');
  const row = explorer
    .locator('[data-stops] > li')
    .filter({ has: page.locator('[data-explorer-stop="7117"]') });
  const more = row.locator('details');
  await more.locator('summary').click();
  const save = row.locator('[data-explorer-save]');
  const initiallySaved = await save.getAttribute('aria-pressed');
  await save.click();
  assert.equal(
    await save.getAttribute('aria-pressed'),
    initiallySaved === 'true' ? 'false' : 'true'
  );
  await save.click();
  assert.equal(await save.getAttribute('aria-pressed'), initiallySaved);
  assert.notEqual(await more.getAttribute('open'), null);
  await page.evaluate(() => {
    window.sharedPublicLink = null;
  });
  await row.locator('[data-explorer-share]').click();
  assert.equal(
    await page.evaluate(() => window.sharedPublicLink),
    origin + '/#/map?stop=7117'
  );
  assert.equal(await explorer.isVisible(), true);

  const transfer = row.locator('[data-explore-transfer="CMU-1"]');
  await transfer.scrollIntoViewIfNeeded();
  const scroll = await explorer
    .locator('.route-explorer__body')
    .evaluate((el) => el.scrollTop);
  await transfer.click();
  await explorer
    .getByRole('heading', { name: 'Campus Shuttle', exact: true })
    .waitFor();
  await explorer.locator('[data-explorer-stop="7117"]').waitFor();
  assert.equal(await search.inputValue(), '7117');
  assert.match(
    await explorer.locator('[data-connection-context]').innerText(),
    /Forbes/
  );
  await explorer.locator('[data-route-back]').click();
  await explorer
    .getByRole('heading', { name: 'Route 61C', exact: true })
    .waitFor();
  await explorer.locator('[data-explorer-stop="7117"]').waitFor();
  assert.equal(await search.inputValue(), 'Forbes');
  assert.equal(
    await explorer
      .getByRole('combobox', { name: 'Route direction' })
      .inputValue(),
    'OUTBOUND'
  );
  assert.equal(
    await explorer.getByRole('combobox', { name: 'Order stops' }).inputValue(),
    'distance'
  );
  assert.notEqual(await options.getAttribute('open'), null);
  assert.notEqual(await more.getAttribute('open'), null);
  assert.equal(
    await more
      .locator('summary')
      .evaluate((el) => el === document.activeElement),
    true
  );
  const restored = await explorer
    .locator('.route-explorer__body')
    .evaluate((el) => ({
      top: el.scrollTop,
      max: el.scrollHeight - el.clientHeight
    }));
  const expectedScroll = Math.min(scroll, restored.max);
  assert.ok(
    Math.abs(restored.top - expectedScroll) <= 2,
    `Explorer scroll restored ${restored.top}, expected ${expectedScroll}`
  );

  // A successful empty response still needs a way to recover on a warm feed.
  await explorer.locator('[data-clear-stops]').click();
  fixture.events.emptyStopRoute = '61C';
  await explorer.locator('[data-refresh-stops]').click();
  await explorer
    .getByText('No stops available in this direction.', { exact: true })
    .waitFor();
  fixture.events.emptyStopRoute = null;
  await explorer.locator('[data-refresh-empty]').click();
  await explorer.locator('[data-explorer-stop="7117"]').waitFor();
  assert.equal(await explorer.locator('[data-explorer-stop]').count(), 2);
  await explorer.getByRole('tab', { name: /Buses/ }).click();
  await explorer.locator('[data-bus-overview]').click();
  await page.locator('route-explorer dialog').waitFor({ state: 'hidden' });
  await page
    .locator('[data-explore-route]:visible, .route-explorer__trigger:visible')
    .first()
    .click();
  await explorer.getByRole('tab', { name: 'Stops', exact: true }).click();
}

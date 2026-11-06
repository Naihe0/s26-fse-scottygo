import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';

/** Actual shared UI, isolated browser storage and controlled transit/Places. */
export async function rehearseMyPlaces(page, desktop) {
  const open = () => page.locator('.rider-shortcuts__trigger').click();
  const sheet = page.locator('.rider-shortcuts-dialog[open]');
  const more = async (name) => {
    const control = sheet.getByRole('button', { name: 'More actions for ' + name });
    if (await control.getAttribute('aria-expanded') !== 'true') await control.click();
  };
  await sheet.getByRole('tab', { name: 'Saved stops', exact: true }).click();
  await sheet.getByRole('searchbox').fill('');
  await more('Forbes at Campus');
  await sheet.getByRole('button', { name: 'Use as starting point' }).click();
  await page.locator('#transit-search-input').focus();
  await page.locator('[data-current-start]').filter({ hasText: 'Forbes at Campus' }).waitFor();
  await page.locator('[data-close-start]').click();
  await open();
  await sheet.getByRole('tab', { name: 'Places', exact: true }).click();
  await sheet.getByRole('textbox', { name: 'Place name', exact: true }).fill('Home rehearsal');
  await sheet.getByRole('button', { name: 'Change location', exact: true }).click();
  await page.getByText('Choose a place to save', { exact: true }).waitFor();
  await page.locator('[data-close-start]').click();
  assert.equal(await sheet.getByRole('textbox', { name: 'Place name', exact: true }).inputValue(), 'Home rehearsal');
  await sheet.getByRole('button', { name: 'Change location', exact: true }).click();
  await page.getByText('Choose a place to save', { exact: true }).waitFor();
  await page.locator('.location-search-custom').click();
  const placeSearch = page.getByRole('textbox', { name: 'Search for a location', exact: true });
  await placeSearch.fill('Campus Library');
  await page.locator('[data-place-result]').first().waitFor();
  await placeSearch.press('Enter');
  await sheet.getByText('Save planning location: Campus Library', { exact: true }).waitFor();
  assert.equal(await sheet.locator('.rider-shortcuts__row').count(), 0, 'Choosing a place with Enter must not submit the form');
  assert.equal(await sheet.getByRole('textbox', { name: 'Place name', exact: true }).inputValue(), 'Home rehearsal');
  // Choosing where to save must not start a trip or change the global origin.
  const plannedBeforeSave = await page.evaluate(() => {
    const key = Object.keys(localStorage).find(k => k.startsWith('scottygo:planned-location:v2:'));
    return key ? JSON.parse(localStorage.getItem(key)) : null;
  });
  assert.match(JSON.stringify(plannedBeforeSave), /Forbes at Campus/);
  await sheet.getByRole('button', { name: 'Save place', exact: true }).click();
  await more('Home rehearsal');
  await sheet.getByRole('button', { name: 'Find nearby stops', exact: true }).click();
  const near = page.locator('nearby-stops-panel dialog[open]');
  await near.locator('.nearby-stops__origin').filter({ hasText: 'Home rehearsal' }).waitFor();
  await near.getByRole('button', { name: 'Close nearby stops' }).click();
  await open();
  await more('Home rehearsal');
  await sheet.getByRole('button', { name: 'Remove Home rehearsal' }).click();
  await sheet.getByRole('button', { name: 'Undo', exact: true }).click();
  await sheet.getByRole('button', { name: 'More actions for Home rehearsal' }).waitFor();
  await sheet.getByRole('tab', { name: 'Saved stops', exact: true }).click();
  await more('Forbes at Campus');
  await sheet.getByRole('button', { name: 'Remove Forbes at Campus' }).click();
  await sheet.getByRole('button', { name: 'Find nearby stops', exact: true }).click();
  await near.locator('.nearby-stop-save').first().click();
  await near.getByRole('button', { name: 'Close nearby stops' }).click();
  await open();
  await sheet.getByRole('searchbox').fill('7117');
  await sheet.getByText('Forbes at Campus', { exact: true }).waitFor();
  await sheet.getByRole('tab', { name: 'Places', exact: true }).click();
  await more('Home rehearsal');
  await mkdir('output/playwright/flow-series', { recursive: true });
  await page.screenshot({ path: `output/playwright/flow-series/flow-01-places-${desktop ? 'desktop' : 'phone'}.png` });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  if (!desktop) {
    const initial = page.viewportSize();
    for (const [width, height] of [[320, 568], [375, 667], [430, 932], [852, 393]]) {
      await page.setViewportSize({ width, height });
      const bounds = await sheet.boundingBox();
      assert.ok(bounds && bounds.x >= -1 && bounds.y >= -1 && bounds.x + bounds.width <= width + 1 && bounds.y + bounds.height <= height + 1, `My places stays within ${width}×${height}`);
      assert.ok(await sheet.evaluate(el => el.scrollWidth <= el.clientWidth + 1), `No sheet overflow at ${width}×${height}`);
    }
    await page.setViewportSize(initial);
  }
  await sheet.getByRole('tab', { name: 'Saved stops', exact: true }).click();
}

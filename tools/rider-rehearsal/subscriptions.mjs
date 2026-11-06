import assert from 'node:assert/strict';

/** Real UI actions against disposable account data and the normal socket client. */
export async function rehearsePopupPreferences({
  page,
  context,
  origin,
  socket
}) {
  const card = page.locator('.subscription-card[data-route-id="61C"]');
  await card.locator('.card-popup-summary').click();
  await card.getByRole('button', { name: 'Pause for 1 hour' }).click();
  await card.locator('.card-popup-state[data-mode="paused"]').waitFor();
  const deadline = await card.locator('.card-popup-state').innerText();
  assert.match(deadline, /^Paused until /);
  await page.reload();
  await card.locator('.card-popup-state[data-mode="paused"]').waitFor();
  assert.equal(await card.locator('.card-popup-state').innerText(), deadline);
  assert.equal(await card.locator('details').getAttribute('open'), null);
  await card.locator('.card-popup-summary').click();
  await card.getByRole('button', { name: 'Resume popups now' }).click();
  await card.locator('.card-popup-state[data-mode="enabled"]').waitFor();

  const other = await context.newPage();
  const otherCard = other.locator('.subscription-card[data-route-id="61C"]');
  try {
    await other.goto(origin + '/subscriptions');
    await otherCard.locator('.card-popup-state[data-mode="enabled"]').waitFor();
    await card.getByRole('button', { name: 'Pause for 1 hour' }).click();
    await otherCard.locator('.card-popup-state[data-mode="paused"]').waitFor();
    await otherCard.locator('.card-popup-summary').click();
    await otherCard.getByRole('button', { name: 'Resume popups now' }).click();
    await card.locator('.card-popup-state[data-mode="enabled"]').waitFor();
    await socket.waitForSubscribers('61C', 2);
    socket.notify();
    await page.locator('.live-notif-card').waitFor();
    await other.locator('.live-notif-card').waitFor();
    await page.locator('.live-notif-dismiss').click();
  } finally {
    await other.close();
  }

  await card.getByRole('button', { name: 'Pause for 1 hour' }).click();
  const beforeRemoval = await card.locator('.card-popup-state').innerText();
  await card.locator('.card-remove').click();
  await card.waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: 'Undo removal' }).click();
  await card.locator('.card-popup-state[data-mode="paused"]').waitFor();
  assert.equal(
    await card.locator('.card-popup-state').innerText(),
    beforeRemoval
  );
  assert.equal(await page.locator('#subscription-undo').isVisible(), false);
}

import assert from 'node:assert/strict';

export async function rehearseWalkingOptions({ page, fixture }) {
  const panel = page.locator('#directions-panel');
  await panel.locator('.directions-panel__connection').first().waitFor();
  const steps = panel.locator('[data-walk-steps]');
  if (await steps.getAttribute('open') === null) await steps.locator('summary').click();
  await panel.locator('[data-walk-action="step-mode"]').click();
  await panel.locator('[data-walk-action="next-step"]').click();
  assert.equal(await panel.getAttribute('data-walk-step-index'), '1');
  assert.match(await panel.locator('.directions-panel__step-instruction').innerText(), /Turn toward the platform/);
  await panel.locator('[data-walk-action="options"]').click();
  const buffer = panel.getByRole('combobox', { name: 'Boarding buffer' });
  await buffer.selectOption('5');
  assert.equal(await buffer.inputValue(), '5');
  assert.equal(await panel.getAttribute('data-walk-step-index'), '1');
  assert.equal(await panel.getAttribute('data-focused-steps'), 'true');
  assert.notEqual(await panel.locator('[data-walk-options]').getAttribute('open'), null);
  const google = new URL(await panel.locator('[data-walk-action="google-maps"]').getAttribute('href'));
  const apple = new URL(await panel.locator('[data-walk-action="apple-maps"]').getAttribute('href'));
  assert.equal(google.searchParams.get('travelmode'), 'walking');
  assert.equal(apple.searchParams.get('mode'), 'walking');
  assert.equal(google.searchParams.get('destination'), apple.searchParams.get('destination'));
  if (await panel.locator('.directions-panel__origin').count()) {
    assert.equal(google.searchParams.get('origin'), apple.searchParams.get('source'));
    assert.ok(google.searchParams.get('origin'));
  } else assert.equal(google.searchParams.has('origin'), false);
  const before = fixture.events.checks;
  await panel.locator('[data-walk-action="refresh-arrivals"]').click();
  await panel.locator('[data-walk-freshness="current"]').waitFor();
  assert.ok(fixture.events.checks > before);
  assert.equal(await panel.getAttribute('data-walk-step-index'), '1');
  assert.equal(await buffer.inputValue(), '5');
  await buffer.selectOption('0');
}

export async function rehearseWalkingRecovery({ page, fixture }) {
  const panel = page.locator('#directions-panel');
  await panel.locator('[data-walk-freshness="paused"]').waitFor();
  fixture.events.arrivalUnavailable = false;
  fixture.events.arrivalMissingOccurrence = 3;
  await panel.locator('[data-walk-action="refresh-arrivals"]').click();
  await panel.getByText(/1 no longer reported/).waitFor();
  assert.equal(await panel.locator('.directions-panel__connection').count(), 0);
  assert.match(await panel.locator('.directions-panel__bus-list').innerText(), /last known/);
  fixture.events.arrivalMissingOccurrence = null;
  await panel.locator('[data-walk-action="refresh-arrivals"]').click();
  await panel.locator('.directions-panel__connection').first().waitFor();
  assert.equal(await panel.locator('.directions-panel__freshness').innerText().then(t => t.includes('no longer reported')), false);
  await panel.locator('[data-walk-action="compact"]').click();
  assert.equal(await panel.locator('#walk-details').isVisible(), false);
  await panel.locator('[data-walk-action="arrivals"]').click();
  await panel.waitFor({ state: 'hidden' });
  const board = page.locator('#map-popup .stop-arrival-board');
  await board.waitFor();
  assert.match(await page.locator('#map-popup').innerText(), /7117/);
  await page.locator('#map-popup .map-popup__close').click();
}

// Read-only UC20 acceptance. Set PLAYWRIGHT_MODULE to an installed Playwright
// package path when it is available via the CLI cache rather than node_modules.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { recordEvidence } from './evidence.mjs';

const require = createRequire(import.meta.url);
const { webkit, devices } = require(
  process.env.PLAYWRIGHT_MODULE || 'playwright'
);
const origin =
  process.env.DASHBOARD_ORIGIN || 'https://scottygo-ningrui.onrender.com';
const browser = await webkit.launch();
try {
  const page = await browser.newPage(devices['iPhone 15']);
  const health = await page.request.get(
    new URL('/transit/health', origin).href
  );
  assert.equal(health.status(), 200);
  const { revision, overall } = await health.json();
  await page.goto(new URL('/transit/memory/dashboard', origin).href);
  await page
    .getByRole('heading', { name: 'ScottyGo Memory Dashboard' })
    .waitFor();
  await page.getByRole('status').filter({ hasText: 'Updated' }).waitFor();
  const limit = page.getByRole('spinbutton', { name: 'Sample limit' });
  await limit.fill('10');
  await page
    .getByRole('spinbutton', { name: 'Auto-refresh seconds' })
    .fill('120');
  await Promise.all([
    page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === '/transit/memory/summary' &&
        new URL(response.url()).searchParams.get('limit') === '10' &&
        response.ok()
    ),
    page.getByRole('button', { name: 'Reload now' }).click()
  ]);
  await page.getByRole('status').filter({ hasText: 'Updated' }).waitFor();
  await page.getByRole('button', { name: 'RSS max', exact: true }).click();
  await page
    .getByRole('status')
    .filter({ hasText: 'Metric selected' })
    .waitFor();
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Download CSV' }).click()
  ]);
  const csv = await readFile(await download.path(), 'utf8');
  assert.match(csv, /^"timestamp","reason","rssMb"/);
  const rows = csv.trim().split('\n').length - 1;
  assert.ok(rows > 0 && rows <= 10);
  await recordEvidence({
    status: 'passed',
    useCase: 'UC20',
    flowId: 'UC20-A2',
    actor: 'operator',
    method: 'interactive-browser-live-read-only',
    action:
      'Open dashboard, set limit and refresh interval, reload, inspect RSS max, export CSV and validate rows',
    revision,
    overall,
    exportedSamples: rows
  });
} finally {
  await browser.close();
}

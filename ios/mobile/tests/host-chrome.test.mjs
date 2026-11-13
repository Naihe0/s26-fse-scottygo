import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { CANVAS_COLOR, HEADER_COLOR, statusBarStyle } from '../hostChrome.ts';

test('native chrome colors match the web header and canvas tokens', async () => {
  const css = await readFile(
    new URL('../../../client/styles/shared.css', import.meta.url),
    'utf8'
  );
  const token = (name) =>
    css.match(new RegExp(`--${name}:\\s*(#[0-9a-f]{6})`, 'i'))?.[1];
  assert.equal(HEADER_COLOR.toLowerCase(), token('app-brand-strong'));
  assert.equal(CANVAS_COLOR.toLowerCase(), token('app-canvas'));
});

test('the web page draws its own safe-area insets for the edge-to-edge host', async () => {
  const css = await readFile(
    new URL('../../../client/styles/shared.css', import.meta.url),
    'utf8'
  );
  assert.match(css, /\.app-header\s*\{[^}]*env\(safe-area-inset-top/);
  assert.match(
    css,
    /--app-tabbar-height:\s*calc\(58px \+ env\(safe-area-inset-bottom/
  );
  // Without viewport-fit=cover WebKit letterboxes a page inside the safe
  // area, leaving light status-bar text over a blank strip.
  for (const name of [
    'auth',
    'map',
    'subscriptions',
    'notifications',
    'account'
  ]) {
    const page = await readFile(
      new URL(`../../../client/pages/${name}.html`, import.meta.url),
      'utf8'
    );
    assert.match(page, /viewport-fit=cover/, name);
  }
});

test('status bar text contrasts with the screen behind it', () => {
  assert.equal(statusBarStyle('page'), 'light-content');
  assert.equal(statusBarStyle('error'), 'dark-content');
});

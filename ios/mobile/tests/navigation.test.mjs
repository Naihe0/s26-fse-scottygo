import assert from 'node:assert/strict';
import test from 'node:test';
import {
  APP_URL,
  isAppURL,
  isPageHttpError,
  navigationDecision
} from '../navigationPolicy.ts';

test('sign-in redirects and stop deep links stay in the first-party WebView', () => {
  for (const path of [
    'auth?returnTo=%2F',
    '#/map?stop=7117',
    'notifications'
  ]) {
    assert.equal(
      navigationDecision({
        url: APP_URL + path,
        isTopFrame: true,
        navigationType: 'other'
      }),
      'allow'
    );
  }
  assert.ok(isAppURL('https://SCOTTYGO-NINGRUI.onrender.com:443/#/map'));
});

test('a rider can tap an alert link in either the current window or a new one', () => {
  for (const hasTargetFrame of [true, false, undefined]) {
    const request = {
      url: 'https://www.rideprt.org/alerts/',
      navigationType: 'click',
      hasTargetFrame
    };
    assert.equal(navigationDecision(request), 'openExternal');
    assert.equal(navigationDecision({ ...request, url: APP_URL }), 'allow');
    assert.equal(
      navigationDecision({ ...request, navigationType: 'other' }),
      'cancel'
    );
  }
  assert.equal(
    navigationDecision({
      url: APP_URL,
      hasTargetFrame: false,
      navigationType: 'other'
    }),
    'cancel'
  );
});

test('maps may embed secure subframes without replacing the app or opening a browser', () => {
  for (const url of [
    'about:blank',
    'about:srcdoc',
    'https://maps.googleapis.com/maps/embed',
    'https://www.google.com/maps/'
  ]) {
    const frame = {
      url,
      isTopFrame: false,
      hasTargetFrame: true,
      navigationType: 'other'
    };
    assert.equal(navigationDecision(frame), 'allow');
    assert.equal(navigationDecision({ ...frame, isTopFrame: true }), 'cancel');
    assert.equal(
      navigationDecision({ ...frame, hasTargetFrame: false }),
      'cancel'
    );
  }
});

test('foreign origins and unsafe URL schemes cannot acquire the embedded app origin', () => {
  for (const url of [
    'http://scottygo-ningrui.onrender.com',
    'https://scottygo-ningrui.onrender.com.evil.test',
    'https://scottygo-ningrui.onrender.com:444',
    'https://scottygo-ningrui.onrender.com@evil.test'
  ]) {
    assert.equal(isAppURL(url), false);
    assert.equal(
      navigationDecision({ url, isTopFrame: true, navigationType: 'other' }),
      'cancel'
    );
  }
  for (const url of [
    'file:///test',
    'javascript:alert(1)',
    'data:text/html,x',
    'tel:911',
    'https://user:password@example.org',
    'https://a.test\\@b.test',
    'invalid'
  ]) {
    assert.equal(
      navigationDecision({ url, navigationType: 'click' }),
      'cancel'
    );
  }
});

test('only a failed active page is replaced by the retry screen', () => {
  const page = APP_URL + 'auth';
  assert.ok(isPageHttpError(page, 503, page + '#login'));
  assert.equal(isPageHttpError(page, 200, page), false);
  assert.equal(
    isPageHttpError('https://maps.googleapis.com/error', 403, page),
    false
  );
  assert.equal(isPageHttpError(APP_URL, 502, page), false);
});

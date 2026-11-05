import assert from 'node:assert/strict';
import test from 'node:test';
import { ContentRecovery } from '../contentRecovery.ts';

test('only a discarded page reloads on return; duplicate foreground events do nothing', () => {
  const recovery = new ContentRecovery();
  assert.equal(recovery.resume(500), 'wait');
  assert.equal(recovery.terminated(false, 1000), 'wait');
  assert.equal(recovery.terminated(false, 2000), 'wait');
  assert.equal(recovery.resume(3000), 'restore');
  assert.equal(recovery.resume(3001), 'wait');
});

test('foreground discards recover once with an explicit retry after a rapid recurrence', () => {
  const recovery = new ContentRecovery();
  assert.equal(recovery.terminated(true, 0), 'restore');
  assert.equal(recovery.terminated(true, 1000), 'offer-retry');
  assert.equal(recovery.terminated(true, 60000), 'restore');
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { extractBridgeOption, PEER_GROUPS } from './peers-cli.js';
import { classifyHttp } from './security/bridge/permissions.js';

test('--bridge is taken from anywhere before --, in both spellings, and the last one wins', () => {
  assert.deepEqual(extractBridgeOption(['list', '--bridge', 'desk']), { args: ['list'], target: 'desk' });
  assert.deepEqual(extractBridgeOption(['--bridge=desk', 'screen', 'abc', '-n', '20']), { args: ['screen', 'abc', '-n', '20'], target: 'desk' });
  assert.deepEqual(extractBridgeOption(['list', '--bridge', 'a', '--bridge=b']), { args: ['list'], target: 'b' });
  assert.deepEqual(extractBridgeOption(['list']), { args: ['list'], target: null });
});

test('text after -- is never read as --bridge', () => {
  assert.deepEqual(extractBridgeOption(['keys', 'abc', '--', '--bridge', 'x']), { args: ['keys', 'abc', '--', '--bridge', 'x'], target: null });
});

test('--bridge without a value is an error', () => {
  assert.throws(() => extractBridgeOption(['list', '--bridge']), /requires a bridge/);
  assert.throws(() => extractBridgeOption(['list', '--bridge', '--json']), /requires a bridge/);
  assert.throws(() => extractBridgeOption(['list', '--bridge=']), /requires a bridge/);
});

test('forwarding covers the session-control groups, never local-machine or security ones', () => {
  for (const group of ['sessions', 'board', 'events', 'worktrees', 'plan', 'brief', 'attention', 'status']) assert.ok(PEER_GROUPS.has(group), group);
  for (const group of ['security', 'setup', 'start', 'env', 'accounts', 'quota', 'harness', 'bridges']) assert.ok(!PEER_GROUPS.has(group), group);
});

test('the peers routes are classified: list is read, forwarding is control, anything else is refused', () => {
  assert.equal(classifyHttp('GET', '/api/peers').permission, 'read');
  assert.equal(classifyHttp('GET', '/api/peers?probe=1').permission, 'read');
  assert.equal(classifyHttp('POST', '/api/peers/http').permission, 'control');
  assert.throws(() => classifyHttp('POST', '/api/peers'));
  assert.throws(() => classifyHttp('GET', '/api/peers?other=1'));
  assert.throws(() => classifyHttp('GET', '/api/peers/http'));
  assert.throws(() => classifyHttp('POST', '/api/peers/http?x=1'));
});

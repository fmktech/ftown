import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { CentrifugoClient } from './centrifugo-client.js';
import { securityNudge, securityNudgeChannel } from './security/security-nudge.js';

const email = 'owner@example.test';
function fixture() {
  const subscriptions = new Map<string, EventEmitter>();
  const transport = Object.assign(new EventEmitter(), { state: 'connected', removeSubscription: () => {}, newSubscription: (channel: string) => {
    const sub = Object.assign(new EventEmitter(), { subscribe() {}, unsubscribe() {} }); subscriptions.set(channel, sub); return sub;
  } });
  const client = new CentrifugoClient('ws://127.0.0.1:1/unused', '', async () => '');
  Object.defineProperty(client, 'client', { value: transport });
  client.joinBridgesChannel(email, 'bridge');
  const scopes: string[] = [];
  const off = client.onSecurityNudge(scope => { scopes.push(scope); });
  const health: boolean[] = [];
  client.onSecurityNudgeHealth(h => { health.push(h); });
  return { client, transport, health, sub: subscriptions.get(securityNudgeChannel(email))!, scopes, off, subscriptions };
}

test('security nudge channel is subscribed alongside presence', () => {
  const f = fixture();
  assert.ok(f.subscriptions.has(`bridges:presence#${email}`));
  assert.ok(f.sub);
});

test('owner account nudge emits; approvals nudge does not', () => {
  const f = fixture();
  f.sub.emit('publication', { info: { user: email }, data: securityNudge('account') });
  assert.deepEqual(f.scopes, ['account']);
  f.sub.emit('publication', { info: { user: email }, data: securityNudge('approvals') });
  assert.deepEqual(f.scopes, ['account']);
});

test('non-owner, missing info and invalid data are ignored', () => {
  const f = fixture();
  const good = securityNudge('account');
  for (const info of [undefined, {}, { user: '' }, { user: 'other@example.test' }]) f.sub.emit('publication', { info, data: good });
  for (const data of [null, 'x', {}, { ...good, extra: 1 }, { ...good, version: 2 }, { ...good, scope: 'other' }]) f.sub.emit('publication', { info: { user: email }, data });
  assert.deepEqual(f.scopes, []);
});

test('every subscribed event resyncs account', () => {
  const f = fixture();
  f.sub.emit('subscribed', {}); f.sub.emit('subscribed', {});
  assert.deepEqual(f.scopes, ['account', 'account']);
});

test('unregistering stops delivery', () => {
  const f = fixture();
  f.off();
  f.sub.emit('subscribed', {});
  f.sub.emit('publication', { info: { user: email }, data: securityNudge('account') });
  assert.deepEqual(f.scopes, []);
});

test('health: initial false, tracks subscribed/unsubscribed/subscribing, client disconnect', () => {
  const f = fixture();
  assert.equal(f.client.securityNudgeHealthy, false);
  f.sub.emit('subscribed', {});
  assert.equal(f.client.securityNudgeHealthy, true);
  f.sub.emit('unsubscribed', { code: 103, reason: 'permission denied' });
  assert.equal(f.client.securityNudgeHealthy, false);
  f.sub.emit('subscribing', {});
  f.sub.emit('subscribed', {});
  f.transport.emit('disconnected', {});
  assert.equal(f.client.securityNudgeHealthy, false);
  f.sub.emit('subscribed', {});
  f.transport.emit('connecting', {});
  assert.equal(f.client.securityNudgeHealthy, false);
  assert.deepEqual(f.health, [true, false, false, true, false, true, false]);
  assert.deepEqual(f.scopes, ['account', 'account', 'account']);
});

test('health listener unregisters', () => {
  const f = fixture();
  const seen: boolean[] = [];
  const off = f.client.onSecurityNudgeHealth(h => { seen.push(h); });
  f.sub.emit('subscribed', {});
  off();
  f.sub.emit('unsubscribed', { code: 103, reason: 'x' });
  assert.deepEqual(seen, [true]);
});

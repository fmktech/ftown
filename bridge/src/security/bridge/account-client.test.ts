import assert from 'node:assert/strict';
import { test } from 'node:test';
import { accountReadUrl, AccountReadUnavailable, readAccountHistory } from './account-client.js';
import { createAccountGenesis, generateAccountSigningIdentity, signAccountTransition, verifyAccountHistory } from '../account-crypto.js';
import { generateEndpoint } from '../crypto.js';
import type { AccountHistory, AccountOperation } from '../account-protocol.js';
import { AccountBridgeRevoked } from './revocation.js';

const ownerId = '349f8d2e-38e4-4d59-888d-687dcfa19e39';

// genesis(0), add A(1), revoke A(2): a real verified history whose revoke_bridge is the last transition.
async function revokedHistory(): Promise<AccountHistory> {
  const now = Date.now();
  const first = await generateEndpoint(ownerId, 'browser');
  const signing = await generateAccountSigningIdentity();
  let history: AccountHistory = { genesis: await createAccountGenesis(ownerId, first.endpoint, signing, 'First', now), transitions: [] };
  const states = [await verifyAccountHistory(history, null, now)];
  const operations: AccountOperation[] = [
    { type: 'add_bridge', bridge: { bridgeId: 'A', endpoint: (await generateEndpoint(ownerId, 'bridge')).endpoint, label: 'A', approvedAt: new Date(now).toISOString() } },
    { type: 'revoke_bridge', bridgeId: 'A' },
  ];
  for (const operation of operations) {
    const at = now + history.transitions.length + 1;
    const record = await signAccountTransition(states[states.length - 1], first.endpoint.id, signing, operation, at);
    history = { ...history, transitions: [...history.transitions, record] };
    states.push(await verifyAccountHistory(history, states[states.length - 1], at));
  }
  return history;
}

const revokedBody = (history: AccountHistory) => JSON.stringify({ error: 'bridge_revoked', history });
const respond = (body: string, status: number): typeof fetch => async () => new Response(body, { status });

test('account reader permits only operator HTTPS or exact trustworthy loopback HTTP origins', () => {
  for (const origin of ['https://account.example', 'http://localhost:3000', 'http://127.0.0.1:3000', 'http://[::1]:3000']) {
    assert.equal(accountReadUrl(origin).pathname, '/api/security/account');
  }
  for (const origin of ['http://account.example', 'http://localhost.evil.test', 'http://127.1.evil.test',
    'http://127.1', 'http://2130706433', 'https://user:secret@account.example', 'https://account.example/?returnTo=evil',
    'https://account.example/#secret', 'https://account.example/?', 'file:///tmp/account']) {
    assert.throws(() => accountReadUrl(origin), { code: 'invalid_account_trust' });
  }
});

test('account reader sends the supplied current credential only to configured URL and never follows redirects', async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl: typeof fetch = async (url, init) => {
    requests.push({ url: String(url), init });
    return new Response(JSON.stringify({ history: null }), { status: 200 });
  };
  assert.equal(await readAccountHistory('https://account.example', 'current-credential', undefined, fetchImpl), null);
  assert.equal(requests[0].url, 'https://account.example/api/security/account');
  assert.equal((requests[0].init?.headers as Record<string, string>).Authorization, 'Bearer current-credential');
  assert.equal(requests[0].init?.redirect, 'manual');
  let count = 0;
  await assert.rejects(readAccountHistory('https://account.example', 'secret', undefined, async () => {
    count++; return new Response(null, { status: 302, headers: { Location: 'https://attacker.test' } });
  }), AccountReadUnavailable);
  assert.equal(count, 1);
});

test('invalid successful responses fail trust validation, bounded bodies cannot become availability-only failures', async () => {
  for (const body of ['not-json', JSON.stringify({ history: null, extra: true }), JSON.stringify({ history: {} })]) {
    await assert.rejects(readAccountHistory('https://account.example', 'secret', undefined,
      async () => new Response(body, { status: 200 })), { code: 'invalid_account_trust' });
  }
  await assert.rejects(readAccountHistory('https://account.example', 'secret', undefined,
    async () => new Response('', { headers: { 'content-length': '999999999' } })), { code: 'account_capacity_exceeded' });
  await assert.rejects(readAccountHistory('https://account.example', 'secret', undefined, async () => { throw new Error('private-network-detail'); }),
    error => error instanceof AccountReadUnavailable && !error.message.includes('private-network-detail'));
  await assert.rejects(readAccountHistory('https://account.example', 'secret', undefined,
    async () => new Response(new ReadableStream({ start(controller) { controller.error(new Error('private-stream-failure')); } }))), AccountReadUnavailable);
});

test('200 still returns the parsed history or null', async () => {
  const history = await revokedHistory();
  assert.equal(await readAccountHistory('https://account.example', 'secret', undefined, respond(JSON.stringify({ history: null }), 200)), null);
  assert.deepEqual(await readAccountHistory('https://account.example', 'secret', undefined,
    respond(JSON.stringify({ history }), 200)), history);
});

test('401 with a valid bridge_revoked body throws AccountBridgeRevoked carrying the evidence', async () => {
  const history = await revokedHistory();
  let caught: unknown;
  await readAccountHistory('https://account.example', 'secret', undefined, respond(revokedBody(history), 401)).catch(error => { caught = error; });
  assert.ok(caught instanceof AccountBridgeRevoked);
  assert.deepEqual(caught.evidence, history);
});

test('401 with an unrelated error body throws AccountReadUnavailable', async () => {
  await assert.rejects(readAccountHistory('https://account.example', 'secret', undefined,
    respond(JSON.stringify({ error: 'unauthorized' }), 401)), AccountReadUnavailable);
});

test('401 with a non-JSON body throws AccountReadUnavailable', async () => {
  await assert.rejects(readAccountHistory('https://account.example', 'secret', undefined, respond('not-json', 401)), AccountReadUnavailable);
});

test('401 whose body cannot be read throws AccountReadUnavailable', async () => {
  await assert.rejects(readAccountHistory('https://account.example', 'secret', undefined,
    async () => new Response(new ReadableStream({ start(controller) { controller.error(new Error('private-stream-failure')); } }), { status: 401 })),
    AccountReadUnavailable);
});

test('403 and 500 throw AccountReadUnavailable even when the body carries revocation evidence', async () => {
  const body = revokedBody(await revokedHistory());
  for (const status of [403, 500]) {
    await assert.rejects(readAccountHistory('https://account.example', 'secret', undefined, respond(body, status)), AccountReadUnavailable);
  }
});

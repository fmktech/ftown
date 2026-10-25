import assert from 'node:assert/strict';
import { test } from 'node:test';
import { accountReadUrl, AccountReadUnavailable, readAccountHistory } from './account-client.js';

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

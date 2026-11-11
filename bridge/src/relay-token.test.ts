import assert from 'node:assert/strict';
import { test } from 'node:test';
import { UnauthorizedError } from 'centrifuge';
import { createRelayTokenFetcher } from './relay-token.js';
import { generateAuthKey, parseAuthProof, verifyAuthProof } from './security/ledger/proof.js';
import type { LedgerCheckpoint } from './security/ledger/protocol.js';

const API = 'https://ftown.example.com';
const ACCOUNT = 'A'.repeat(43);
const BRIDGE = 'bridge-1';

async function setup() {
  const key = await generateAuthKey(true);
  const checkpoint: LedgerCheckpoint = {
    version: 2, accountId: ACCOUNT, revision: 1, head: 'h', authorities: [], devices: [],
    bridges: [{ bridgeId: BRIDGE, endpoint: { version: 1, id: 'e', ownerId: ACCOUNT, kind: 'bridge', publicKey: 'k' }, authPublicKey: key.publicKey, label: 'b', approvedAt: 1 }],
    revokedDeviceIds: [], revokedBridgeIds: [], revokedCredentialIds: [],
  } as unknown as LedgerCheckpoint;
  return { key, checkpoint };
}

interface Call { url: string; body: Record<string, unknown> }
function fakeFetch(relay: { status: number; body: unknown; raw?: string }, nonce: { status: number; body: unknown } = { status: 200, body: { nonce: 'n'.repeat(43), expiresAt: 1 } }) {
  const calls: Call[] = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    calls.push({ url: u, body: JSON.parse(String(init?.body)) as Record<string, unknown> });
    const r = u.endsWith('/api/auth/nonce') ? nonce : relay;
    const text = 'raw' in r && r.raw !== undefined ? r.raw : JSON.stringify(r.body);
    return new Response(text, { status: r.status });
  }) as typeof fetch;
  return { impl, calls };
}

function deps(key: CryptoKey, f: typeof fetch, extra: Partial<Parameters<typeof createRelayTokenFetcher>[0]> = {}) {
  return { apiUrl: API, accountId: () => ACCOUNT, bridgeId: BRIDGE, authPrivateKey: key, head: () => 'head-1', onLedger: async () => {}, onRevoked: async () => {}, fetchImpl: f, ...extra };
}

test('happy path sends a verifiable relay proof with the exact audience', async () => {
  const { key, checkpoint } = await setup();
  const { impl, calls } = fakeFetch({ status: 200, body: { token: 'jwt', expiresAt: 99 } });
  const out = await createRelayTokenFetcher(deps(key.privateKey, impl))();
  assert.deepEqual(out, { token: 'jwt', expiresAt: 99 });
  assert.equal(calls[0].url, `${API}/api/auth/nonce`);
  assert.deepEqual(calls[0].body, { purpose: 'relay' });
  assert.equal(calls[1].url, `${API}/api/auth/relay-token`);
  assert.equal(calls[1].body.head, 'head-1');
  const proof = parseAuthProof(calls[1].body.proof);
  assert.ok(proof);
  assert.equal(proof.audience, API);
  assert.equal(proof.kind, 'bridge');
  assert.equal(proof.purpose, 'relay');
  assert.equal(proof.keyId, BRIDGE);
  assert.equal(proof.nonce, 'n'.repeat(43));
  assert.equal(await verifyAuthProof(checkpoint, proof, { audience: API, purpose: 'relay' }), true);
  assert.equal(await verifyAuthProof(checkpoint, proof, { audience: 'https://evil.example', purpose: 'relay' }), false);
});

test('audience is the origin of apiUrl, ignoring path and trailing slash', async () => {
  const { key } = await setup();
  const { impl, calls } = fakeFetch({ status: 200, body: { token: 'jwt', expiresAt: 1 } });
  await createRelayTokenFetcher(deps(key.privateKey, impl, { apiUrl: `${API}/` }))();
  assert.equal(calls[1].url, `${API}/api/auth/relay-token`);
  assert.equal(parseAuthProof(calls[1].body.proof)?.audience, API);
});

test('null head is sent as null', async () => {
  const { key } = await setup();
  const { impl, calls } = fakeFetch({ status: 200, body: { token: 'jwt', expiresAt: 1 } });
  await createRelayTokenFetcher(deps(key.privateKey, impl, { head: () => null }))();
  assert.equal(calls[1].body.head, null);
});

test('ledger is delivered (and awaited) before the token is returned', async () => {
  const { key } = await setup();
  const { impl } = fakeFetch({ status: 200, body: { token: 'jwt', expiresAt: 5, ledger: { x: 1 } } });
  const events: string[] = [];
  const fetcher = createRelayTokenFetcher(deps(key.privateKey, impl, {
    onLedger: async ledger => {
      assert.deepEqual(ledger, { x: 1 });
      await new Promise(resolve => setTimeout(resolve, 20));
      events.push('ledger');
    },
  }));
  await fetcher().then(() => events.push('returned'));
  assert.deepEqual(events, ['ledger', 'returned']);
});

test('no ledger in the response does not call onLedger', async () => {
  const { key } = await setup();
  const { impl } = fakeFetch({ status: 200, body: { token: 'jwt', expiresAt: 5 } });
  let called = false;
  await createRelayTokenFetcher(deps(key.privateKey, impl, { onLedger: async () => { called = true; } }))();
  assert.equal(called, false);
});

test('an answer without a ledger reports the server head: the one sent, or the one the answer names; never with a ledger or a failure', async () => {
  const { key } = await setup();
  const seen: unknown[] = [];
  const onServerHead = (server: { head: string | null; revision: number | null }) => { seen.push(server); };
  await createRelayTokenFetcher(deps(key.privateKey, fakeFetch({ status: 200, body: { token: 'jwt', expiresAt: 5 } }).impl, { onServerHead }))();
  assert.deepEqual(seen, [{ head: 'head-1', revision: null }]);
  await createRelayTokenFetcher(deps(key.privateKey, fakeFetch({ status: 200, body: { token: 'jwt', expiresAt: 5, head: 'h2', revision: 7 } }).impl, { onServerHead }))();
  assert.deepEqual(seen.at(-1), { head: 'h2', revision: 7 });
  for (const revision of [-1, 1.5, '7']) {
    await createRelayTokenFetcher(deps(key.privateKey, fakeFetch({ status: 200, body: { token: 'jwt', expiresAt: 5, head: 'h2', revision } }).impl, { onServerHead }))();
    assert.deepEqual(seen.at(-1), { head: 'head-1', revision: null }, String(revision));
  }
  const count = seen.length;
  await createRelayTokenFetcher(deps(key.privateKey, fakeFetch({ status: 200, body: { token: 'jwt', expiresAt: 5, ledger: { x: 1 } } }).impl, { onServerHead }))();
  await assert.rejects(createRelayTokenFetcher(deps(key.privateKey, fakeFetch({ status: 503, body: {} }).impl, { onServerHead }))());
  assert.equal(seen.length, count);
  // A throwing hook never costs the token.
  assert.deepEqual(await createRelayTokenFetcher(deps(key.privateKey, fakeFetch({ status: 200, body: { token: 'jwt', expiresAt: 5 } }).impl,
    { onServerHead: () => { throw new Error('boom'); } }))(), { token: 'jwt', expiresAt: 5 });
});

test('401 key_revoked hands evidence to onRevoked then throws UnauthorizedError', async () => {
  const { key } = await setup();
  const { impl } = fakeFetch({ status: 401, body: { error: 'key_revoked', ledger: { ev: true } } });
  let evidence: unknown;
  await assert.rejects(
    createRelayTokenFetcher(deps(key.privateKey, impl, { onRevoked: async l => { evidence = l; } }))(),
    (error: unknown) => error instanceof UnauthorizedError,
  );
  assert.deepEqual(evidence, { ev: true });
});

test('other 401 is UnauthorizedError without onRevoked', async () => {
  const { key } = await setup();
  const { impl } = fakeFetch({ status: 401, body: { error: 'nope' } });
  let called = false;
  await assert.rejects(
    createRelayTokenFetcher(deps(key.privateKey, impl, { onRevoked: async () => { called = true; } }))(),
    (error: unknown) => error instanceof UnauthorizedError,
  );
  assert.equal(called, false);
});

test('500 is a plain Error (retryable), not UnauthorizedError', async () => {
  const { key } = await setup();
  const { impl } = fakeFetch({ status: 500, body: {}, raw: 'boom' });
  await assert.rejects(createRelayTokenFetcher(deps(key.privateKey, impl))(), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.ok(!(error instanceof UnauthorizedError));
    assert.match(error.message, /500.*boom/);
    return true;
  });
});

test('nonce failure is a plain Error and relay-token is never called', async () => {
  const { key } = await setup();
  const { impl, calls } = fakeFetch({ status: 200, body: { token: 't', expiresAt: 1 } }, { status: 429, body: { error: 'rate' } });
  await assert.rejects(createRelayTokenFetcher(deps(key.privateKey, impl))(), (error: unknown) => {
    assert.ok(error instanceof Error && !(error instanceof UnauthorizedError));
    return true;
  });
  assert.equal(calls.length, 1);
});

test('error bodies are capped at 200 characters', async () => {
  const { key } = await setup();
  const big = 'x'.repeat(5000);
  for (const status of [500, 401]) {
    const { impl } = fakeFetch({ status, body: null, raw: big });
    await assert.rejects(createRelayTokenFetcher(deps(key.privateKey, impl))(), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.ok(error.message.length < 300);
      return true;
    });
  }
});

test('malformed 200 body is a plain Error', async () => {
  const { key } = await setup();
  const { impl } = fakeFetch({ status: 200, body: { token: 5 } });
  await assert.rejects(createRelayTokenFetcher(deps(key.privateKey, impl))(), (error: unknown) => error instanceof Error && !(error instanceof UnauthorizedError));
});

import { RelayKeyRevokedError } from './relay-token.js';

test('key_revoked throws RelayKeyRevokedError carrying the ledger, after onRevoked resolves', async () => {
  const { key } = await setup();
  const { impl } = fakeFetch({ status: 401, body: { error: 'key_revoked', ledger: { ev: 1 } } });
  const events: string[] = [];
  await assert.rejects(
    createRelayTokenFetcher(deps(key.privateKey, impl, { onRevoked: async () => { await new Promise(r => setTimeout(r, 20)); events.push('revoked'); } }))()
      .catch((e: unknown) => { events.push('thrown'); throw e; }),
    (error: unknown) => error instanceof RelayKeyRevokedError && error instanceof UnauthorizedError && (error as RelayKeyRevokedError).ledger !== undefined,
  );
  assert.deepEqual(events, ['revoked', 'thrown']);
});

test('plain 401 is not RelayKeyRevokedError', async () => {
  const { key } = await setup();
  const { impl } = fakeFetch({ status: 401, body: { error: 'nope' } });
  await assert.rejects(createRelayTokenFetcher(deps(key.privateKey, impl))(), (e: unknown) => e instanceof UnauthorizedError && !(e instanceof RelayKeyRevokedError));
});

test('onUnauthorized true retries the whole sequence exactly once, never loops', async () => {
  const { key } = await setup();
  const { impl, calls } = fakeFetch({ status: 401, body: { error: 'nope' } });
  let n = 0;
  await assert.rejects(
    createRelayTokenFetcher(deps(key.privateKey, impl, { onUnauthorized: async () => { n++; return true; } }))(),
    (e: unknown) => e instanceof UnauthorizedError,
  );
  assert.equal(n, 1);
  assert.equal(calls.length, 4);
});

test('onUnauthorized retry can succeed; false does not retry', async () => {
  const { key } = await setup();
  let relayCalls = 0;
  const impl = (async (url: string | URL | Request) => {
    const u = String(url);
    if (u.endsWith('/nonce')) return new Response(JSON.stringify({ nonce: 'n'.repeat(43), expiresAt: 1 }));
    relayCalls++;
    return relayCalls === 1 ? new Response('{}', { status: 401 }) : new Response(JSON.stringify({ token: 'jwt', expiresAt: 3 }));
  }) as typeof fetch;
  assert.deepEqual(await createRelayTokenFetcher(deps(key.privateKey, impl, { onUnauthorized: async () => true }))(), { token: 'jwt', expiresAt: 3 });
  const f = fakeFetch({ status: 401, body: {} });
  await assert.rejects(createRelayTokenFetcher(deps(key.privateKey, f.impl, { onUnauthorized: async () => false }))(), (e: unknown) => e instanceof UnauthorizedError);
  assert.equal(f.calls.length, 2);
});

test('key_revoked never triggers onUnauthorized', async () => {
  const { key } = await setup();
  const { impl } = fakeFetch({ status: 401, body: { error: 'key_revoked', ledger: {} } });
  let called = false;
  await assert.rejects(createRelayTokenFetcher(deps(key.privateKey, impl, { onUnauthorized: async () => { called = true; return true; } }))());
  assert.equal(called, false);
});

test('timeout is a plain retryable Error and a signal is passed', async () => {
  const { key } = await setup();
  let signal: AbortSignal | null | undefined;
  const impl = ((_u: string, init?: RequestInit) => {
    signal = init?.signal;
    return new Promise<Response>((_res, rej) => init?.signal?.addEventListener('abort', () => rej(init.signal!.reason)));
  }) as unknown as typeof fetch;
  await assert.rejects(createRelayTokenFetcher(deps(key.privateKey, impl, { timeoutMs: 20 }))(), (e: unknown) => {
    assert.ok(e instanceof Error && !(e instanceof UnauthorizedError));
    assert.match(e.message, /timed out/);
    return true;
  });
  assert.ok(signal);
});

test('oversized response body is a plain Error', async () => {
  const { key } = await setup();
  const { impl } = fakeFetch({ status: 200, body: null, raw: 'x'.repeat(3 * 1024 * 1024 + 1) });
  await assert.rejects(createRelayTokenFetcher(deps(key.privateKey, impl))(), (e: unknown) => e instanceof Error && !(e instanceof UnauthorizedError) && e.message === 'relay_token_response_too_large');
});

test('hostname and localPort are included when provided, omitted otherwise', async () => {
  const { key } = await setup();
  const a = fakeFetch({ status: 200, body: { token: 'jwt', expiresAt: 1 } });
  await createRelayTokenFetcher(deps(key.privateKey, a.impl, { hostname: () => 'box', localPort: () => 4123 }))();
  assert.equal(a.calls[1].body.hostname, 'box');
  assert.equal(a.calls[1].body.localPort, 4123);
  const b = fakeFetch({ status: 200, body: { token: 'jwt', expiresAt: 1 } });
  await createRelayTokenFetcher(deps(key.privateKey, b.impl, { localPort: () => undefined }))();
  assert.deepEqual(Object.keys(b.calls[1].body).sort(), ['head', 'proof']);
});

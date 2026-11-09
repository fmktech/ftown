import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { UnauthorizedError } from 'centrifuge';

import { BridgeRevokedError, refreshBridgeToken } from './bridge-auth.js';
import { generateEndpoint } from './security/crypto.js';
import { createAccountGenesis, generateAccountSigningIdentity, signAccountTransition, verifyAccountHistory } from './security/account-crypto.js';
import type { AccountCheckpoint, AccountDevice, AccountHistory, AccountOperation } from './security/account-protocol.js';


const ownerId = '349f8d2e-38e4-4d59-888d-687dcfa19e39';

// Same account builder as security/bridge/revocation.test.ts.
async function account() {
  const now = Date.now();
  const first = await generateEndpoint(ownerId, 'browser');
  const signing = await generateAccountSigningIdentity();
  const second = await generateEndpoint(ownerId, 'browser');
  const secondSigning = await generateAccountSigningIdentity();
  const secondDevice: AccountDevice = { endpoint: second.endpoint, signingPublicKey: secondSigning.publicKey, label: 'Second', approvedAt: new Date(now).toISOString() };
  const genesis: AccountHistory = { genesis: await createAccountGenesis(ownerId, first.endpoint, signing, 'First', now), transitions: [] };
  const states: AccountCheckpoint[] = [await verifyAccountHistory(genesis, null, now)];
  const chain = { history: genesis, now };
  async function append(op: AccountOperation, from = chain.history, base = states[from.transitions.length]): Promise<AccountHistory> {
    const at = now + from.transitions.length + 1;
    const record = await signAccountTransition(base, first.endpoint.id, signing, op, at);
    return { ...from, transitions: [...from.transitions, record] };
  }
  const bridge = async (id: string): Promise<AccountOperation> => ({ type: 'add_bridge', bridge: { bridgeId: id, endpoint: (await generateEndpoint(ownerId, 'bridge')).endpoint, label: id, approvedAt: new Date(now).toISOString() } });
  async function extend(op: AccountOperation) {
    chain.history = await append(op);
    states.push(await verifyAccountHistory(chain.history, states[states.length - 1], now + chain.history.transitions.length + 1));
  }
  return { now, genesis, secondDevice, chain, states, extend, append, bridge };
}

// genesis(0), add A(1), add B(2), revoke A(3), add_device(4); evidence truncated after the revoke (C1).
async function standard() {
  const f = await account();
  await f.extend(await f.bridge('A'));
  await f.extend(await f.bridge('B'));
  await f.extend({ type: 'revoke_bridge', bridgeId: 'A' });
  await f.extend({ type: 'add_device', device: f.secondDevice });
  const full = f.chain.history;
  const evidence: AccountHistory = { ...full, transitions: full.transitions.slice(0, 3) };
  return { ...f, full, evidence };
}
const revokedBody = (history: unknown) => JSON.stringify({ error: 'bridge_revoked', history });
const LOCAL = { localPort: 43123, localNonce: 'nonce' };

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('refreshBridgeToken', () => {
  it('classifies a rejected rotating credential as permanent authorization failure', async () => {
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({ error: 'Refresh token has been rotated or revoked' }),
        { status: 401, headers: { 'Content-Type': 'application/json' } },
      );

    await assert.rejects(
      refreshBridgeToken(
        'https://ftown.test',
        'stale-refresh-token',
        'bridge-1',
        { localPort: 43123, localNonce: 'nonce' },
      ),
      (error: unknown) => {
        assert.ok(
          error instanceof UnauthorizedError,
          '401 must be terminal so centrifuge-js does not retry the stale token forever',
        );
        return true;
      },
    );
  });

  it('keeps transient server failures retryable', async () => {
    globalThis.fetch = async () =>
      new Response('temporarily unavailable', { status: 503 });

    await assert.rejects(
      refreshBridgeToken(
        'https://ftown.test',
        'current-refresh-token',
        'bridge-1',
        { localPort: 43123, localNonce: 'nonce' },
      ),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(error instanceof UnauthorizedError, false);
        assert.match(error.message, /Token refresh failed \(503\)/);
        return true;
      },
    );
  });

  it('throws BridgeRevokedError carrying the evidence for a 401 with a C1 body', async () => {
    const f = await standard();
    globalThis.fetch = async () =>
      new Response(revokedBody(f.evidence), { status: 401, headers: { 'Content-Type': 'application/json' } });

    await assert.rejects(
      refreshBridgeToken('https://ftown.test', 'refresh-token', 'A', LOCAL),
      (error: unknown) => {
        assert.ok(error instanceof BridgeRevokedError);
        assert.ok(error instanceof UnauthorizedError);
        assert.equal(error.name, 'BridgeRevokedError');
        assert.deepEqual(error.evidence, f.evidence);
        return true;
      },
    );
  });

  it('keeps a 401 without revocation evidence as a plain UnauthorizedError', async () => {
    const f = await standard();
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ error: 'bridge_revoked' }), { status: 401, headers: { 'Content-Type': 'application/json' } });

    await assert.rejects(
      refreshBridgeToken('https://ftown.test', 'refresh-token', 'A', LOCAL),
      (error: unknown) => {
        assert.ok(error instanceof UnauthorizedError);
        assert.equal(error instanceof BridgeRevokedError, false);
        assert.match(error.message, /Token refresh failed \(401\)/);
        return true;
      },
    );
    globalThis.fetch = async () =>
      new Response(revokedBody({ genesis: f.evidence.genesis, transitions: 'x' }), { status: 401 });
    await assert.rejects(
      refreshBridgeToken('https://ftown.test', 'refresh-token', 'A', LOCAL),
      (error: unknown) => {
        assert.ok(error instanceof UnauthorizedError);
        assert.equal(error instanceof BridgeRevokedError, false);
        return true;
      },
    );
  });

  it('caps the body embedded in the message of a non-revocation 401', async () => {
    globalThis.fetch = async () => new Response('x'.repeat(10 * 1024), { status: 401 });

    await assert.rejects(
      refreshBridgeToken('https://ftown.test', 'refresh-token', 'A', LOCAL),
      (error: unknown) => {
        assert.ok(error instanceof UnauthorizedError);
        assert.equal(error instanceof BridgeRevokedError, false);
        assert.ok(error.message.length <= 250, `message length ${error.message.length}`);
        return true;
      },
    );
  });

  it('throws a plain Error, not UnauthorizedError, for a 500 even with a C1 body', async () => {
    const f = await standard();
    globalThis.fetch = async () => new Response(revokedBody(f.evidence), { status: 500 });

    await assert.rejects(
      refreshBridgeToken('https://ftown.test', 'refresh-token', 'A', LOCAL),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(error instanceof UnauthorizedError, false);
        assert.equal(error instanceof BridgeRevokedError, false);
        assert.match(error.message, /Token refresh failed \(500\)/);
        return true;
      },
    );
  });

  it('returns the parsed response unchanged for a 200', async () => {
    const payload = { ownerId: 'owner', token: 't', refreshToken: 'r2', centrifugoUrl: 'wss://x', userId: 'u' };
    globalThis.fetch = async () => new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } });

    assert.deepEqual(await refreshBridgeToken('https://ftown.test', 'r1', 'A', LOCAL), payload);
  });
});

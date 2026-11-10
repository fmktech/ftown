import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { generateAuthKey, signAuthProof, type AuthProof } from '@security/ledger/proof';
import type { Ledger, LedgerCheckpoint, LedgerDevice, LedgerGenesis, LedgerOperation, LedgerTransition, Signed } from '@security/ledger/protocol';
import { accountIdOf, applyRevocations, ledgerChallenge, ledgerHead, ledgerLastIssuedAt, nextTransition, verifyLedger } from '@security/ledger/ledger';
import { createSoftPasskey, type SoftPasskey } from '@security/ledger/testing';

const consumeNonce = vi.fn();
const readTrusted = vi.fn();
const readChain = vi.fn();
vi.mock('@/lib/auth-nonce-store', () => ({ consumeNonce: (...a: unknown[]) => consumeNonce(...a) }));
// Auth decisions use only the persisted trusted checkpoint; reading (let alone verifying) the chain per request is a regression.
vi.mock('@/lib/account-ledger-store', () => ({ readTrustedCheckpoint: (...a: unknown[]) => readTrusted(...a), readLedger: (...a: unknown[]) => readChain(...a) }));
vi.mock('next-auth/providers/credentials', () => ({ default: (config: unknown) => config }));

import { authorizeLedgerProof, ledgerCredentialsProvider, LEDGER_SESSION_MAX_AGE_SECONDS, publicOrigin, requireAccount } from './ledger-auth';

const ORIGIN = 'https://ftown.example';
const NONCE = 'n'.repeat(43);
const b64 = (data: Uint8Array): string => Buffer.from(data).toString('base64url');
const NOW = Date.now();

interface Sticky { deviceIds: string[]; bridgeIds: string[] }
interface Fixture {
  passkey: SoftPasskey; ledger: Ledger; accountId: string; head: string; issuedAt: number;
  deviceId: string; deviceKey: CryptoKey; bridgeId: string; bridgeKey: CryptoKey;
}

async function signed<T extends LedgerGenesis | LedgerTransition>(passkey: SoftPasskey, payload: T): Promise<Signed<T>> {
  return { payload, signature: await passkey.sign(await ledgerChallenge(payload)) };
}
async function endpointFor(ownerId: string, kind: 'browser' | 'bridge') {
  const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  return { version: 1 as const, id: b64(new Uint8Array(createHash('sha256').update(raw).digest())), ownerId, kind, publicKey: b64(raw) };
}
async function append(f: Fixture, operation: LedgerOperation): Promise<Fixture> {
  const payload = nextTransition(await verifyLedger(f.ledger), f.passkey.credentialId, operation, f.issuedAt + 1000, ledgerLastIssuedAt(f.ledger));
  const record = await signed(f.passkey, payload);
  return { ...f, ledger: { genesis: f.ledger.genesis, transitions: [...f.ledger.transitions, record] }, head: await ledgerHead(payload), issuedAt: payload.issuedAt };
}
/** A real signed chain: genesis, add_device (key held here), add_bridge. */
async function makeFixture(): Promise<Fixture> {
  const passkey = await createSoftPasskey({ rpId: 'ftown.example', origin: ORIGIN });
  const createdAt = NOW - 60_000;
  const genesis = await signed(passkey, {
    type: 'ftown_account_genesis', version: 2, rpId: 'ftown.example', origins: [ORIGIN], handle: b64(crypto.getRandomValues(new Uint8Array(32))),
    createdAt, authority: { credentialId: passkey.credentialId, publicKey: passkey.publicKey, label: 'Key', addedAt: createdAt },
  } as LedgerGenesis);
  const accountId = await accountIdOf(genesis.payload);
  const dKey = await generateAuthKey(false); const bKey = await generateAuthKey(false);
  const device: LedgerDevice = { endpoint: await endpointFor(accountId, 'browser'), authPublicKey: dKey.publicKey, label: 'Laptop', approvedAt: createdAt };
  const bridgeEndpoint = await endpointFor(accountId, 'bridge');
  let f: Fixture = { passkey, ledger: { genesis, transitions: [] }, accountId, head: accountId, issuedAt: createdAt,
    deviceId: device.endpoint.id, deviceKey: dKey.privateKey, bridgeId: 'studio', bridgeKey: bKey.privateKey };
  f = await append(f, { type: 'add_device', device });
  f = await append(f, { type: 'add_bridge', bridge: { bridgeId: 'studio', endpoint: bridgeEndpoint, authPublicKey: bKey.publicKey, label: 'Studio', approvedAt: createdAt } });
  return f;
}
/** What the store persists for `ledger` with `sticky`: its checkpoint with the sticky revocations applied. */
async function trustedOf(ledger: Ledger, sticky: Sticky = { deviceIds: [], bridgeIds: [] }): Promise<LedgerCheckpoint> {
  return applyRevocations(await verifyLedger(ledger), sticky);
}

let fx: Fixture;
const proof = (over: Partial<Omit<AuthProof, 'signature'>> = {}, key?: CryptoKey): Promise<AuthProof> =>
  signAuthProof(key ?? fx.deviceKey, { accountId: fx.accountId, kind: 'device', keyId: fx.deviceId, nonce: NONCE, purpose: 'session', audience: ORIGIN, ...over });

beforeEach(async () => {
  vi.stubEnv('FTOWN_PUBLIC_URL', ORIGIN);
  consumeNonce.mockReset().mockResolvedValue(true);
  readTrusted.mockReset();
  readChain.mockReset().mockRejectedValue(new Error('the chain must not be read for an auth decision'));
  fx = await makeFixture();
  readTrusted.mockResolvedValue(await trustedOf(fx.ledger));
});

describe('authorizeLedgerProof', () => {
  it('accepts a valid device session proof', async () => {
    expect(await authorizeLedgerProof(await proof())).toEqual({ id: fx.accountId, endpointId: fx.deviceId });
    expect(consumeNonce).toHaveBeenCalledWith(NONCE, 'session');
    expect(readTrusted).toHaveBeenCalledWith(fx.accountId);
    expect(readChain).not.toHaveBeenCalled();
  });
  it('rejects a reused nonce without reading the ledger', async () => {
    consumeNonce.mockResolvedValue(false);
    expect(await authorizeLedgerProof(await proof())).toBeNull();
    expect(readTrusted).not.toHaveBeenCalled();
  });
  it('rejects a wrong audience', async () => {
    expect(await authorizeLedgerProof(await proof({ audience: 'https://evil.example' }))).toBeNull();
  });
  it('rejects a bridge proof', async () => {
    const p = await proof({ kind: 'bridge', keyId: fx.bridgeId, purpose: 'session' }, fx.bridgeKey);
    expect(await authorizeLedgerProof(p)).toBeNull();
    expect(consumeNonce).not.toHaveBeenCalled();
  });
  it('rejects a relay-purpose proof', async () => {
    expect(await authorizeLedgerProof(await proof({ purpose: 'relay' }))).toBeNull();
  });
  it('rejects a device revoked in the chain', async () => {
    const revoked = await append(fx, { type: 'revoke_device', endpointId: fx.deviceId });
    readTrusted.mockResolvedValue(await trustedOf(revoked.ledger));
    expect(await authorizeLedgerProof(await proof())).toBeNull();
  });
  it('uses trusted, not the raw checkpoint: a sticky-revoked device is rejected', async () => {
    readTrusted.mockResolvedValue(await trustedOf(fx.ledger, { deviceIds: [fx.deviceId], bridgeIds: [] }));
    expect(await authorizeLedgerProof(await proof())).toBeNull();
  });
  it('rejects an unknown account', async () => {
    readTrusted.mockResolvedValue(null);
    expect(await authorizeLedgerProof(await proof())).toBeNull();
  });
  it('rejects a forged signature', async () => {
    const other = await generateAuthKey(false);
    expect(await authorizeLedgerProof(await proof({}, other.privateKey))).toBeNull();
  });
  it('consumes the nonce even when verification fails', async () => {
    expect(await authorizeLedgerProof(await proof({ audience: 'https://evil.example' }))).toBeNull();
    expect(consumeNonce).toHaveBeenCalledTimes(1);
  });
  it.each([null, undefined, 'x', 5, [], {}, { accountId: 1 }])('returns null for malformed input %#', async raw => {
    expect(await authorizeLedgerProof(raw)).toBeNull();
  });
  it('never throws when a dependency fails', async () => {
    readTrusted.mockRejectedValue(new Error('account_ledger_corrupt'));
    expect(await authorizeLedgerProof(await proof())).toBeNull();
    consumeNonce.mockRejectedValue(new Error('db'));
    expect(await authorizeLedgerProof(await proof())).toBeNull();
  });
  it('returns null when FTOWN_PUBLIC_URL is invalid', async () => {
    vi.stubEnv('FTOWN_PUBLIC_URL', 'https://ftown.example/');
    expect(await authorizeLedgerProof(await proof())).toBeNull();
  });
});

describe('ledgerCredentialsProvider', () => {
  type Cfg = { id: string; authorize: (c: Record<string, unknown> | undefined) => Promise<unknown> };
  it('has id ledger and authorizes a JSON proof', async () => {
    const cfg = ledgerCredentialsProvider() as unknown as Cfg;
    expect(cfg.id).toBe('ledger');
    expect(await cfg.authorize({ proof: JSON.stringify(await proof()) })).toEqual({ id: fx.accountId, endpointId: fx.deviceId });
  });
  it('returns null for bad JSON, missing or oversized proof', async () => {
    const cfg = ledgerCredentialsProvider() as unknown as Cfg;
    expect(await cfg.authorize({ proof: '{nope' })).toBeNull();
    expect(await cfg.authorize({})).toBeNull();
    expect(await cfg.authorize(undefined)).toBeNull();
    expect(await cfg.authorize({ proof: 'x'.repeat(5000) })).toBeNull();
  });
});

describe('publicOrigin', () => {
  it('returns the configured canonical origin', () => { expect(publicOrigin()).toBe(ORIGIN); });
  it('rejects non-canonical values', () => {
    vi.stubEnv('FTOWN_PUBLIC_URL', 'https://ftown.example/path');
    expect(() => publicOrigin()).toThrow();
    vi.stubEnv('FTOWN_PUBLIC_URL', 'ftp://x');
    expect(() => publicOrigin()).toThrow();
  });
  it('throws when unset outside development and test', () => {
    vi.stubEnv('FTOWN_PUBLIC_URL', '');
    for (const env of ['production', 'staging', '']) { vi.stubEnv('NODE_ENV', env); expect(() => publicOrigin()).toThrow(); }
  });
  it('refuses plain http on a non-loopback host, allows it on loopback', () => {
    vi.stubEnv('FTOWN_PUBLIC_URL', 'http://192.168.1.5:3000');
    expect(() => publicOrigin()).toThrow();
    vi.stubEnv('FTOWN_PUBLIC_URL', 'http://localhost:3000');
    expect(publicOrigin()).toBe('http://localhost:3000');
  });
  it('falls back to localhost in test/development', () => {
    vi.stubEnv('FTOWN_PUBLIC_URL', ''); vi.stubEnv('NODE_ENV', 'test');
    expect(publicOrigin()).toBe('http://localhost:3000');
  });
});

describe('requireAccount', () => {
  const session = (id: string | undefined, endpointId: string | undefined) => async () => ({ user: { id, endpointId } });
  it('returns the account and its trusted checkpoint for a trusted device, from the checkpoint read alone', async () => {
    const result = await requireAccount(session(fx.accountId, fx.deviceId));
    expect(result.accountId).toBe(fx.accountId);
    expect(result.endpointId).toBe(fx.deviceId);
    expect(result.trusted.accountId).toBe(fx.accountId);
    expect(readTrusted).toHaveBeenCalledWith(fx.accountId);
    expect(readChain).not.toHaveBeenCalled();
  });
  it('propagates a corrupt row (not a 401)', async () => {
    readTrusted.mockRejectedValue(new Error('account_ledger_corrupt'));
    await expect(requireAccount(session(fx.accountId, fx.deviceId))).rejects.toThrow('account_ledger_corrupt');
  });
  it('throws 401 with no session', async () => {
    await expect(requireAccount(async () => null)).rejects.toMatchObject({ status: 401 });
    await expect(requireAccount(async () => ({ user: {} }))).rejects.toMatchObject({ status: 401 });
  });
  it('401s a device revoked in the chain', async () => {
    const revoked = await append(fx, { type: 'revoke_device', endpointId: fx.deviceId });
    readTrusted.mockResolvedValue(await trustedOf(revoked.ledger));
    await expect(requireAccount(session(fx.accountId, fx.deviceId))).rejects.toMatchObject({ status: 401 });
  });
  it('401s a sticky-revoked device (trusted, not the raw checkpoint)', async () => {
    readTrusted.mockResolvedValue(await trustedOf(fx.ledger, { deviceIds: [fx.deviceId], bridgeIds: [] }));
    await expect(requireAccount(session(fx.accountId, fx.deviceId))).rejects.toMatchObject({ status: 401 });
  });
  it('401s a non-accountId session id (old v1 UUID) without reading the ledger', async () => {
    await expect(requireAccount(session('3f2b8c1e-9d4a-4b7e-8a11-0c2d5e6f7a89', fx.deviceId))).rejects.toMatchObject({ status: 401 });
    expect(readTrusted).not.toHaveBeenCalled();
  });
  it('401s a missing endpointId', async () => {
    await expect(requireAccount(session(fx.accountId, undefined))).rejects.toMatchObject({ status: 401 });
    await expect(requireAccount(session(fx.accountId, ''))).rejects.toMatchObject({ status: 401 });
  });
  it('401s an endpoint that is not in the roster', async () => {
    await expect(requireAccount(session(fx.accountId, 'z'.repeat(43)))).rejects.toMatchObject({ status: 401 });
  });
  it('401s an unknown account', async () => {
    readTrusted.mockResolvedValue(null);
    await expect(requireAccount(session(fx.accountId, fx.deviceId))).rejects.toMatchObject({ status: 401 });
  });
});

describe('revoked ids never pass (shared applyRevocations, real chains)', () => {
  const session = (id: string, endpointId: string) => async () => ({ user: { id, endpointId } });
  it('a device revoked in the chain, or only by a sticky id, is refused by requireAccount and authorizeLedgerProof', async () => {
    const revoked = await append(fx, { type: 'revoke_device', endpointId: fx.deviceId });
    for (const trusted of [await trustedOf(revoked.ledger), await trustedOf(fx.ledger, { deviceIds: [fx.deviceId], bridgeIds: [] })]) {
      expect(trusted.revokedDeviceIds).toContain(fx.deviceId);
      readTrusted.mockResolvedValue(trusted);
      await expect(requireAccount(session(fx.accountId, fx.deviceId))).rejects.toMatchObject({ status: 401 });
      expect(await authorizeLedgerProof(await proof())).toBeNull();
    }
  });
  it('a checkpoint that lists a device both as a member and as revoked is refused', async () => {
    const both = await trustedOf(fx.ledger);
    both.revokedDeviceIds.push(fx.deviceId);
    expect(both.devices.map(device => device.endpoint.id)).toContain(fx.deviceId);
    readTrusted.mockResolvedValue(both);
    await expect(requireAccount(session(fx.accountId, fx.deviceId))).rejects.toMatchObject({ status: 401 });
    expect(await authorizeLedgerProof(await proof())).toBeNull();
    readTrusted.mockResolvedValue(await trustedOf(fx.ledger));
    expect((await requireAccount(session(fx.accountId, fx.deviceId))).endpointId).toBe(fx.deviceId);
  });
});

describe('session lifetime', () => {
  it('is 12 hours', () => { expect(LEDGER_SESSION_MAX_AGE_SECONDS).toBe(43200); });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import jwt from 'jsonwebtoken';

const readTrusted = vi.fn();
const readChain = vi.fn();
const authMock = vi.fn();
// Auth decisions use only the persisted trusted checkpoint; reading (let alone verifying) the chain per request is a regression.
vi.mock('@/lib/account-ledger-store', () => ({ readTrustedCheckpoint: (...a: unknown[]) => readTrusted(...a), readLedger: (...a: unknown[]) => readChain(...a) }));
vi.mock('@/lib/auth-nonce-store', () => ({ consumeNonce: vi.fn() }));
vi.mock('@/lib/auth', () => ({ auth: () => authMock() }));
vi.mock('next-auth/providers/credentials', () => ({ default: (config: unknown) => config }));

import { requireAccountOrBridge, requireBridge } from './relay-auth';
import { UnauthorizedError } from './ledger-auth';
import { createHash } from 'node:crypto';
import { accountIdOf, applyRevocations, ledgerChallenge, ledgerLastIssuedAt, nextTransition, verifyLedger } from '@security/ledger/ledger';
import type { Ledger, LedgerGenesis, LedgerOperation, LedgerTransition, Signed } from '@security/ledger/protocol';
import { generateAuthKey } from '@security/ledger/proof';
import { createSoftPasskey, type SoftPasskey } from '@security/ledger/testing';

const SECRET = 'relay-auth-test-secret-long-enough-0123456789';
const ACCOUNT = 'A'.repeat(43);
const OTHER = 'B'.repeat(43);
const BRIDGE = 'bridge-1';
const DEVICE = 'D'.repeat(43);

interface Roster { bridges: string[]; devices: string[] }
const checkpoint = (roster: Roster) => ({
  bridges: roster.bridges.map(bridgeId => ({ bridgeId })), devices: roster.devices.map(id => ({ endpoint: { id } })),
});
/** The persisted trusted checkpoint (sticky revocations applied): a sticky-revoked bridge is simply absent from it. */
const trusted = (roster: Roster, revokedBridgeIds: string[] = []) => ({ accountId: ACCOUNT, ...checkpoint(roster), revokedDeviceIds: [], revokedBridgeIds });
const FULL: Roster = { bridges: [BRIDGE], devices: [DEVICE] };

function bearer(claims: Record<string, unknown>, options: jwt.SignOptions & { secret?: string } = {}): Request {
  const { secret, ...rest } = options;
  const token = jwt.sign(claims, secret ?? SECRET, { algorithm: 'HS256', audience: 'ftown:centrifugo', expiresIn: 60, ...rest });
  return new Request('https://app.test/x', { headers: { authorization: `Bearer ${token}` } });
}
const good = () => bearer({ sub: ACCOUNT, info: { bridgeId: BRIDGE, ownerId: ACCOUNT } });

beforeEach(() => {
  vi.stubEnv('CENTRIFUGO_TOKEN_SECRET', SECRET);
  readTrusted.mockResolvedValue(trusted(FULL));
  readChain.mockRejectedValue(new Error('the chain must not be read for an auth decision'));
});
afterEach(() => { vi.unstubAllEnvs(); vi.resetAllMocks(); });

describe('requireBridge', () => {
  it('accepts a trusted bridge and returns accountId, bridgeId and the trusted checkpoint, from the checkpoint read alone', async () => {
    const result = await requireBridge(good());
    expect(result.accountId).toBe(ACCOUNT); expect(result.bridgeId).toBe(BRIDGE);
    expect(result.trusted.bridges).toEqual([{ bridgeId: BRIDGE }]);
    expect(readTrusted).toHaveBeenCalledWith(ACCOUNT);
    expect(readChain).not.toHaveBeenCalled();
  });
  it('rejects a bridge revoked by a sticky id (absent from the trusted checkpoint)', async () => {
    readTrusted.mockResolvedValue(trusted({ bridges: [], devices: [DEVICE] }));
    await expect(requireBridge(good())).rejects.toMatchObject({ status: 401 });
  });
  it('rejects a bridge absent from the roster and an unknown account', async () => {
    readTrusted.mockResolvedValue(trusted({ bridges: [], devices: [] }));
    await expect(requireBridge(good())).rejects.toBeInstanceOf(UnauthorizedError);
    readTrusted.mockResolvedValue(null);
    await expect(requireBridge(good())).rejects.toMatchObject({ status: 401 });
  });
  it('rejects a wrong audience, wrong secret, wrong algorithm, expired and missing bearer', async () => {
    const claims = { sub: ACCOUNT, info: { bridgeId: BRIDGE, ownerId: ACCOUNT } };
    for (const request of [
      bearer(claims, { audience: 'other' }), bearer(claims, { secret: 'a-different-secret-that-is-long-enough-1234' }),
      bearer(claims, { algorithm: 'HS512' }), bearer(claims, { expiresIn: -10 }),
      new Request('https://app.test/x'), new Request('https://app.test/x', { headers: { authorization: 'Basic abc' } }),
    ]) await expect(requireBridge(request)).rejects.toMatchObject({ status: 401 });
    expect(readTrusted).not.toHaveBeenCalled();
  });
  it('rejects ownerId different from sub, a malformed sub, and missing info', async () => {
    for (const claims of [
      { sub: ACCOUNT, info: { bridgeId: BRIDGE, ownerId: OTHER } },
      { sub: ACCOUNT, info: { bridgeId: BRIDGE } },
      { sub: 'owner@example.test', info: { bridgeId: BRIDGE, ownerId: 'owner@example.test' } },
      { sub: ACCOUNT }, { sub: ACCOUNT, info: { ownerId: ACCOUNT } }, { sub: ACCOUNT, info: { bridgeId: 7, ownerId: ACCOUNT } },
    ]) await expect(requireBridge(bearer(claims))).rejects.toMatchObject({ status: 401 });
    expect(readTrusted).not.toHaveBeenCalled();
  });
  it('rejects a browser token (no info) for a trusted account', async () => {
    await expect(requireBridge(bearer({ sub: ACCOUNT }))).rejects.toMatchObject({ status: 401 });
  });
});

describe('requireAccountOrBridge', () => {
  it('uses the bridge path whenever Authorization is present, never falling back to the session', async () => {
    authMock.mockResolvedValue({ user: { id: ACCOUNT, endpointId: DEVICE } });
    const caller = await requireAccountOrBridge(good());
    expect(caller).toMatchObject({ kind: 'bridge', accountId: ACCOUNT, bridgeId: BRIDGE });
    await expect(requireAccountOrBridge(bearer({ sub: ACCOUNT }))).rejects.toMatchObject({ status: 401 });
    expect(authMock).not.toHaveBeenCalled();
  });
  it('a non-Bearer Authorization header falls to the session path', async () => {
    authMock.mockResolvedValue({ user: { id: ACCOUNT, endpointId: DEVICE } });
    const caller = await requireAccountOrBridge(new Request('https://app.test/x', { headers: { authorization: 'Basic abc' } }));
    expect(caller.kind).toBe('account');
  });
  it('uses the session without Authorization and re-checks the device against the trusted ledger', async () => {
    authMock.mockResolvedValue({ user: { id: ACCOUNT, endpointId: DEVICE } });
    const request = new Request('https://app.test/x');
    expect(await requireAccountOrBridge(request)).toMatchObject({ kind: 'account', accountId: ACCOUNT, endpointId: DEVICE });
    expect(readChain).not.toHaveBeenCalled();
    readTrusted.mockResolvedValue(trusted({ bridges: [BRIDGE], devices: [] }));
    await expect(requireAccountOrBridge(request)).rejects.toMatchObject({ status: 401 });
    authMock.mockResolvedValue(null);
    await expect(requireAccountOrBridge(request)).rejects.toMatchObject({ status: 401 });
  });
});

describe('revoked bridges never pass (shared applyRevocations, real chains)', () => {
  const ORIGIN = 'https://ftown.example';
  const b64 = (data: Uint8Array): string => Buffer.from(data).toString('base64url');
  const T = Date.now() - 60_000;
  interface Chain { passkey: SoftPasskey; ledger: Ledger; accountId: string; issuedAt: number }
  async function signed<T extends LedgerGenesis | LedgerTransition>(passkey: SoftPasskey, payload: T): Promise<Signed<T>> {
    return { payload, signature: await passkey.sign(await ledgerChallenge(payload)) };
  }
  async function append(chain: Chain, operation: LedgerOperation): Promise<Chain> {
    const payload = nextTransition(await verifyLedger(chain.ledger), chain.passkey.credentialId, operation, chain.issuedAt + 1000, ledgerLastIssuedAt(chain.ledger));
    return { ...chain, ledger: { genesis: chain.ledger.genesis, transitions: [...chain.ledger.transitions, await signed(chain.passkey, payload)] }, issuedAt: payload.issuedAt };
  }
  async function bridged(): Promise<Chain> {
    const passkey = await createSoftPasskey({ rpId: 'ftown.example', origin: ORIGIN });
    const genesis = await signed(passkey, { type: 'ftown_account_genesis', version: 2, rpId: 'ftown.example', origins: [ORIGIN],
      handle: b64(crypto.getRandomValues(new Uint8Array(32))), createdAt: T, authority: { credentialId: passkey.credentialId, publicKey: passkey.publicKey, label: 'Key', addedAt: T } } as LedgerGenesis);
    const accountId = await accountIdOf(genesis.payload);
    const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
    const raw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
    const endpoint = { version: 1 as const, id: b64(new Uint8Array(createHash('sha256').update(raw).digest())), ownerId: accountId, kind: 'bridge' as const, publicKey: b64(raw) };
    const chain: Chain = { passkey, ledger: { genesis, transitions: [] }, accountId, issuedAt: T };
    return append(chain, { type: 'add_bridge', bridge: { bridgeId: BRIDGE, endpoint, authPublicKey: (await generateAuthKey(false)).publicKey, label: 'Studio', approvedAt: T } });
  }
  const token = (accountId: string) => bearer({ sub: accountId, info: { bridgeId: BRIDGE, ownerId: accountId } });

  it('accepts the bridge of a real chain, refuses it once revoked in the chain or only by a sticky id', async () => {
    const chain = await bridged();
    readTrusted.mockResolvedValue(applyRevocations(await verifyLedger(chain.ledger), { deviceIds: [], bridgeIds: [] }));
    expect((await requireBridge(token(chain.accountId))).bridgeId).toBe(BRIDGE);
    const revoked = await append(chain, { type: 'revoke_bridge', bridgeId: BRIDGE });
    for (const trusted of [applyRevocations(await verifyLedger(revoked.ledger), { deviceIds: [], bridgeIds: [] }),
      applyRevocations(await verifyLedger(chain.ledger), { deviceIds: [], bridgeIds: [BRIDGE] })]) {
      expect(trusted.revokedBridgeIds).toContain(BRIDGE);
      readTrusted.mockResolvedValue(trusted);
      await expect(requireBridge(token(chain.accountId))).rejects.toMatchObject({ status: 401 });
    }
  });

  it('a checkpoint that lists a bridge both as a member and as revoked is refused', async () => {
    const chain = await bridged();
    const both = applyRevocations(await verifyLedger(chain.ledger), { deviceIds: [], bridgeIds: [] });
    both.revokedBridgeIds.push(BRIDGE);
    expect(both.bridges.map(bridge => bridge.bridgeId)).toContain(BRIDGE);
    readTrusted.mockResolvedValue(both);
    await expect(requireBridge(token(chain.accountId))).rejects.toMatchObject({ status: 401 });
  });
});

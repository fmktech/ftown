import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import jwt from 'jsonwebtoken';

const readLedger = vi.fn();
const authMock = vi.fn();
vi.mock('@/lib/account-ledger-store', () => ({ readLedger: (...a: unknown[]) => readLedger(...a) }));
vi.mock('@/lib/auth-nonce-store', () => ({ consumeNonce: vi.fn() }));
vi.mock('@/lib/auth', () => ({ auth: () => authMock() }));
vi.mock('next-auth/providers/credentials', () => ({ default: (config: unknown) => config }));

import { requireAccountOrBridge, requireBridge } from './relay-auth';
import { UnauthorizedError } from './ledger-auth';

const SECRET = 'relay-auth-test-secret-long-enough-0123456789';
const ACCOUNT = 'A'.repeat(43);
const OTHER = 'B'.repeat(43);
const BRIDGE = 'bridge-1';
const DEVICE = 'D'.repeat(43);

interface Roster { bridges: string[]; devices: string[] }
const checkpoint = (roster: Roster) => ({
  bridges: roster.bridges.map(bridgeId => ({ bridgeId })), devices: roster.devices.map(id => ({ endpoint: { id } })),
});
/** raw = what the stored chain lists; trusted = after sticky revocations. They differ for a sticky-revoked bridge. */
function stored(raw: Roster, trusted: Roster) {
  return { checkpoint: checkpoint(raw), trusted: checkpoint(trusted), ledger: {}, sticky: { deviceIds: [], bridgeIds: [] } };
}
const FULL: Roster = { bridges: [BRIDGE], devices: [DEVICE] };

function bearer(claims: Record<string, unknown>, options: jwt.SignOptions & { secret?: string } = {}): Request {
  const { secret, ...rest } = options;
  const token = jwt.sign(claims, secret ?? SECRET, { algorithm: 'HS256', audience: 'ftown:centrifugo', expiresIn: 60, ...rest });
  return new Request('https://app.test/x', { headers: { authorization: `Bearer ${token}` } });
}
const good = () => bearer({ sub: ACCOUNT, info: { bridgeId: BRIDGE, ownerId: ACCOUNT } });

beforeEach(() => { vi.stubEnv('CENTRIFUGO_TOKEN_SECRET', SECRET); readLedger.mockResolvedValue(stored(FULL, FULL)); });
afterEach(() => { vi.unstubAllEnvs(); vi.resetAllMocks(); });

describe('requireBridge', () => {
  it('accepts a trusted bridge and returns accountId, bridgeId and the stored ledger', async () => {
    const result = await requireBridge(good());
    expect(result.accountId).toBe(ACCOUNT); expect(result.bridgeId).toBe(BRIDGE);
    expect(readLedger).toHaveBeenCalledWith({ accountId: ACCOUNT });
  });
  it('rejects a bridge revoked by a sticky id (trusted differs from raw checkpoint)', async () => {
    readLedger.mockResolvedValue(stored(FULL, { bridges: [], devices: [DEVICE] }));
    await expect(requireBridge(good())).rejects.toMatchObject({ status: 401 });
  });
  it('rejects a bridge absent from the roster and an unknown account', async () => {
    readLedger.mockResolvedValue(stored({ bridges: [], devices: [] }, { bridges: [], devices: [] }));
    await expect(requireBridge(good())).rejects.toBeInstanceOf(UnauthorizedError);
    readLedger.mockResolvedValue(null);
    await expect(requireBridge(good())).rejects.toMatchObject({ status: 401 });
  });
  it('rejects a wrong audience, wrong secret, wrong algorithm, expired and missing bearer', async () => {
    const claims = { sub: ACCOUNT, info: { bridgeId: BRIDGE, ownerId: ACCOUNT } };
    for (const request of [
      bearer(claims, { audience: 'other' }), bearer(claims, { secret: 'a-different-secret-that-is-long-enough-1234' }),
      bearer(claims, { algorithm: 'HS512' }), bearer(claims, { expiresIn: -10 }),
      new Request('https://app.test/x'), new Request('https://app.test/x', { headers: { authorization: 'Basic abc' } }),
    ]) await expect(requireBridge(request)).rejects.toMatchObject({ status: 401 });
    expect(readLedger).not.toHaveBeenCalled();
  });
  it('rejects ownerId different from sub, a malformed sub, and missing info', async () => {
    for (const claims of [
      { sub: ACCOUNT, info: { bridgeId: BRIDGE, ownerId: OTHER } },
      { sub: ACCOUNT, info: { bridgeId: BRIDGE } },
      { sub: 'owner@example.test', info: { bridgeId: BRIDGE, ownerId: 'owner@example.test' } },
      { sub: ACCOUNT }, { sub: ACCOUNT, info: { ownerId: ACCOUNT } }, { sub: ACCOUNT, info: { bridgeId: 7, ownerId: ACCOUNT } },
    ]) await expect(requireBridge(bearer(claims))).rejects.toMatchObject({ status: 401 });
    expect(readLedger).not.toHaveBeenCalled();
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
    readLedger.mockResolvedValue(stored(FULL, { bridges: [BRIDGE], devices: [] }));
    await expect(requireAccountOrBridge(request)).rejects.toMatchObject({ status: 401 });
    authMock.mockResolvedValue(null);
    await expect(requireAccountOrBridge(request)).rejects.toMatchObject({ status: 401 });
  });
});

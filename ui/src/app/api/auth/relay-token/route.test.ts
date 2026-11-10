import jwt from 'jsonwebtoken';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { generateAuthKey, signAuthProof, type AuthProof } from '@security/ledger/proof';
import type { LedgerCheckpoint } from '@security/ledger/protocol';

const calls: string[] = [];
const consumeNonce = vi.fn();
const readTrusted = vi.fn();
const readChain = vi.fn();
const consumeRateLimit = vi.fn();
vi.mock('@/lib/auth-nonce-store', () => ({ consumeNonce: (...a: unknown[]) => { calls.push('nonce'); return consumeNonce(...a); } }));
// The decision uses the persisted trusted checkpoint; the stored chain is read only when it is sent back.
vi.mock('@/lib/account-ledger-store', () => ({
  readTrustedCheckpoint: (...a: unknown[]) => { calls.push('checkpoint'); return readTrusted(...a); },
  readLedger: (...a: unknown[]) => { calls.push('chain'); return readChain(...a); },
}));
vi.mock('@/lib/login-rate-limit', () => ({ consumeRateLimit: (...a: unknown[]) => consumeRateLimit(...a) }));
const ipState = vi.hoisted(() => ({ ip: '1.2.3.4' }));
vi.mock('@/lib/client-ip', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/client-ip')>();
  return { ...actual, clientIp: () => ipState.ip, rateLimitKeyIp: () => actual.rateLimitKey(ipState.ip) };
});
vi.mock('next-auth/providers/credentials', () => ({ default: (config: unknown) => config }));

import { POST } from './route';

const SECRET = 's'.repeat(40);
const ORIGIN = 'https://ftown.example';
const ACCOUNT = 'A'.repeat(43);
const DEVICE_ID = 'D'.repeat(43);
const BRIDGE_ID = 'B'.repeat(43);
const NONCE = 'n'.repeat(43);
const HEAD = 'H'.repeat(43);
const LEDGER = { marker: 'ledger' };

const endpoint = (id: string, kind: 'browser' | 'bridge') => ({ version: 1 as const, id, ownerId: ACCOUNT, kind, publicKey: 'p' });
const checkpoint = (over: Partial<LedgerCheckpoint>): LedgerCheckpoint => ({ version: 2, accountId: ACCOUNT, revision: 1, head: HEAD, authorities: [],
  devices: [], bridges: [], revokedDeviceIds: [], revokedBridgeIds: [], revokedCredentialIds: [], ...over } as LedgerCheckpoint);

let deviceKey: CryptoKey; let bridgeKey: CryptoKey;
let trusted: LedgerCheckpoint;

async function proof(over: Partial<Omit<AuthProof, 'signature'>> = {}, key?: CryptoKey): Promise<AuthProof> {
  return signAuthProof(key ?? bridgeKey, { accountId: ACCOUNT, kind: 'bridge', keyId: BRIDGE_ID, nonce: NONCE, purpose: 'relay', audience: ORIGIN, ...over });
}
const req = (body: unknown) => new Request('https://x.example/api/auth/relay-token', { method: 'POST', headers: { 'content-type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body) });
const bridgeBody = async (extra: Record<string, unknown> = {}, over: Partial<Omit<AuthProof, 'signature'>> = {}) =>
  ({ proof: await proof(over), head: HEAD, hostname: 'my-host', ...extra });

beforeEach(async () => {
  calls.length = 0;
  vi.stubEnv('FTOWN_PUBLIC_URL', ORIGIN);
  vi.stubEnv('CENTRIFUGO_TOKEN_SECRET', SECRET);
  vi.stubEnv('NEXT_PUBLIC_CENTRIFUGO_URL', 'wss://relay.example/connection/websocket');
  consumeNonce.mockReset().mockResolvedValue(true);
  consumeRateLimit.mockReset().mockResolvedValue({ allowed: true });
  const d = await generateAuthKey(true); const b = await generateAuthKey(true);
  deviceKey = d.privateKey; bridgeKey = b.privateKey;
  trusted = checkpoint({
    devices: [{ endpoint: endpoint(DEVICE_ID, 'browser'), authPublicKey: d.publicKey, label: 'd', approvedAt: 1 }],
    bridges: [{ bridgeId: BRIDGE_ID, endpoint: endpoint(BRIDGE_ID, 'bridge'), authPublicKey: b.publicKey, label: 'b', approvedAt: 1 }],
  });
  readTrusted.mockReset().mockResolvedValue(trusted);
  readChain.mockReset().mockResolvedValue({ ledger: LEDGER, trusted, sticky: { deviceIds: [], bridgeIds: [] } });
});

describe('POST /api/auth/relay-token', () => {
  it('issues a bridge token with the info claim and 1 h lifetime', async () => {
    const res = await POST(req(await bridgeBody({ localPort: 4242 })));
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    const json = await res.json();
    expect(json.ledger).toBeUndefined();
    const claims = jwt.verify(json.token, SECRET, { audience: 'ftown:centrifugo' }) as jwt.JwtPayload;
    expect(claims.sub).toBe(ACCOUNT);
    expect(claims.exp! - claims.iat!).toBe(3600);
    expect(json.expiresAt).toBe(claims.exp! * 1000);
    expect(claims.info).toMatchObject({ bridgeId: BRIDGE_ID, ownerId: ACCOUNT, hostname: 'my-host', localPort: 4242 });
    expect(typeof claims.info.connectedAt).toBe('string');
    expect(consumeNonce).toHaveBeenCalledWith(NONCE, 'relay');
  });
  it('accepts the exact body {proof, head} for a bridge, omitting hostname and localPort from info', async () => {
    const res = await POST(req({ proof: await proof(), head: HEAD }));
    expect(res.status).toBe(200);
    const info = (jwt.decode((await res.json()).token) as jwt.JwtPayload).info;
    expect(info).toMatchObject({ bridgeId: BRIDGE_ID, ownerId: ACCOUNT });
    expect(info.hostname).toBeUndefined();
    expect(info.localPort).toBeUndefined();
  });
  it('accepts {proof, head, hostname, localPort}', async () => {
    const res = await POST(req({ proof: await proof(), head: HEAD, hostname: 'h1', localPort: 80 }));
    expect(res.status).toBe(200);
    expect((jwt.decode((await res.json()).token) as jwt.JwtPayload).info).toMatchObject({ hostname: 'h1', localPort: 80 });
  });
  it('issues a device token without info', async () => {
    const p = await proof({ kind: 'device', keyId: DEVICE_ID }, deviceKey);
    const res = await POST(req({ proof: p, head: HEAD }));
    expect(res.status).toBe(200);
    const claims = jwt.decode((await res.json()).token) as jwt.JwtPayload;
    expect(claims.sub).toBe(ACCOUNT);
    expect(claims.exp! - claims.iat!).toBe(3600);
    expect(claims.info).toBeUndefined();
  });
  it('includes the ledger only when the head differs, and reads the chain only then', async () => {
    expect((await (await POST(req(await bridgeBody()))).json()).ledger).toBeUndefined();
    expect(readChain).not.toHaveBeenCalled();
    const res = await POST(req(await bridgeBody({ head: 'other' })));
    expect((await res.json()).ledger).toEqual(LEDGER);
    const res2 = await POST(req(await bridgeBody({ head: undefined })));
    expect((await res2.json()).ledger).toEqual(LEDGER);
    expect(readChain).toHaveBeenCalledWith({ accountId: ACCOUNT });
  });
  it('401s without a token when the chain to send back is gone', async () => {
    readChain.mockResolvedValue(null);
    const res = await POST(req(await bridgeBody({ head: 'other' })));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'unauthorized' });
  });
  it('returns centrifugoUrl for bridge and device proofs', async () => {
    expect((await (await POST(req(await bridgeBody()))).json()).centrifugoUrl).toBe('wss://relay.example/connection/websocket');
    const p = await proof({ kind: 'device', keyId: DEVICE_ID }, deviceKey);
    expect((await (await POST(req({ proof: p, head: 'other' }))).json()).centrifugoUrl).toBe('wss://relay.example/connection/websocket');
  });
  it('503s (logged) when the relay URL is not configured', async () => {
    vi.stubEnv('NEXT_PUBLIC_CENTRIFUGO_URL', '');
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect((await POST(req(await bridgeBody()))).status).toBe(503);
    expect(log).toHaveBeenCalled();
    log.mockRestore();
  });
  it('rejects a reused nonce without reading the ledger', async () => {
    consumeNonce.mockResolvedValue(false);
    const res = await POST(req(await bridgeBody()));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'unauthorized' });
    expect(readTrusted).not.toHaveBeenCalled();
  });
  it('consumes the nonce before reading the ledger, and decides from the checkpoint alone', async () => {
    await POST(req(await bridgeBody()));
    expect(calls).toEqual(['nonce', 'checkpoint']);
    expect(readTrusted).toHaveBeenCalledWith(ACCOUNT);
  });
  it('consumes the nonce even when verification fails', async () => {
    const res = await POST(req(await bridgeBody({}, { audience: 'https://evil.example' })));
    expect(res.status).toBe(401);
    expect(consumeNonce).toHaveBeenCalledTimes(1);
  });
  it('rejects a wrong audience, a session-purpose proof and a malformed proof', async () => {
    expect((await POST(req(await bridgeBody({}, { audience: 'https://evil.example' })))).status).toBe(401);
    expect((await POST(req(await bridgeBody({}, { purpose: 'session' })))).status).toBe(401);
    expect(consumeNonce).not.toHaveBeenCalledWith(NONCE, 'session');
    expect((await POST(req({ proof: { nope: 1 }, head: HEAD }))).status).toBe(401);
  });
  it('rejects a bad signature with a plain 401 and no ledger', async () => {
    const wrongKey = (await generateAuthKey(true)).privateKey;
    const res = await POST(req({ proof: await proof({}, wrongKey), head: HEAD, hostname: 'h' }));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'unauthorized' });
    expect(readChain).not.toHaveBeenCalled();
  });
  it('returns key_revoked with the ledger as evidence for a revoked bridge', async () => {
    const t = checkpoint({ ...trusted, bridges: [], revokedBridgeIds: [BRIDGE_ID] });
    readTrusted.mockResolvedValue(t);
    const res = await POST(req(await bridgeBody()));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'key_revoked', ledger: LEDGER });
  });
  it('returns key_revoked for a sticky-revoked bridge (the trusted checkpoint lists it as revoked)', async () => {
    const t = checkpoint({ ...trusted, bridges: [], revokedBridgeIds: [BRIDGE_ID] });
    readTrusted.mockResolvedValue(t);
    const res = await POST(req(await bridgeBody()));
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe('key_revoked');
  });
  it('returns key_revoked for a revoked device', async () => {
    const t = checkpoint({ ...trusted, devices: [], revokedDeviceIds: [DEVICE_ID] });
    readTrusted.mockResolvedValue(t);
    const res = await POST(req({ proof: await proof({ kind: 'device', keyId: DEVICE_ID }, deviceKey), head: HEAD }));
    expect((await res.json()).error).toBe('key_revoked');
  });
  it('gives a plain 401 with no ledger for an unknown key or account', async () => {
    const unknown = 'U'.repeat(43);
    const res = await POST(req(await bridgeBody({}, { keyId: unknown })));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'unauthorized' });
    readTrusted.mockResolvedValue(null);
    expect((await POST(req(await bridgeBody()))).status).toBe(401);
    expect(readChain).not.toHaveBeenCalled();
  });
  it('validates a present bridge hostname and localPort before consuming the nonce', async () => {
    expect((await POST(req(await bridgeBody({ hostname: '' })))).status).toBe(400);
    expect((await POST(req(await bridgeBody({ localPort: 70000 })))).status).toBe(400);
    expect(consumeNonce).not.toHaveBeenCalled();
  });
  it('rejects malformed and oversized bodies', async () => {
    expect((await POST(req('{nope'))).status).toBe(400);
    expect((await POST(req(JSON.stringify({ pad: 'x'.repeat(17000) })))).status).toBe(413);
    const noType = new Request('https://x.example/api/auth/relay-token', { method: 'POST', body: '{}' });
    expect((await POST(noType)).status).toBe(400);
    expect((await POST(req('[]'))).status).toBe(400);
  });
  it('rate limits by IP before any work, and by account+key on success', async () => {
    consumeRateLimit.mockResolvedValueOnce({ allowed: false, retryAfterMs: 5000 });
    const res = await POST(req(await bridgeBody()));
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('5');
    expect(consumeNonce).not.toHaveBeenCalled();
    consumeRateLimit.mockReset().mockResolvedValueOnce({ allowed: true }).mockResolvedValueOnce({ allowed: false, retryAfterMs: 1000 });
    expect((await POST(req(await bridgeBody()))).status).toBe(429);
    expect(consumeRateLimit).toHaveBeenCalledWith('relay-token-key', `${ACCOUNT}:${BRIDGE_ID}`, { maxAttempts: 30, lockoutMs: 600000 });
  });
  it('503s when storage fails', async () => {
    readTrusted.mockRejectedValue(new Error('account_ledger_corrupt'));
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect((await POST(req(await bridgeBody()))).status).toBe(503);
    expect(log).toHaveBeenCalled();
    log.mockRestore();
  });
});

describe('relay-token-ip limiter key', () => {
  const keyFor = async (ip: string) => {
    ipState.ip = ip;
    consumeRateLimit.mockClear();
    await POST(req({}));
    return consumeRateLimit.mock.calls.find(c => c[0] === 'relay-token-ip')![1];
  };
  it('shares one key across addresses of the same IPv6 /64, separates other /64s, leaves IPv4 unchanged', async () => {
    const a = await keyFor('2001:db8:1:2::1');
    const b = await keyFor('2001:db8:1:2:ffff:aaaa:bbbb:cccc');
    const c = await keyFor('2001:db8:1:3::1');
    expect(a).toBe(b);
    expect(c).not.toBe(a);
    expect(await keyFor('1.2.3.4')).toBe('1.2.3.4');
    expect(await keyFor('unknown')).toBe('unknown');
    ipState.ip = '1.2.3.4';
  });
});

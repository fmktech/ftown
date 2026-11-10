import { afterEach, beforeEach, it, expect, vi } from 'vitest';
import jwt from 'jsonwebtoken';
import { generateEndpoint } from '@security/crypto';
const mocks = vi.hoisted(() => ({ auth: vi.fn(), query: vi.fn(), readLedger: vi.fn() }));
vi.mock('@/lib/auth', () => ({ auth: mocks.auth }));
vi.mock('@/lib/db', () => ({ getDb: () => ({ query: mocks.query }) }));
// Auth reads the persisted trusted checkpoint (readTrustedCheckpoint); the fixtures below describe the stored row.
vi.mock('@/lib/account-ledger-store', () => ({ readTrustedCheckpoint: async (accountId: string) => ((await mocks.readLedger({ accountId })) as { trusted?: unknown } | null | undefined)?.trusted ?? null }));
vi.mock('@/lib/auth-nonce-store', () => ({ consumeNonce: vi.fn() }));
vi.mock('next-auth/providers/credentials', () => ({ default: (config: unknown) => config }));
import { PUT, GET } from './route';
const account = 'A'.repeat(43);
const other = 'B'.repeat(43);
const secret = 'isolated-test-signing-key-not-production-12345';
type Ep = { id: string; publicKey: string };
interface Roster { devices: Ep[]; bridges: Array<{ bridgeId: string; endpoint: Ep }> }
const view = (r: Roster) => ({ devices: r.devices.map(endpoint => ({ endpoint })), bridges: r.bridges });
const ledger = (trusted: Roster, raw: Roster = trusted) => ({ checkpoint: view(raw), trusted: view(trusted), ledger: {}, sticky: { deviceIds: [], bridgeIds: [] } });
const ep = async (kind: 'browser' | 'bridge', owner = account) => (await generateEndpoint(owner, kind)).endpoint;
afterEach(() => { vi.resetAllMocks(); vi.unstubAllEnvs(); });
const session = (endpointId: string) => mocks.auth.mockResolvedValue({ user: { id: account, endpointId } });
const entryOf = (endpoint: Awaited<ReturnType<typeof ep>>, bridgeId: string | null) => ({ endpoint, bridgeId, label: 'L', protocolVersion: 1 });
const browserPut = (entry: unknown, origin = 'https://app.test') => new Request('https://app.test/api/security/endpoints', { method: 'PUT', headers: { 'Content-Type': 'application/json', origin }, body: JSON.stringify(entry) });
const bridgePut = (entry: unknown, bridgeId: string, sub = account) => new Request('https://app.test/api/security/endpoints', { method: 'PUT',
  headers: { 'Content-Type': 'application/json', authorization: `Bearer ${jwt.sign({ sub, info: { bridgeId, ownerId: sub } }, secret, { audience: 'ftown:centrifugo', expiresIn: 60 })}` }, body: JSON.stringify(entry) });

it('browser writes only its own device endpoint, with CSRF check first', async () => {
  const mine = await ep('browser'); const stranger = await ep('browser'); const bridgeEp = await ep('bridge');
  session(mine.id);
  mocks.readLedger.mockResolvedValue(ledger({ devices: [mine, stranger], bridges: [{ bridgeId: 'bridge-a', endpoint: bridgeEp }] }));
  mocks.query.mockResolvedValue([{ endpoint_id: mine.id }]);
  expect((await PUT(browserPut(entryOf(mine, null), 'https://evil.test'))).status).toBe(403);
  expect(mocks.query).not.toHaveBeenCalled();
  // another key (even another trusted device's key), a bridge's key, and a foreign account: all 403
  expect((await PUT(browserPut(entryOf(stranger, null)))).status).toBe(403);
  expect((await PUT(browserPut(entryOf(bridgeEp, null)))).status).toBe(400);   // role/bridgeId mismatch rejected at parse
  expect((await PUT(browserPut(entryOf({ ...bridgeEp, kind: 'browser' }, null)))).status).toBe(403);  // a bridge's key relabelled as browser

  expect((await PUT(browserPut(entryOf({ ...mine, ownerId: other }, null)))).status).toBe(403);
  expect((await PUT(browserPut(entryOf({ ...mine, publicKey: stranger.publicKey }, null)))).status).toBe(400);  // id/key hash mismatch rejected at parse
  expect(mocks.query).not.toHaveBeenCalled();
  expect((await PUT(browserPut(entryOf(mine, null)))).status).toBe(200);
  expect(mocks.query.mock.calls.at(-1)?.[1][0]).toBe(account);
});
it('a browser session cannot publish a bridge entry', async () => {
  const mine = await ep('browser'); const bridgeEp = await ep('bridge');
  session(mine.id); mocks.readLedger.mockResolvedValue(ledger({ devices: [mine], bridges: [{ bridgeId: 'bridge-a', endpoint: bridgeEp }] }));
  expect((await PUT(browserPut(entryOf(bridgeEp, 'bridge-a')))).status).toBe(403); expect(mocks.query).not.toHaveBeenCalled();
});
it('bridge writes only its own entry and the endpoint key the ledger lists for it', async () => {
  vi.stubEnv('CENTRIFUGO_TOKEN_SECRET', secret);
  const a = await ep('bridge'); const b = await ep('bridge'); const dev = await ep('browser');
  mocks.readLedger.mockResolvedValue(ledger({ devices: [dev], bridges: [{ bridgeId: 'bridge-a', endpoint: a }, { bridgeId: 'bridge-b', endpoint: b }] }));
  expect((await PUT(bridgePut(entryOf(a, 'bridge-a'), 'bridge-b'))).status).toBe(403);   // another bridge's id
  expect((await PUT(bridgePut(entryOf(b, 'bridge-a'), 'bridge-a'))).status).toBe(403);   // another bridge's key under its own id
  expect((await PUT(bridgePut(entryOf(dev, null), 'bridge-a'))).status).toBe(403);       // a browser key
  expect((await PUT(bridgePut(entryOf(a, 'bridge-a'), 'bridge-a', other))).status).toBe(403);
  expect(mocks.query).not.toHaveBeenCalled();
  // sticky-revoked bridge: raw lists it, trusted does not
  mocks.readLedger.mockResolvedValue(ledger({ devices: [dev], bridges: [] }, { devices: [dev], bridges: [{ bridgeId: 'bridge-a', endpoint: a }] }));
  expect((await PUT(bridgePut(entryOf(a, 'bridge-a'), 'bridge-a'))).status).toBe(401);
  mocks.readLedger.mockResolvedValue(ledger({ devices: [dev], bridges: [{ bridgeId: 'bridge-a', endpoint: a }] }));
  mocks.query.mockResolvedValueOnce([{ endpoint_id: a.id }]);
  expect((await PUT(bridgePut(entryOf(a, 'bridge-a'), 'bridge-a'))).status).toBe(200);
  expect(mocks.auth).not.toHaveBeenCalled();
});
it('an upsert that would overwrite another principal row is blocked with 409', async () => {
  const mine = await ep('browser'); session(mine.id);
  mocks.readLedger.mockResolvedValue(ledger({ devices: [mine], bridges: [] }));
  mocks.query.mockResolvedValue([]);
  const res = await PUT(browserPut(entryOf(mine, null)));
  expect(res.status).toBe(409); expect(await res.json()).toEqual({ error: 'conflict' });
  expect(String(mocks.query.mock.calls[0][0])).toContain('IS NOT DISTINCT FROM EXCLUDED.bridge_id');
});
it('anonymous or revoked-device directory reads never expose endpoint metadata', async () => {
  mocks.auth.mockResolvedValue(null);
  expect((await GET()).status).toBe(401); expect(mocks.query).not.toHaveBeenCalled();
  const mine = await ep('browser'); session(mine.id);
  mocks.readLedger.mockResolvedValue(ledger({ devices: [], bridges: [] }, { devices: [mine], bridges: [] }));
  expect((await GET()).status).toBe(401); expect(mocks.query).not.toHaveBeenCalled();
});
it('GET lists only endpoints that are current trusted devices/bridges (revoked and sticky-revoked are hidden)', async () => {
  const me = await ep('browser'); const gone = await ep('browser'); const live = await ep('bridge'); const dead = await ep('bridge');
  session(me.id);
  mocks.readLedger.mockResolvedValue(ledger({ devices: [me], bridges: [{ bridgeId: 'live', endpoint: live }] },
    { devices: [me, gone], bridges: [{ bridgeId: 'live', endpoint: live }, { bridgeId: 'dead', endpoint: dead }] }));
  mocks.query.mockResolvedValue([me, gone, live, dead].map((endpoint, i) => ({ entry: entryOf(endpoint, i < 2 ? null : (i === 2 ? 'live' : 'dead')) })));
  const res = await GET();
  expect(res.status).toBe(200);
  const body = await res.json() as { ownerId: string; endpoints: Array<{ endpoint: { id: string } }> };
  expect(body.ownerId).toBe(account);
  expect(body.endpoints.map(e => e.endpoint.id).sort()).toEqual([me.id, live.id].sort());
  expect(mocks.query.mock.calls[0][1]).toEqual([account]);
});
it('configured public origin reaches browser authentication without granting endpoint registration', async () => {
  vi.stubEnv('FTOWN_PUBLIC_URL', 'https://localhost:8444');
  mocks.auth.mockResolvedValue(null);
  const body = entryOf(await ep('browser'), null);
  const req = (origin: string) => new Request('https://localhost:3000/api/security/endpoints', { method: 'PUT',
    headers: { 'Content-Type': 'application/json', origin }, body: JSON.stringify(body) });
  const accepted = await PUT(req('https://localhost:8444'));
  expect(accepted.status).toBe(401); expect(await accepted.json()).toEqual({ error: 'unauthorized' });
  const rejected = await PUT(req('https://evil.test'));
  expect(rejected.status).toBe(403); expect(await rejected.json()).toEqual({ error: 'forbidden_origin' });
  expect(mocks.auth).toHaveBeenCalledTimes(1); expect(mocks.query).not.toHaveBeenCalled();
});

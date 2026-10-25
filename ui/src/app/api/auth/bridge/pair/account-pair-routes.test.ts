import { beforeEach, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { randomBytes } from 'node:crypto';
import { generateEndpoint } from '@security/crypto';
import { createAccountEnrollment, createAccountGenesis, generateAccountBridgeCandidate, generateAccountSigningIdentity, sealAccountApproval, signAccountTransition, verifyAccountHistory } from '@security/account-crypto';
const mocks = vi.hoisted(() => ({ auth: vi.fn(), query: vi.fn(), create: vi.fn(), get: vi.fn(), lookup: vi.fn(), approve: vi.fn(), consume: vi.fn(), upsert: vi.fn(), refreshOwner: vi.fn() }));
vi.mock('@/lib/auth', () => ({ auth: mocks.auth }));
vi.mock('@/lib/db', () => ({ getDb: () => ({ query: mocks.query }) }));
vi.mock('@/lib/pairing-store', () => ({ createPairingRequest: mocks.create, deleteExpiredRequests: vi.fn(), getByDeviceCode: mocks.get, getByUserCode: mocks.lookup,
  approvePairingRequest: mocks.approve, consumePairingRequest: mocks.consume }));
vi.mock('@/lib/bridge-refresh', () => ({ getBridgeRefreshOwner: mocks.refreshOwner, upsertBridgeRefresh: mocks.upsert, getOwnerIdForSub: async () => '349f8d2e-38e4-4d59-888d-687dcfa19e39' }));
vi.mock('@/lib/login-rate-limit', () => ({ checkRateLimit: async () => ({ allowed: true }), recordAttempt: vi.fn() }));
import { POST as start } from './start/route';
import { POST as lookup } from './lookup/route';
import { POST as approve } from './approve/route';
import { POST as poll } from './poll/route';
const owner = '349f8d2e-38e4-4d59-888d-687dcfa19e39';
beforeEach(() => {
  vi.resetAllMocks();
  process.env.FTOWN_PUBLIC_URL = 'https://public.test';
  const key = randomBytes(32).toString('hex');
  process.env.CENTRIFUGO_TOKEN_SECRET = key;
  process.env.NEXT_PUBLIC_CENTRIFUGO_URL = 'wss://broker.test';
  mocks.auth.mockResolvedValue({ user: { id: owner, email: 'owner@example.test' } });
  mocks.refreshOwner.mockResolvedValue(null);
  mocks.upsert.mockResolvedValue(true);
});
const request = (body: unknown, origin = 'https://public.test') => new NextRequest('https://localhost:3000/api/auth/bridge/pair/poll', { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify(body) });
async function fixture() {
  const now = Date.now();
  const admin = await generateEndpoint(owner, 'browser');
  const signing = await generateAccountSigningIdentity();
  const history = { genesis: await createAccountGenesis(owner, admin.endpoint, signing, 'Browser', now), transitions: [] };
  const first = await verifyAccountHistory(history, null, now);
  const bridge = await generateAccountBridgeCandidate('bridge-a');
  const link = await createAccountEnrollment(bridge, 'Computer', null, 'bridge-a', now);
  const addition = await signAccountTransition(first, admin.endpoint.id, signing, { type: 'add_bridge', bridge: { bridgeId: 'bridge-a', endpoint: { ...bridge.endpoint, ownerId: owner }, label: 'Computer', approvedAt: new Date(now).toISOString() } }, now);
  const accountHistory = { ...history, transitions: [addition] };
  const checkpoint = await verifyAccountHistory(accountHistory, first, now);
  const bundle = await sealAccountApproval(admin, link, accountHistory, now);
  const row = { deviceCode: 'device', userCode: 'ABCD-1234', bridgeId: 'bridge-a', hostname: 'Computer', platform: 'linux', status: 'approved', sub: 'owner@example.test', refreshJti: 'jti',
    expiresAt: link.request.expiresAt, createdAt: new Date(now).toISOString(), approvedAt: new Date(now).toISOString(), enrollment: link.request, accountApproval: bundle };
  mocks.query.mockResolvedValue([{ root_id: checkpoint.rootId, revision: checkpoint.revision, head: checkpoint.head, history: accountHistory }]);
  return { link, bundle, row, accountHistory };
}
it('start binds public enrollment to exact bridge and response never includes fragment secret', async () => {
  const f = await fixture();
  const result = await start(request({ bridgeId: 'bridge-a', hostname: 'Computer', platform: 'linux', enrollment: f.link.request }));
  expect(result.status).toBe(200);
  expect(mocks.create.mock.calls[0][0].enrollment).toEqual(f.link.request);
  expect(mocks.create.mock.calls[0][0].expiresAtIso).toBe(f.link.request.expiresAt);
  expect(JSON.stringify(await result.json())).not.toContain(f.link.secret);
  expect((await start(request({ bridgeId: 'other', enrollment: f.link.request }))).status).toBe(400);
  expect((await start(request({ bridgeId: 'bridge-a', enrollment: f.link }))).status).toBe(400);
});
it('lookup returns exact enrollment and rejects foreign Origin without looking up requests', async () => {
  const f = await fixture();
  mocks.lookup.mockResolvedValue(f.row);
  const result = await lookup(request({ userCode: f.row.userCode }));
  expect(result.status).toBe(200);
  expect((await result.json()).enrollment).toEqual(f.link.request);
  mocks.lookup.mockClear();
  expect((await lookup(request({ userCode: f.row.userCode }, 'https://evil.test'))).status).toBe(403);
  expect(mocks.lookup).not.toHaveBeenCalled();
});
it('new approval cannot downgrade to legacy or accept substituted recipient, and CAS binding is passed to store', async () => {
  const f = await fixture();
  mocks.lookup.mockResolvedValue(f.row);
  expect((await approve(request({ userCode: f.row.userCode }))).status).toBe(400);
  expect(mocks.approve).not.toHaveBeenCalled();
  expect((await approve(request({ userCode: f.row.userCode, accountApproval: { ...f.bundle, envelope: { ...f.bundle.envelope, recipientId: f.bundle.approver.id } } }))).status).toBe(400);
  expect(mocks.approve).not.toHaveBeenCalled();
  mocks.approve.mockResolvedValue(f.row);
  expect((await approve(request({ userCode: f.row.userCode, accountApproval: f.bundle }))).status).toBe(200);
  expect(mocks.approve.mock.calls[0][3]).toMatchObject({ ownerId: owner, enrollment: f.link.request, bundle: f.bundle });
});
it('poll validates approval and returns public history with token bundle only after successful exact consumption', async () => {
  const f = await fixture();
  mocks.get.mockResolvedValue(f.row); mocks.consume.mockResolvedValue(f.row);
  const result = await poll(request({ deviceCode: f.row.deviceCode }));
  expect(result.status).toBe(200);
  expect(await result.json()).toMatchObject({ status: 'approved', ownerId: owner, accountApproval: f.bundle, accountHistory: f.accountHistory });
  expect(mocks.consume.mock.calls[0][1]).toMatchObject({ ownerId: owner, enrollment: f.link.request, bundle: f.bundle });
});
it('expired approved rows, malformed adverts and missing account binding never consume or issue credentials', async () => {
  const f = await fixture();
  mocks.get.mockResolvedValue({ ...f.row, expiresAt: new Date(Date.now() - 1).toISOString() });
  expect(await (await poll(request({ deviceCode: f.row.deviceCode }))).json()).toEqual({ status: 'expired' });
  mocks.get.mockResolvedValue(f.row);
  expect((await poll(request({ deviceCode: f.row.deviceCode, localPort: 0 }))).status).toBe(400);
  mocks.get.mockResolvedValue({ ...f.row, accountApproval: null });
  expect((await poll(request({ deviceCode: f.row.deviceCode }))).status).toBe(400);
  expect(mocks.consume).not.toHaveBeenCalled();
  expect(mocks.upsert).not.toHaveBeenCalled();
});

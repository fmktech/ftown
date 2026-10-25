import { beforeEach, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { randomBytes, randomUUID } from 'node:crypto';
import jwt from 'jsonwebtoken';
import type { CredentialSnapshot } from '@/lib/pending-approval-store';
const mocks = vi.hoisted(() => ({ get: vi.fn(), lookup: vi.fn(), create: vi.fn(), deliver: vi.fn(), approve: vi.fn(), consume: vi.fn(), upsert: vi.fn() }));
vi.mock('@/lib/auth', () => ({ auth: async () => ({ user: { id: '349f8d2e-38e4-4d59-888d-687dcfa19e39', email: 'owner@ftown.test' } }) }));
vi.mock('@/lib/pairing-store', () => ({ getByDeviceCode: mocks.get, getByUserCode: mocks.lookup, approvePairingRequest: mocks.approve, consumePairingRequest: mocks.consume, createPairingRequest: vi.fn(), deleteExpiredRequests: vi.fn() }));
vi.mock('@/lib/bridge-refresh', () => ({ upsertBridgeRefresh: mocks.upsert, getBridgeRefreshOwner: vi.fn(), getOwnerIdForSub: vi.fn() }));
vi.mock('@/lib/pending-approval-store', () => ({ PendingApprovalStore: class { startBridge = mocks.create; deliver = mocks.deliver; } }));
vi.mock('@/lib/login-rate-limit', () => ({ checkRateLimit: async () => ({ allowed: true }), recordAttempt: vi.fn() }));
import { POST as poll } from './poll/route';
import { POST as approve } from './approve/route';
import { POST as lookup } from './lookup/route';
const owner = '349f8d2e-38e4-4d59-888d-687dcfa19e39';
const request = (body: unknown) => new NextRequest('https://public.test/api/auth/bridge/pair/poll', { method: 'POST', headers: { origin: 'https://public.test', 'content-type': 'application/json' }, body: JSON.stringify(body) });
beforeEach(() => {
  vi.clearAllMocks(); vi.stubEnv('FTOWN_PUBLIC_URL', 'https://public.test'); vi.stubEnv('CENTRIFUGO_TOKEN_SECRET', randomBytes(32).toString('hex')); vi.stubEnv('NEXT_PUBLIC_CENTRIFUGO_URL', 'wss://broker.test');
  mocks.get.mockResolvedValue({ pendingV1: true, status: 'consumed' });
});
it('pending delivery replays persisted iat/exp/JTI and flat discovery advert without legacy consume/upsert or local capability', async () => {
  const iat = Math.floor(Date.now() / 1000) - 50; const jti = randomUUID();
  const snapshot: CredentialSnapshot = { ownerId: owner, sub: 'owner@ftown.test', bridgeId: 'bridge-a', jti,
    connection: { sub: 'owner@ftown.test', info: { bridgeId: 'bridge-a', ownerId: owner, hostname: 'Computer', connectedAt: new Date(iat * 1000).toISOString(), localPort: 23456 }, iat, exp: iat + 86400, aud: 'ftown:centrifugo' },
    refresh: { sub: 'owner@ftown.test', bridgeId: 'bridge-a', ownerId: owner, type: 'bridge_refresh', jti, iat, exp: iat + 30 * 86400, aud: 'ftown:bridge-refresh' } };
  mocks.deliver.mockResolvedValue({ snapshot, state: { status: 'approved', result: { publicFixture: true } } });
  const first = await (await poll(request({ deviceCode: 'private-code', localPort: 23456, localNonce: 'must-stay-local' }))).json();
  const second = await (await poll(request({ deviceCode: 'private-code', localPort: 34567 }))).json();
  expect(second).toEqual(first); expect(first).toMatchObject({ status: 'approved', ownerId: owner, userId: snapshot.sub, centrifugoUrl: 'wss://broker.test', pendingApproval: { publicFixture: true } });
  expect(jwt.decode(first.token)).toEqual(snapshot.connection); expect(jwt.decode(first.refreshToken)).toEqual(snapshot.refresh);
  expect(mocks.deliver.mock.calls).toEqual([['private-code', 23456], ['private-code', 34567]]);
  expect(JSON.stringify(first)).not.toContain('must-stay-local'); expect(JSON.stringify(jwt.decode(first.token))).not.toContain('localNonce');
  expect(mocks.consume).not.toHaveBeenCalled(); expect(mocks.upsert).not.toHaveBeenCalled();
});
it('pending poll requires validated port/config and never silently falls through to legacy consumption', async () => {
  expect((await poll(request({ deviceCode: 'private-code' }))).status).toBe(400);
  expect((await poll(request({ deviceCode: 'private-code', localPort: 0 }))).status).toBe(400);
  vi.stubEnv('NEXT_PUBLIC_CENTRIFUGO_URL', '');
  expect((await poll(request({ deviceCode: 'private-code', localPort: 23456 }))).status).toBe(500);
  expect(mocks.deliver).not.toHaveBeenCalled(); expect(mocks.consume).not.toHaveBeenCalled();
});
it('legacy lookup and approval cannot switch a pending-v1 request into fragment/auth-only protocol', async () => {
  mocks.lookup.mockResolvedValue({ pendingV1: true, status: 'pending' });
  expect((await lookup(request({ userCode: 'ABCD-1234' }))).status).toBe(409);
  expect((await approve(request({ userCode: 'ABCD-1234' }))).status).toBe(409);
  expect(mocks.approve).not.toHaveBeenCalled();
});

import { beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ auth: vi.fn(), rate: vi.fn(), create: vi.fn(), inbox: vi.fn(), read: vi.fn(), reviewer: vi.fn(), candidate: vi.fn(), query: vi.fn(), connections: 0, published: [] as Array<{ channel: string; data: unknown }>, change: null as unknown }));
vi.mock('@/lib/auth', () => ({ auth: mocks.auth }));
vi.mock('@/lib/db', () => ({ getDb: () => ({ query: mocks.query }) }));
vi.mock('@/lib/login-rate-limit', () => ({ checkRateLimit: mocks.rate, recordAttempt: vi.fn() }));
vi.mock('@/lib/pending-approval-store', () => ({ PENDING_NORMALIZED_EMAIL_SQL: 'norm(email)', PendingApprovalStore: class {
  createBrowser = mocks.create; inbox = mocks.inbox; read = mocks.read; reviewer = mocks.reviewer; candidate = mocks.candidate;
  change = mocks.change;
} }));
vi.mock('centrifuge', () => ({ Centrifuge: class {
  private handlers: Record<string, () => void> = {};
  on(event: string, handler: () => void) { this.handlers[event] = handler; return this; }
  connect() { mocks.connections++; queueMicrotask(() => this.handlers.connected?.()); }
  disconnect() {}
  async publish(channel: string, data: unknown) { mocks.published.push({ channel, data }); return {}; }
} }));
import { pendingCreate, pendingInbox, pendingRead, pendingReview, pendingCandidate } from './pending-approval-http';
const owner = '349f8d2e-38e4-4d59-888d-687dcfa19e39';
const request = (path: string, body?: unknown, origin?: string) => new Request('https://localhost:3000/api/security/approvals' + path,
  { method: body === undefined ? 'GET' : 'POST', headers: { ...(origin ? { origin } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
beforeEach(() => { vi.clearAllMocks(); mocks.published.length = 0; mocks.connections = 0; mocks.change = null; vi.stubEnv('CENTRIFUGO_TOKEN_SECRET', 'k'.repeat(48)); vi.stubEnv('NEXT_PUBLIC_CENTRIFUGO_URL', 'wss://hub.test/ws'); vi.stubEnv('FTOWN_PUBLIC_URL', 'https://localhost:8444'); mocks.auth.mockResolvedValue({ user: { id: owner } }); mocks.rate.mockResolvedValue({ allowed: true }); mocks.query.mockImplementation(async (text: string) => text.includes('FROM users') ? [{ email: 'Owner@Example.test' }] : [{ failed_count: 1, retry_after: 60 }]); });
it('anonymous public-proxy mutation reaches authentication; foreign/missing origins stop before auth', async () => {
  mocks.auth.mockResolvedValue(null);
  expect((await pendingCreate(request('', {}, 'https://localhost:8444'))).status).toBe(401);
  mocks.auth.mockClear();
  for (const origin of [undefined, 'https://evil.test']) expect((await pendingCreate(request('', {}, origin))).status).toBe(403);
  expect(mocks.auth).not.toHaveBeenCalled(); expect(mocks.create).not.toHaveBeenCalled();
});
it('authenticated GET works without Origin and keeps immutable owner/no-store', async () => {
  mocks.inbox.mockResolvedValue({ requests: [] }); mocks.read.mockResolvedValue({ status: 'pending' });
  const result = await pendingInbox(request(''));
  expect(result.status).toBe(200); expect(result.headers.get('cache-control')).toBe('no-store'); expect(mocks.inbox).toHaveBeenCalledWith(owner);
  expect((await pendingRead(request('/id'), 'id')).status).toBe(200); expect(mocks.read).toHaveBeenCalledWith(owner, 'id');
  expect((await pendingInbox(request('', undefined, 'https://evil.test'))).status).toBe(403);
});
it('review forwards signed JSON only after browser session and origin gates; cookie cannot become server signing authority', async () => {
  mocks.reviewer.mockResolvedValue({ status: 'offered' });
  const payload = { ownerId: 'attacker', action: { type: 'reject' } };
  expect((await pendingReview(request('/id', payload, 'https://localhost:8444'), 'id')).status).toBe(200);
  expect(mocks.reviewer).toHaveBeenCalledWith(owner, 'id', payload);
  mocks.auth.mockResolvedValue(null);
  expect((await pendingReview(request('/id', payload, 'https://localhost:8444'), 'id')).status).toBe(401);
});
it('candidate RPC needs its credential instead of cookie, supports CLI without Origin and rejects foreign browser Origin', async () => {
  mocks.auth.mockResolvedValue(null); mocks.candidate.mockResolvedValue({ status: 'pending' });
  const payload = { candidateToken: 'opaque', action: { type: 'read' } };
  expect((await pendingCandidate(request('/id/candidate', payload), 'id')).status).toBe(200);
  expect(mocks.candidate).toHaveBeenCalledWith('id', payload); expect(mocks.auth).not.toHaveBeenCalled();
  expect((await pendingCandidate(request('/id/candidate', payload, 'https://evil.test'), 'id')).status).toBe(403);
});
it('oversized body and rate exhaustion never reach store; errors expose no database text', async () => {
  expect((await pendingCreate(request('', { value: 'x'.repeat(65536) }, 'https://localhost:8444'))).status).toBe(413);
  expect(mocks.create).not.toHaveBeenCalled();
  mocks.rate.mockResolvedValue({ allowed: false });
  expect((await pendingCandidate(request('/id/candidate', {}), 'id')).status).toBe(429);
  expect(mocks.candidate).not.toHaveBeenCalled();
  mocks.rate.mockResolvedValue({ allowed: true }); mocks.inbox.mockRejectedValue(new Error('private database internals'));
  const result = await pendingInbox(request(''));
  expect(result.status).toBe(503); expect(await result.text()).not.toContain('private database internals');
});

const settle = () => new Promise(resolve => setTimeout(resolve, 30));
const nudge = (scope: string) => ({ channel: 'bridges:security#Owner@Example.test', data: { type: 'ftown_security_changed', version: 1, scope } });
it('publishes exactly one approvals nudge per real state change from browser create, reviewer and candidate (bridge) routes', async () => {
  mocks.create.mockResolvedValue({ status: 'pending' }); mocks.reviewer.mockResolvedValue({ status: 'offered' }); mocks.candidate.mockResolvedValue({ status: 'cancelled' });
  mocks.change = { target: 'owner@example.test', account: false };
  expect((await pendingCreate(request('', {}, 'https://localhost:8444'))).status).toBe(200); await settle();
  expect(mocks.published).toEqual([nudge('approvals')]);
  mocks.published.length = 0;
  expect((await pendingReview(request('/id', {}, 'https://localhost:8444'), 'id')).status).toBe(200); await settle();
  expect(mocks.published).toEqual([nudge('approvals')]);
  mocks.published.length = 0;
  mocks.auth.mockResolvedValue(null);
  expect((await pendingCandidate(request('/id/candidate', { action: { type: 'cancel' } }), 'id')).status).toBe(200); await settle();
  expect(mocks.published).toEqual([nudge('approvals')]);
  expect(mocks.query).toHaveBeenCalledWith(expect.stringContaining('FROM users'), ['owner@example.test']);
});
it('a reviewer commit that wrote account history also publishes one account nudge', async () => {
  mocks.reviewer.mockResolvedValue({ status: 'approved' }); mocks.change = { target: 'owner@example.test', account: true };
  await pendingReview(request('/id', {}, 'https://localhost:8444'), 'id'); await settle();
  expect(mocks.published).toEqual(expect.arrayContaining([nudge('approvals'), nudge('account')])); expect(mocks.published).toHaveLength(2); expect(mocks.connections).toBe(1);
});
it('polls, reads, idempotent replays and failures publish nothing (candidate read poll x30)', async () => {
  mocks.auth.mockResolvedValue(null); mocks.candidate.mockResolvedValue({ status: 'pending' }); mocks.inbox.mockResolvedValue({ requests: [] }); mocks.read.mockResolvedValue({ status: 'pending' });
  mocks.create.mockResolvedValue({ status: 'pending' }); mocks.reviewer.mockResolvedValue({ status: 'pending' });
  for (let i = 0; i < 30; i++) await pendingCandidate(request('/id/candidate', { action: { type: 'read' } }), 'id');
  await pendingInbox(request('')); await pendingRead(request('/id'), 'id');
  mocks.auth.mockResolvedValue({ user: { id: owner } });
  await pendingCreate(request('', {}, 'https://localhost:8444'));
  await pendingReview(request('/id', {}, 'https://localhost:8444'), 'id');
  mocks.reviewer.mockRejectedValue(new Error('conflict')); mocks.change = { target: 'owner@example.test', account: false };
  expect((await pendingReview(request('/id', {}, 'https://localhost:8444'), 'id')).status).toBe(503);
  await settle();
  expect(mocks.published).toEqual([]);
});

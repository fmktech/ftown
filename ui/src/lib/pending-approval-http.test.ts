import { beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ auth: vi.fn(), rate: vi.fn(), create: vi.fn(), inbox: vi.fn(), read: vi.fn(), reviewer: vi.fn(), candidate: vi.fn(), query: vi.fn() }));
vi.mock('@/lib/auth', () => ({ auth: mocks.auth }));
vi.mock('@/lib/db', () => ({ getDb: () => ({ query: mocks.query }) }));
vi.mock('@/lib/login-rate-limit', () => ({ checkRateLimit: mocks.rate, recordAttempt: vi.fn() }));
vi.mock('@/lib/pending-approval-store', () => ({ PendingApprovalStore: class {
  createBrowser = mocks.create; inbox = mocks.inbox; read = mocks.read; reviewer = mocks.reviewer; candidate = mocks.candidate;
} }));
import { pendingCreate, pendingInbox, pendingRead, pendingReview, pendingCandidate } from './pending-approval-http';
const owner = '349f8d2e-38e4-4d59-888d-687dcfa19e39';
const request = (path: string, body?: unknown, origin?: string) => new Request('https://localhost:3000/api/security/approvals' + path,
  { method: body === undefined ? 'GET' : 'POST', headers: { ...(origin ? { origin } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
beforeEach(() => { vi.clearAllMocks(); vi.stubEnv('FTOWN_PUBLIC_URL', 'https://localhost:8444'); mocks.auth.mockResolvedValue({ user: { id: owner } }); mocks.rate.mockResolvedValue({ allowed: true }); mocks.query.mockResolvedValue([{ failed_count: 1, retry_after: 60 }]); });
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

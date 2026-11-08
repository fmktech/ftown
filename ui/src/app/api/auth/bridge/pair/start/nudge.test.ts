import { beforeEach, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { createAccountEnrollment, generateAccountBridgeCandidate } from '@security/account-crypto';
const mocks = vi.hoisted(() => ({ start: vi.fn(), query: vi.fn(), change: null as unknown, published: [] as Array<{ channel: string; data: unknown }> }));
vi.mock('@/lib/pending-approval-store', () => ({ PENDING_NORMALIZED_EMAIL_SQL: 'norm(email)', PendingApprovalStore: class { change = mocks.change; startBridge = mocks.start; } }));
vi.mock('@/lib/auth', () => ({ auth: vi.fn() }));
vi.mock('@/lib/db', () => ({ getDb: () => ({ query: mocks.query }) }));
vi.mock('@/lib/pairing-store', () => ({ createPairingRequest: vi.fn(), deleteExpiredRequests: vi.fn() }));
vi.mock('@/lib/login-rate-limit', () => ({ checkRateLimit: async () => ({ allowed: true }), recordAttempt: vi.fn() }));
vi.mock('centrifuge', () => ({ Centrifuge: class {
  private handlers: Record<string, () => void> = {};
  on(event: string, handler: () => void) { this.handlers[event] = handler; return this; }
  connect() { queueMicrotask(() => this.handlers.connected?.()); }
  disconnect() {}
  async publish(channel: string, data: unknown) { mocks.published.push({ channel, data }); return {}; }
} }));
import { POST } from './route';
const settle = () => new Promise(resolve => setTimeout(resolve, 30));
async function body() {
  const bridge = await generateAccountBridgeCandidate('bridge-a');
  const link = await createAccountEnrollment(bridge, 'Computer', null, 'bridge-a');
  return { bridgeId: 'bridge-a', enrollment: link.request, approvalMethod: 'pending-v1', accountHint: 'Owner@Example.test', candidateToken: 'x'.repeat(43) };
}
const req = (b: unknown) => new NextRequest('https://public.test/api/auth/bridge/pair/start', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });
beforeEach(() => {
  vi.clearAllMocks(); mocks.published.length = 0; mocks.change = null;
  vi.stubEnv('CENTRIFUGO_TOKEN_SECRET', 'k'.repeat(48)); vi.stubEnv('NEXT_PUBLIC_CENTRIFUGO_URL', 'wss://hub.test/ws');
  mocks.start.mockResolvedValue({ pair: { deviceCode: 'd', userCode: 'u' }, state: { request: { expiresAt: new Date(Date.now() + 60000).toISOString() } } });
  mocks.query.mockResolvedValue([{ email: 'Owner@Example.test' }]);
});
it('a computer-candidate start that created a row publishes one approvals nudge to the owner', async () => {
  mocks.change = { target: 'owner@example.test', account: false };
  expect((await POST(req(await body()))).status).toBe(200); await settle();
  expect(mocks.published).toEqual([{ channel: 'bridges:security#Owner@Example.test', data: { type: 'ftown_security_changed', version: 1, scope: 'approvals' } }]);
  expect(mocks.query).toHaveBeenCalledWith(expect.stringContaining('norm(email)'), ['owner@example.test']);
});
it('an idempotent retry (no change) and a start with an unknown owner publish nothing', async () => {
  expect((await POST(req(await body()))).status).toBe(200); await settle();
  mocks.change = { target: 'nobody@example.test', account: false }; mocks.query.mockResolvedValue([]);
  expect((await POST(req(await body()))).status).toBe(200); await settle();
  expect(mocks.published).toEqual([]);
});

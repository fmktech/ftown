import { beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ auth: vi.fn(), query: vi.fn(), append: vi.fn(), create: vi.fn(), approve: vi.fn(), enrollment: vi.fn(), read: vi.fn(), changed: false,
  published: [] as Array<{ channel: string; data: unknown }> }));
vi.mock('@/lib/auth', () => ({ auth: mocks.auth }));
vi.mock('@/lib/db', () => ({ getDb: () => ({ query: mocks.query }) }));
vi.mock('@/lib/account-trust-store', async importOriginal => ({ ...await importOriginal<typeof import('@/lib/account-trust-store')>(), AccountTrustStore: class {
  changed = mocks.changed; append = mocks.append; createEnrollment = mocks.create; approveEnrollment = mocks.approve; enrollment = mocks.enrollment; read = mocks.read;
} }));
vi.mock('centrifuge', () => ({ Centrifuge: class {
  private handlers: Record<string, () => void> = {};
  on(event: string, handler: () => void) { this.handlers[event] = handler; return this; }
  connect() { queueMicrotask(() => this.handlers.connected?.()); }
  disconnect() {}
  async publish(channel: string, data: unknown) { mocks.published.push({ channel, data }); return {}; }
} }));
import { GET, POST } from './route';
import { POST as enrollmentCreate } from './enrollments/route';
import { GET as enrollmentGet, POST as enrollmentApprove } from './enrollments/[id]/route';
const owner = '349f8d2e-38e4-4d59-888d-687dcfa19e39';
const post = (body: unknown = {}) => new Request('https://localhost:3000/api/security/account', { method: 'POST', headers: { origin: 'https://public.test', 'content-type': 'application/json' }, body: JSON.stringify(body) });
const ctx = { params: Promise.resolve({ id: 'A'.repeat(43) }) };
const settle = () => new Promise(resolve => setTimeout(resolve, 30));
const expected = [{ channel: 'bridges:security#owner@example.test', data: { type: 'ftown_security_changed', version: 1, scope: 'account' } }];
beforeEach(() => {
  vi.resetAllMocks(); mocks.published.length = 0; mocks.changed = false;
  vi.stubEnv('FTOWN_PUBLIC_URL', 'https://public.test'); vi.stubEnv('CENTRIFUGO_TOKEN_SECRET', 'k'.repeat(48)); vi.stubEnv('NEXT_PUBLIC_CENTRIFUGO_URL', 'wss://hub.test/ws');
  mocks.auth.mockResolvedValue({ user: { id: owner, email: 'attacker-claimed@example.test' } });
  mocks.query.mockImplementation(async (text: string) => text.includes('FROM users') ? [{ email: 'owner@example.test' }] : [{ failed_count: 1, retry_after: 60 }]);
  mocks.append.mockResolvedValue({}); mocks.create.mockResolvedValue({}); mocks.approve.mockResolvedValue({}); mocks.enrollment.mockResolvedValue({}); mocks.read.mockResolvedValue(null);
});
it('each account mutation that reports a change publishes exactly one account nudge, addressed by the stored owner email', async () => {
  mocks.changed = true;
  expect((await POST(post())).status).toBe(200); await settle();
  expect(mocks.published).toEqual(expected);
  mocks.published.length = 0;
  expect((await enrollmentCreate(post())).status).toBe(200); await settle();
  expect(mocks.published).toEqual(expected);
  mocks.published.length = 0;
  expect((await enrollmentApprove(post(), ctx)).status).toBe(200); await settle();
  expect(mocks.published).toEqual(expected);
  expect(mocks.query).toHaveBeenCalledWith(expect.stringContaining('FROM users'), [owner]);
});
it('idempotent replays, reads and failed mutations publish nothing', async () => {
  mocks.changed = false;
  await POST(post()); await enrollmentCreate(post()); await enrollmentApprove(post(), ctx);
  await GET(new Request('https://public.test/api/security/account')); await enrollmentGet(new Request('https://public.test/x'), ctx);
  mocks.changed = true;
  mocks.append.mockRejectedValue(new Error('conflict')); mocks.create.mockRejectedValue(new Error('conflict')); mocks.approve.mockRejectedValue(new Error('conflict'));
  expect((await POST(post())).status).not.toBe(200); await enrollmentCreate(post()); await enrollmentApprove(post(), ctx);
  await settle();
  expect(mocks.published).toEqual([]);
});

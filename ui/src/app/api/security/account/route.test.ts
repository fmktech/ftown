import { beforeEach, expect, it, vi } from 'vitest';
import jwt from 'jsonwebtoken';
import { generateEndpoint } from '@security/crypto';
import { createAccountGenesis, generateAccountSigningIdentity } from '@security/account-crypto';
const { auth, query, check, attempt } = vi.hoisted(() => ({ auth: vi.fn(), query: vi.fn(), check: vi.fn(), attempt: vi.fn() }));
vi.mock('@/lib/auth', () => ({ auth }));
vi.mock('@/lib/db', () => ({ getDb: () => ({ query }) }));
vi.mock('@/lib/login-rate-limit', () => ({ checkRateLimit: check, recordAttempt: attempt }));
import { GET, POST } from './route';
import { POST as enrollmentCreate } from './enrollments/route';
import { GET as enrollmentGet } from './enrollments/[id]/route';
const owner = '349f8d2e-38e4-4d59-888d-687dcfa19e39';
const key = crypto.randomUUID().repeat(2);
beforeEach(() => {
  vi.resetAllMocks();
  process.env.FTOWN_PUBLIC_URL = 'https://public.test';
  process.env.CENTRIFUGO_TOKEN_SECRET = key;
  auth.mockResolvedValue({ user: { id: owner, email: 'owner@example.test' } });
  check.mockResolvedValue({ allowed: true });
  attempt.mockResolvedValue(undefined);
});
function request(body: unknown, origin = 'https://public.test') {
  return new Request('https://localhost:3000/api/security/account', { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify(body) });
}
it('GET uses session owner, accepts absent Origin and returns public null without creating authority', async () => {
  query.mockResolvedValueOnce([]);
  const response = await GET(new Request('https://public.test/api/security/account'));
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ history: null });
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(query).toHaveBeenCalledWith(expect.stringContaining('WHERE owner_id=$1'), [owner]);
});
it('public proxy Origin reaches authentication; hostile or malformed-config Origin fails closed', async () => {
  auth.mockResolvedValue(null);
  expect((await POST(request({}))).status).toBe(401);
  expect((await POST(request({}, 'https://evil.test'))).status).toBe(403);
  process.env.FTOWN_PUBLIC_URL = 'https://public.test/path';
  expect((await POST(request({}, 'https://localhost:3000'))).status).toBe(403);
  expect(query).not.toHaveBeenCalled();
});
it('bridge GET requires the current owner-bound bridge registration and never authorizes a browser mutation', async () => {
  auth.mockResolvedValue(null);
  const bearer = jwt.sign({ sub: 'owner@example.test', info: { ownerId: owner, bridgeId: 'bridge-a' } }, key, { audience: 'ftown:centrifugo', expiresIn: 60 });
  query.mockResolvedValueOnce([{ owner_id: owner }]).mockResolvedValueOnce([]);
  const response = await GET(new Request('https://public.test/api/security/account', { headers: { authorization: `Bearer ${bearer}` } }));
  expect(response.status).toBe(200);
  expect(query.mock.calls[0][0]).toContain("current_jti<>'revoked'");
  expect(query.mock.calls[0][1]).toEqual(['bridge-a', 'owner@example.test']);
  const mutation = request({}); mutation.headers.set('authorization', `Bearer ${bearer}`);
  expect((await POST(mutation)).status).toBe(401);
  query.mockResolvedValueOnce([]);
  expect((await GET(new Request('https://public.test/api/security/account', { headers: { authorization: `Bearer ${bearer}` } }))).status).toBe(403);
});
it('signed genesis POST stores only authenticated owner material with CAS and returns no private key', async () => {
  const identity = await generateEndpoint(owner, 'browser');
  const signing = await generateAccountSigningIdentity();
  const genesis = await createAccountGenesis(owner, identity.endpoint, signing, 'Browser');
  query.mockResolvedValueOnce([]).mockResolvedValueOnce([{ owner_id: owner }]);
  const response = await POST(request({ expectedHead: null, record: genesis }));
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body.history.genesis).toEqual(genesis);
  expect(JSON.stringify(body)).not.toContain('privateKey');
  expect(query.mock.calls[1][0]).toContain('ON CONFLICT(owner_id) DO NOTHING');
  expect(query.mock.calls[1][1][0]).toBe(owner);
});
it('rate denial and streamed oversized mutations return bounded errors before storage', async () => {
  check.mockResolvedValueOnce({ allowed: false });
  expect((await POST(request({}))).status).toBe(429);
  const response = await POST(request({ data: 'x'.repeat(2106000) }));
  expect(response.status).toBe(413);
  expect(await response.json()).toMatchObject({ error: { code: 'account_capacity_exceeded', retryable: false } });
  expect(query).not.toHaveBeenCalled();
});
it('enrollment creation rejects uploaded fragment secrets; foreign/missing lookups reveal no request', async () => {
  expect((await enrollmentCreate(request({ request: {}, secret: 'never-upload-fragments' }))).status).toBe(400);
  query.mockResolvedValueOnce([]);
  const response = await enrollmentGet(new Request('https://public.test/api/security/account/enrollments/id'), { params: Promise.resolve({ id: 'A'.repeat(43) }) });
  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({ error: { code: 'account_enrollment_invalid' } });
  expect(query.mock.calls[0][1]).toEqual([owner, 'A'.repeat(43)]);
});

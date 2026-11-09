import { beforeEach, describe, expect, it, vi } from 'vitest';
const { query, authMock, revocation, verify } = vi.hoisted(() => ({ query: vi.fn(), authMock: vi.fn(), revocation: vi.fn(), verify: vi.fn() }));
vi.mock('@/lib/auth', () => ({ auth: authMock }));
vi.mock('@/lib/bridge-revocation', () => ({ bridgeRevocationForOwner: revocation }));
vi.mock('@/lib/secrets', () => ({ getRequiredSecret: () => 'secret' }));
vi.mock('jsonwebtoken', () => ({ default: { verify } }));
vi.mock('@/lib/db', () => ({ getDb: () => ({ query }) }));
import { accountError, accountOwner, accountRateLimit } from './_shared';

beforeEach(() => { vi.resetAllMocks(); });
it('admits an account request with one atomic owner-scoped database operation', async () => {
  query.mockResolvedValue([{ failed_count: 300, retry_after: 60 }]);
  await expect(accountRateLimit('owner-a', 'account-read', 300)).resolves.toBeUndefined();
  expect(query).toHaveBeenCalledTimes(1);
  expect(query.mock.calls[0][1]).toEqual(['account-read', 'owner-a', 300]);
});
it.each([[18.2, '19'], [0, '1'], [1000, '60'], [Number.NaN, '60']])('returns a bounded Retry-After for rejected admission (%s)', async (remaining, expected) => {
  query.mockResolvedValue([{ failed_count: 301, retry_after: remaining }]);
  const failure = await accountRateLimit('owner-a', 'account-read', 300).then(() => null, error => error);
  const response = accountError(failure);
  expect(response.status).toBe(429);
  expect(response.headers.get('retry-after')).toBe(expected);
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(await response.json()).toEqual({ error: 'rate_limited' });
  expect(query).toHaveBeenCalledTimes(1);
});
it('fails closed if the admission database returns no result', async () => {
  query.mockResolvedValue([]);
  await expect(accountRateLimit('owner-a', 'account-read', 300)).rejects.toMatchObject({ code: 'account_storage_unavailable' });
});

const bridgeRequest = () => new Request('https://x.test/api/security/account', { headers: { authorization: 'Bearer t' } });
const claims = { sub: 'a@b.c', info: { bridgeId: 'b1', ownerId: 'owner-a' } };
const evidence = { genesis: { g: 1 }, transitions: [{ t: 1 }] };
const failure = (p: Promise<unknown>) => p.then(() => null, (error: unknown) => error);
describe('bridge authentication on account reads', () => {
  beforeEach(() => { verify.mockReturnValue(claims); vi.spyOn(console, 'error').mockImplementation(() => undefined); });
  it('returns 401 with signed evidence when the bridge is revoked and has no live refresh row', async () => {
    query.mockImplementation(async (sql: string) => sql.includes('rate_limit_attempts') ? [{ failed_count: 1, retry_after: 60 }] : []);
    revocation.mockResolvedValue({ revoked: true, evidence });
    const response = accountError(await failure(accountOwner(bridgeRequest())));
    expect(response.status).toBe(401);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({ error: 'bridge_revoked', history: evidence });
    expect(revocation).toHaveBeenCalledWith('owner-a', 'b1');
  });
  it('keeps 403 forbidden when 0 rows and not revoked', async () => {
    query.mockImplementation(async (sql: string) => sql.includes('rate_limit_attempts') ? [{ failed_count: 1, retry_after: 60 }] : []);
    revocation.mockResolvedValue({ revoked: false });
    const response = accountError(await failure(accountOwner(bridgeRequest())));
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'forbidden' });
  });
  it('keeps 403 forbidden when the revocation lookup throws', async () => {
    query.mockImplementation(async (sql: string) => sql.includes('rate_limit_attempts') ? [{ failed_count: 1, retry_after: 60 }] : []);
    revocation.mockRejectedValue(new Error('db down'));
    const response = accountError(await failure(accountOwner(bridgeRequest())));
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'forbidden' });
    expect(console.error).toHaveBeenCalled();
  });
  it('rate-limits before the revocation helper and never calls it on 429', async () => {
    const order: string[] = [];
    query.mockImplementation(async (sql: string) => { order.push(sql.includes('rate_limit_attempts') ? 'limiter' : 'join'); return sql.includes('rate_limit_attempts') ? [{ failed_count: 1, retry_after: 60 }] : []; });
    revocation.mockImplementation(async () => { order.push('helper'); return { revoked: false }; });
    await failure(accountOwner(bridgeRequest()));
    expect(order).toEqual(['join', 'limiter', 'helper']);
    expect(query.mock.calls[1][1]).toEqual(['bridge_revoked_evidence', 'owner-a', 120]);
    query.mockImplementation(async (sql: string) => sql.includes('rate_limit_attempts') ? [{ failed_count: 121, retry_after: 30 }] : []);
    revocation.mockClear();
    const response = accountError(await failure(accountOwner(bridgeRequest())));
    expect(response.status).toBe(429);
    expect(revocation).not.toHaveBeenCalled();
  });
  it('returns 403 without calling the helper when the limiter storage fails', async () => {
    query.mockImplementation(async (sql: string) => { if (sql.includes('rate_limit_attempts')) throw new Error('db down'); return []; });
    const response = accountError(await failure(accountOwner(bridgeRequest())));
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'forbidden' });
    expect(revocation).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalled();
  });
  it('returns 401 unauthorized when the JWT does not verify', async () => {
    verify.mockImplementation(() => { throw new Error('bad'); });
    const response = accountError(await failure(accountOwner(bridgeRequest())));
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'unauthorized' });
    expect(revocation).not.toHaveBeenCalled();
  });
  it('verifies with the centrifugo audience and HS256 only', async () => {
    query.mockResolvedValue([{ owner_id: 'owner-a' }]);
    await accountOwner(bridgeRequest());
    expect(verify).toHaveBeenCalledWith('t', 'secret', { audience: 'ftown:centrifugo', algorithms: ['HS256'] });
  });
  it('returns 403 for claims without info and never calls the helper', async () => {
    verify.mockReturnValue({ sub: 'a@b.c' });
    const response = accountError(await failure(accountOwner(bridgeRequest())));
    expect(response.status).toBe(403);
    expect(revocation).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
  });
  it('ignores a Bearer header on mutations', async () => {
    authMock.mockResolvedValue({ user: { id: 'owner-z' } });
    const request = new Request('https://x.test/api/security/account', { headers: { authorization: 'Bearer t', origin: 'https://x.test' } });
    await expect(accountOwner(request, true)).resolves.toBe('owner-z');
    expect(verify).not.toHaveBeenCalled();
    expect(revocation).not.toHaveBeenCalled();
  });
  it('keeps 403 on an owner mismatch without consulting revocation', async () => {
    query.mockResolvedValue([{ owner_id: 'owner-b' }]);
    const response = accountError(await failure(accountOwner(bridgeRequest())));
    expect(response.status).toBe(403);
    expect(revocation).not.toHaveBeenCalled();
  });
  it('returns the owner for a valid row without consulting revocation', async () => {
    query.mockResolvedValue([{ owner_id: 'owner-a' }]);
    await expect(accountOwner(bridgeRequest())).resolves.toBe('owner-a');
    expect(revocation).not.toHaveBeenCalled();
  });
});
it('leaves the browser session path unchanged', async () => {
  authMock.mockResolvedValue({ user: { id: 'owner-z' } });
  await expect(accountOwner(new Request('https://x.test/api/security/account'))).resolves.toBe('owner-z');
  expect(verify).not.toHaveBeenCalled();
  expect(revocation).not.toHaveBeenCalled();
  authMock.mockResolvedValue(null);
  const response = accountError(await failure(accountOwner(new Request('https://x.test/api/security/account'))));
  expect(response.status).toBe(401);
  expect(await response.json()).toEqual({ error: 'unauthorized' });
});

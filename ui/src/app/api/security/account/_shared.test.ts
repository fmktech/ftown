import { beforeEach, expect, it, vi } from 'vitest';
const { query } = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('@/lib/auth', () => ({ auth: vi.fn() }));
vi.mock('@/lib/db', () => ({ getDb: () => ({ query }) }));
import { accountError, accountRateLimit } from './_shared';

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

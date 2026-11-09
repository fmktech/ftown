import { beforeEach, expect, it, vi } from 'vitest';
const { query } = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('@/lib/db', () => ({ getDb: () => ({ query }) }));
import { revokeBridgeRefreshForOwner, getBridgeRefreshJti } from './bridge-refresh';

beforeEach(() => { vi.resetAllMocks(); });

it('revokeBridgeRefreshForOwner tombstones by bridge id and owner-resolved email, returning true when a row changed', async () => {
  query.mockResolvedValueOnce([{ bridge_id: 'bridge-a' }]);
  expect(await revokeBridgeRefreshForOwner('owner-1', 'bridge-a')).toBe(true);
  const [sql, params] = query.mock.calls[0];
  expect(sql).toContain('UPDATE bridge_refresh');
  expect(sql).toContain('current_jti = $1');
  expect(sql).toContain('(SELECT email FROM users WHERE id = $3)');
  expect(params).toEqual(['revoked', 'bridge-a', 'owner-1']);
});

it('revokeBridgeRefreshForOwner returns false when no registration matched and propagates db errors', async () => {
  query.mockResolvedValueOnce([]);
  expect(await revokeBridgeRefreshForOwner('owner-1', 'missing')).toBe(false);
  query.mockRejectedValueOnce(new Error('db down'));
  await expect(revokeBridgeRefreshForOwner('owner-1', 'bridge-a')).rejects.toThrow('db down');
});

it('getBridgeRefreshJti selects current_jti by bridge id and sub, null when no row', async () => {
  query.mockResolvedValueOnce([{ current_jti: 'jti-9' }]);
  expect(await getBridgeRefreshJti('bridge-a', 'u@example.com')).toBe('jti-9');
  const [sql, params] = query.mock.calls[0];
  expect(sql).toContain('SELECT current_jti FROM bridge_refresh');
  expect(params).toEqual(['bridge-a', 'u@example.com']);
  query.mockResolvedValueOnce([]);
  expect(await getBridgeRefreshJti('bridge-a', 'u@example.com')).toBeNull();
});

import { beforeEach, describe, expect, it, vi } from 'vitest';
const { requireAccount, rate, list, set } = vi.hoisted(() => ({ requireAccount: vi.fn(), rate: vi.fn(), list: vi.fn(), set: vi.fn() }));
vi.mock('next-auth/providers/credentials', () => ({ default: (config: unknown) => config }));
vi.mock('@/lib/auth', () => ({ auth: vi.fn() }));
vi.mock('@/lib/auth-nonce-store', () => ({ consumeNonce: vi.fn() }));
vi.mock('@/lib/account-ledger-store', () => ({ readLedger: vi.fn() }));
vi.mock('@/lib/ledger-auth', async importOriginal => ({ ...await importOriginal<typeof import('@/lib/ledger-auth')>(), requireAccount }));
vi.mock('@/lib/login-rate-limit', () => ({ consumeRateLimit: rate }));
vi.mock('@/lib/device-display-name-store', async importOriginal => {
  const original = await importOriginal<typeof import('@/lib/device-display-name-store')>();
  return { ...original, DeviceDisplayNameStore: class { list = list; set = set; } };
});
import { GET, PUT } from './route';
import { DeviceNameStoreError } from '@/lib/device-display-name-store';
import { UnauthorizedError } from '@/lib/ledger-auth';
const url = 'https://app.test/api/security/device-names';
const get = (headers: Record<string, string> = {}) => new Request(url, { headers });
const put = (body: unknown, origin = 'https://app.test') => new Request(url, { method: 'PUT', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify(body) });
beforeEach(() => { vi.resetAllMocks(); delete process.env.FTOWN_PUBLIC_URL; requireAccount.mockResolvedValue({ accountId: 'owner', endpointId: 'dev' }); rate.mockResolvedValue({ allowed: true }); });

describe('device nickname route', () => {
  it('uses only browser session owner and returns no-store owner-scoped data', async () => {
    list.mockResolvedValue({ names: [], eligible: [] });
    const response = await GET(get());
    expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toBe('no-store');
    expect(list).toHaveBeenCalledWith('owner'); expect(rate).toHaveBeenCalledWith('device-names-read', 'owner', expect.objectContaining({ maxAttempts: 120 }));
    requireAccount.mockRejectedValue(new UnauthorizedError());
    const denied = await GET(get({ authorization: 'Bearer token' }));
    expect(denied.status).toBe(401); expect(await denied.json()).toEqual({ error: { code: 'unauthorized', message: 'Sign in to manage display names.' } });
  });
  it('requires origin and session and sends normalized exact request to store', async () => {
    set.mockResolvedValue({ name: { kind: 'browser', id: 'id', name: 'Phone' } });
    const response = await PUT(put({ kind: 'browser', id: 'id', name: ' Phone ' }));
    expect(response.status).toBe(200); expect(set).toHaveBeenCalledWith('owner', { kind: 'browser', id: 'id', name: 'Phone' });
    expect(rate).toHaveBeenCalledWith('device-names-write', 'owner', expect.objectContaining({ maxAttempts: 60 }));
    expect((await PUT(put({ kind: 'browser', id: 'id', name: 'Phone' }, 'https://evil.test'))).status).toBe(403);
    requireAccount.mockRejectedValue(new UnauthorizedError()); expect((await PUT(put({ kind: 'browser', id: 'id', name: null }))).status).toBe(401);
  });
  it('maps invalid JSON, oversize and untrusted or malformed shapes to 400 without store writes', async () => {
    for (const body of [{ kind: 'browser', id: 'id', name: '' }, { kind: 'browser', id: 'id', name: 'x', ownerId: 'other' },
      { kind: 'browser', id: 'id', name: 'x'.repeat(3000) }, { kind: 'bridge', id: 'id', name: 'x\u2066y' }]) {
      const response = await PUT(put(body));
      expect(response.status).toBe(400); expect((await response.json()).error.code).toBe('invalid_request');
    }
    expect(set).not.toHaveBeenCalled();
  });
  it('preserves expected store statuses and sanitizes unexpected database errors', async () => {
    for (const [code, expected] of [['unknown_device', 404], ['conflict', 409], ['storage_unavailable', 503]] as const) {
      set.mockRejectedValueOnce(new DeviceNameStoreError(code));
      const response = await PUT(put({ kind: 'browser', id: 'id', name: null }));
      expect(response.status).toBe(expected); expect((await response.json()).error.code).toBe(code);
    }
    list.mockRejectedValueOnce(new Error('secret database details'));
    const response = await GET(get()); expect(response.status).toBe(503);
    expect(JSON.stringify(await response.json())).not.toContain('secret');
  });
  it('returns rate-limit retry information without accessing storage', async () => {
    rate.mockResolvedValue({ allowed: false, retryAfterMs: 7200 });
    const response = await GET(get()); expect(response.status).toBe(429); expect(response.headers.get('retry-after')).toBe('8');
    expect(list).not.toHaveBeenCalled();
  });
});

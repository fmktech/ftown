import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const query = vi.fn();
vi.mock('@/lib/db', () => ({ getDb: () => ({ query }) }));
import { consumeNonce, issueNonce } from './auth-nonce-store';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

describe('auth nonce store', () => {
  beforeEach(() => { query.mockReset(); query.mockImplementation(async (t: string) => String(t).startsWith('INSERT') ? [{ expires_ms: Date.now() + 60_000 }] : []); });

  it('issues a 32-byte base64url nonce, stores only its hash, TTL 60s', async () => {
    const before = Date.now();
    const { nonce, expiresAt } = await issueNonce('session');
    expect(nonce).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(nonce, 'base64url')).toHaveLength(32);
    expect(expiresAt).toBeGreaterThanOrEqual(before + 60_000);
    expect(expiresAt).toBeLessThanOrEqual(Date.now() + 60_000);
    const insert = query.mock.calls.find(([t]) => String(t).startsWith('INSERT'))!;
    expect(insert[1][0]).toBe(sha(nonce));
    expect(insert[1][1]).toBe('session');
    expect(JSON.stringify(query.mock.calls)).not.toContain(nonce);
    expect(query.mock.calls.some(([t]) => String(t).startsWith('DELETE FROM auth_nonces WHERE expires_at'))).toBe(true);
  });

  it('issues distinct nonces', async () => {
    const a = await issueNonce('relay'); const b = await issueNonce('relay');
    expect(a.nonce).not.toBe(b.nonce);
  });

  it('consume is an atomic hash+purpose+unexpired DELETE ... RETURNING', async () => {
    query.mockResolvedValueOnce([{ nonce_hash: 'x' }]);
    expect(await consumeNonce('abc', 'passkey')).toBe(true);
    const [text, params] = query.mock.calls[0];
    expect(text).toMatch(/DELETE FROM auth_nonces WHERE nonce_hash = \$1 AND purpose = \$2 AND expires_at > NOW\(\) RETURNING/);
    expect(params).toEqual([sha('abc'), 'passkey']);
  });

  it('single use: succeeds once, then fails', async () => {
    let present = true;
    query.mockImplementation(async () => { if (present) { present = false; return [{ nonce_hash: 'h' }]; } return []; });
    expect(await consumeNonce('n', 'session')).toBe(true);
    expect(await consumeNonce('n', 'session')).toBe(false);
  });

  it('wrong purpose and expired nonces fail (no row returned)', async () => {
    query.mockResolvedValue([]);
    expect(await consumeNonce('n', 'relay')).toBe(false);
    expect(await consumeNonce('expired', 'session')).toBe(false);
    expect(await consumeNonce('', 'session')).toBe(false);
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';

const issueNonce = vi.fn();
const consumeRateLimit = vi.fn();
vi.mock('@/lib/auth-nonce-store', () => ({ issueNonce: (...a: unknown[]) => issueNonce(...a) }));
vi.mock('@/lib/login-rate-limit', () => ({ consumeRateLimit: (...a: unknown[]) => consumeRateLimit(...a) }));
vi.mock('@/lib/client-ip', () => ({ clientIp: () => '1.2.3.4' }));
import { POST } from './route';

const req = (body: string) => new Request('https://x.example/api/auth/nonce', { method: 'POST', body });

beforeEach(() => {
  issueNonce.mockReset().mockResolvedValue({ nonce: 'abc', expiresAt: 123 });
  consumeRateLimit.mockReset().mockResolvedValue({ allowed: true });
});

describe('POST /api/auth/nonce', () => {
  it.each(['session', 'relay'])('issues a %s nonce, no-store', async purpose => {
    const res = await POST(req(JSON.stringify({ purpose })));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ nonce: 'abc', expiresAt: 123 });
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(issueNonce).toHaveBeenCalledWith(purpose);
    expect(consumeRateLimit).toHaveBeenCalledWith('auth-nonce', '1.2.3.4', expect.any(Object));
  });
  it.each(['passkey', 'x', 1, null])('rejects purpose %s', async purpose => {
    const res = await POST(req(JSON.stringify({ purpose })));
    expect(res.status).toBe(400);
    expect(issueNonce).not.toHaveBeenCalled();
  });
  it('rejects malformed and oversized bodies', async () => {
    expect((await POST(req('{nope'))).status).toBe(400);
    expect((await POST(req(JSON.stringify({ purpose: 'session', pad: 'x'.repeat(400) })))).status).toBe(400);
    // No content-length: the streamed cap must still reject.
    const streamed = new Request('https://x.example/api/auth/nonce', { method: 'POST', body: new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('{"purpose":"session","pad":"' + 'x'.repeat(400) + '"}')); c.close(); } }), duplex: 'half' } as RequestInit);
    expect((await POST(streamed)).status).toBe(400);
  });
  it('429s when rate limited, without issuing', async () => {
    consumeRateLimit.mockResolvedValue({ allowed: false, retryAfterMs: 5000 });
    const res = await POST(req(JSON.stringify({ purpose: 'session' })));
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('5');
    expect(issueNonce).not.toHaveBeenCalled();
  });
  it('503s when storage fails', async () => {
    issueNonce.mockRejectedValue(new Error('db'));
    expect((await POST(req(JSON.stringify({ purpose: 'relay' })))).status).toBe(503);
  });
});

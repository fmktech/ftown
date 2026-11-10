import { beforeEach, describe, expect, it, vi } from 'vitest';

const issueNonce = vi.fn();
const consumeRateLimit = vi.fn();
vi.mock('@/lib/auth-nonce-store', () => ({ issueNonce: (...a: unknown[]) => issueNonce(...a) }));
vi.mock('@/lib/login-rate-limit', () => ({ consumeRateLimit: (...a: unknown[]) => consumeRateLimit(...a) }));
const ipState = vi.hoisted(() => ({ ip: '1.2.3.4' }));
vi.mock('@/lib/client-ip', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/client-ip')>();
  return { ...actual, clientIp: () => ipState.ip, rateLimitKeyIp: () => actual.rateLimitKey(ipState.ip) };
});
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

describe('auth-nonce limiter key', () => {
  const keyFor = async (ip: string) => {
    ipState.ip = ip;
    consumeRateLimit.mockClear();
    await POST(req(JSON.stringify({ purpose: 'session' })));
    return consumeRateLimit.mock.calls.find(c => c[0] === 'auth-nonce')![1];
  };
  it('shares one key across addresses of the same IPv6 /64, separates other /64s, leaves IPv4 unchanged', async () => {
    const a = await keyFor('2001:db8:1:2::1');
    const b = await keyFor('2001:db8:1:2:ffff:aaaa:bbbb:cccc');
    const c = await keyFor('2001:db8:1:3::1');
    expect(a).toBe(b);
    expect(c).not.toBe(a);
    expect(await keyFor('1.2.3.4')).toBe('1.2.3.4');
    expect(await keyFor('unknown')).toBe('unknown');
    ipState.ip = '1.2.3.4';
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';

const requireAccount = vi.fn();
const putPairApproval = vi.fn();
const takePairApproval = vi.fn();
const consumeRateLimit = vi.fn();
vi.mock('@/lib/ledger-auth', () => ({ requireAccount: (...a: unknown[]) => requireAccount(...a) }));
vi.mock('@/lib/pair-mailbox-store', () => ({
  putPairApproval: (...a: unknown[]) => putPairApproval(...a),
  takePairApproval: (...a: unknown[]) => takePairApproval(...a),
}));
vi.mock('@/lib/login-rate-limit', () => ({ consumeRateLimit: (...a: unknown[]) => consumeRateLimit(...a) }));
vi.mock('@/lib/client-ip', () => ({ clientIp: () => '1.2.3.4' }));
import { GET, PUT } from './route';

const REQUEST_ID = 'A'.repeat(43);
const ctx = (requestId = REQUEST_ID) => ({ params: Promise.resolve({ requestId }) });
const put = (body: string, extraHeaders: Record<string, string> = {}) => new Request(`https://x.example/api/pair/${REQUEST_ID}`, {
  method: 'PUT',
  body,
  headers: { 'content-type': 'application/json', ...extraHeaders },
});
const get = () => new Request(`https://x.example/api/pair/${REQUEST_ID}`);

beforeEach(() => {
  requireAccount.mockReset().mockResolvedValue({ accountId: 'acct-1', endpointId: 'ep-1', stored: {} });
  putPairApproval.mockReset().mockResolvedValue(undefined);
  takePairApproval.mockReset();
  consumeRateLimit.mockReset().mockResolvedValue({ allowed: true });
});

describe('PUT /api/pair/:requestId', () => {
  it('stores the sealed approval for the signed-in account and returns 204 no-store', async () => {
    const res = await PUT(put(JSON.stringify({ sealed: 'blob' })), ctx());
    expect(res.status).toBe(204);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(putPairApproval).toHaveBeenCalledWith(REQUEST_ID, 'acct-1', 'blob');
  });

  it('returns 401 and writes nothing when there is no account', async () => {
    requireAccount.mockRejectedValue(Object.assign(new Error('unauthorized'), { status: 401 }));
    const res = await PUT(put(JSON.stringify({ sealed: 'blob' })), ctx());
    expect(res.status).toBe(401);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(putPairApproval).not.toHaveBeenCalled();
    expect(consumeRateLimit).not.toHaveBeenCalled();
  });

  it('applies pair-write (30 per 10 minutes) keyed by accountId, 429 rate_limited without storing', async () => {
    expect((await PUT(put(JSON.stringify({ sealed: 'blob' })), ctx())).status).toBe(204);
    expect(consumeRateLimit).toHaveBeenCalledWith('pair-write', 'acct-1', { maxAttempts: 30, lockoutMs: 10 * 60 * 1000 });
    putPairApproval.mockClear();
    consumeRateLimit.mockResolvedValueOnce({ allowed: false, retryAfterMs: 9000 });
    const res = await PUT(put(JSON.stringify({ sealed: 'blob' })), ctx());
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: 'rate_limited' });
    expect(res.headers.get('Retry-After')).toBe('9');
    expect(putPairApproval).not.toHaveBeenCalled();
  });

  it('does not throttle account B when account A exhausted its pair-write budget', async () => {
    const counts = new Map<string, number>();
    consumeRateLimit.mockImplementation(async (scope: string, key: string, cfg: { maxAttempts: number }) => {
      const n = (counts.get(`${scope}:${key}`) ?? 0) + 1;
      counts.set(`${scope}:${key}`, n);
      return n <= cfg.maxAttempts ? { allowed: true } : { allowed: false, retryAfterMs: 1000 };
    });
    for (let i = 0; i < 30; i++) expect((await PUT(put(JSON.stringify({ sealed: 'b' })), ctx())).status).toBe(204);
    expect((await PUT(put(JSON.stringify({ sealed: 'b' })), ctx())).status).toBe(429);
    requireAccount.mockResolvedValue({ accountId: 'acct-2', endpointId: 'ep-2', stored: {} });
    expect((await PUT(put(JSON.stringify({ sealed: 'b' })), ctx())).status).toBe(204);
  });

  it('maps pair_mailbox_full to 429 pair_mailbox_full', async () => {
    putPairApproval.mockRejectedValue(new Error('pair_mailbox_full'));
    const res = await PUT(put(JSON.stringify({ sealed: 'x' })), ctx());
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: 'pair_mailbox_full' });
  });

  it('409 for a foreign-owned request id reveals nothing about the other account', async () => {
    putPairApproval.mockRejectedValue(new Error('pair_mailbox_conflict'));
    const res = await PUT(put(JSON.stringify({ sealed: 'x' })), ctx());
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'conflict' });
  });

  it('rejects an invalid request id with 400 before reading the body or storing', async () => {
    const res = await PUT(put(JSON.stringify({ sealed: 'x' })), ctx('short'));
    expect(res.status).toBe(400);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(putPairApproval).not.toHaveBeenCalled();
  });

  it.each(['{nope', JSON.stringify({}), JSON.stringify({ sealed: 3 }), 'null'])('returns 400 for malformed body %s', async body => {
    const res = await PUT(put(body), ctx());
    expect(res.status).toBe(400);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(putPairApproval).not.toHaveBeenCalled();
  });

  it('returns 413 when the declared body exceeds 300 KB, without storing', async () => {
    const res = await PUT(put(JSON.stringify({ sealed: 'x' }), { 'content-length': String(300 * 1024 + 1) }), ctx());
    expect(res.status).toBe(413);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(putPairApproval).not.toHaveBeenCalled();
  });

  it('returns 413 when the streamed body exceeds 300 KB without a content-length', async () => {
    const big = JSON.stringify({ sealed: 'x'.repeat(300 * 1024) });
    const res = await PUT(put(big), ctx());
    expect(res.status).toBe(413);
    expect(putPairApproval).not.toHaveBeenCalled();
  });

  it('maps invalid_request_id from the store to 400', async () => {
    putPairApproval.mockRejectedValue(new Error('invalid_request_id'));
    expect((await PUT(put(JSON.stringify({ sealed: 'x' })), ctx())).status).toBe(400);
  });

  it('maps pair_mailbox_too_large to 413', async () => {
    putPairApproval.mockRejectedValue(new Error('pair_mailbox_too_large'));
    expect((await PUT(put(JSON.stringify({ sealed: 'x' })), ctx())).status).toBe(413);
  });

  it('maps pair_mailbox_conflict to 409', async () => {
    putPairApproval.mockRejectedValue(new Error('pair_mailbox_conflict'));
    expect((await PUT(put(JSON.stringify({ sealed: 'x' })), ctx())).status).toBe(409);
  });

  it('maps other storage failures to 503', async () => {
    putPairApproval.mockRejectedValue(new Error('db down'));
    expect((await PUT(put(JSON.stringify({ sealed: 'x' })), ctx())).status).toBe(503);
  });
});

describe('GET /api/pair/:requestId', () => {
  it('returns 200 with the sealed approval when ready, no-store', async () => {
    takePairApproval.mockResolvedValue({ status: 'ready', sealed: 'blob' });
    const res = await GET(get(), ctx());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sealed: 'blob' });
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(takePairApproval).toHaveBeenCalledWith(REQUEST_ID);
  });

  it('returns 404 pending when no approval exists yet', async () => {
    takePairApproval.mockResolvedValue({ status: 'pending' });
    const res = await GET(get(), ctx());
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ status: 'pending' });
    expect(res.headers.get('Cache-Control')).toBe('no-store');
  });

  it('returns 410 expired when the mailbox has expired', async () => {
    takePairApproval.mockResolvedValue({ status: 'expired' });
    const res = await GET(get(), ctx());
    expect(res.status).toBe(410);
    expect(await res.json()).toEqual({ status: 'expired' });
    expect(res.headers.get('Cache-Control')).toBe('no-store');
  });

  it('rejects an invalid request id with 400 without touching any limiter', async () => {
    for (const bad of ['short', 'A'.repeat(44), 'A'.repeat(42) + '+', '']) {
      const res = await GET(get(), ctx(bad));
      expect(res.status).toBe(400);
      expect(res.headers.get('Cache-Control')).toBe('no-store');
    }
    expect(consumeRateLimit).not.toHaveBeenCalled();
    expect(takePairApproval).not.toHaveBeenCalled();
  });

  it('applies the per-IP limit (120 per minute) before the per-requestId limit', async () => {
    consumeRateLimit.mockResolvedValueOnce({ allowed: false, retryAfterMs: 7000 });
    const res = await GET(get(), ctx());
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('7');
    expect(consumeRateLimit).toHaveBeenCalledWith('pair-read-ip', '1.2.3.4', { maxAttempts: 120, lockoutMs: 60 * 1000 });
    expect(consumeRateLimit).toHaveBeenCalledTimes(1);
    expect(takePairApproval).not.toHaveBeenCalled();
  });

  it('applies the per-requestId limit (200 per 10 minutes), returning 429 without reading', async () => {
    consumeRateLimit.mockResolvedValueOnce({ allowed: true }).mockResolvedValueOnce({ allowed: false, retryAfterMs: 5000 });
    const res = await GET(get(), ctx());
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('5');
    expect(consumeRateLimit).toHaveBeenCalledWith('pair-read', REQUEST_ID, { maxAttempts: 200, lockoutMs: 10 * 60 * 1000 });
    expect(takePairApproval).not.toHaveBeenCalled();
  });

  it('maps invalid_request_id from the store to 400', async () => {
    takePairApproval.mockRejectedValue(new Error('invalid_request_id'));
    expect((await GET(get(), ctx())).status).toBe(400);
  });

  it('maps other failures to 503', async () => {
    takePairApproval.mockRejectedValue(new Error('db down'));
    expect((await GET(get(), ctx())).status).toBe(503);
  });
});

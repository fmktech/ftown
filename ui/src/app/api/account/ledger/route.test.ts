import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ offer: vi.fn(), read: vi.fn(), rate: vi.fn(), publish: vi.fn() }));
vi.mock('@/lib/account-ledger-store', () => ({ offerLedger: mocks.offer, readLedger: mocks.read }));
vi.mock('@/lib/login-rate-limit', () => ({ consumeRateLimit: mocks.rate }));
vi.mock('@/lib/ledger-publish', () => ({ publishLedger: mocks.publish, afterLedgerResponse: (work: () => Promise<void>) => { void work(); } }));
import { GET, POST } from './route';
import { LEDGER_BODY_MAX_BYTES } from '@/lib/ledger-limits';

const ID = 'A'.repeat(43);
const OTHER = 'B'.repeat(43);
const ledger = { genesis: { payload: { handle: 'h' } }, transitions: [] };
const stored = { ledger, checkpoint: { accountId: ID, head: 'head', revision: 3 } };
const get = (query: string) => new Request(`https://public.test/api/account/ledger${query}`);
const post = (body: string, headers: Record<string, string> = {}) => new Request('https://public.test/api/account/ledger', {
  method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body });
const offer = (decision: string, withStored: unknown = stored, discarded = 0) => mocks.offer.mockResolvedValue({ decision, stored: withStored, discarded });

beforeEach(() => {
  vi.resetAllMocks();
  mocks.rate.mockResolvedValue({ allowed: true });
  mocks.read.mockResolvedValue(stored);
  mocks.publish.mockResolvedValue(undefined);
});

describe('GET', () => {
  it('reads by accountId or by handle, no-store', async () => {
    const byAccount = await GET(get(`?accountId=${ID}`));
    expect(byAccount.status).toBe(200);
    expect(byAccount.headers.get('cache-control')).toBe('no-store');
    expect(await byAccount.json()).toEqual({ ledger });
    expect(mocks.read).toHaveBeenLastCalledWith({ accountId: ID });
    expect((await GET(get(`?handle=${OTHER}`))).status).toBe(200);
    expect(mocks.read).toHaveBeenLastCalledWith({ handle: OTHER });
    expect(mocks.rate).toHaveBeenCalledWith('ledger-read', expect.any(String), { maxAttempts: 120, lockoutMs: 60_000 });
  });

  it('requires exactly one well-formed key', async () => {
    for (const query of ['', `?accountId=${ID}&handle=${OTHER}`, '?accountId=short', `?handle=${'A'.repeat(44)}`, `?accountId=${'+'.repeat(43)}`]) {
      expect((await GET(get(query))).status).toBe(400);
    }
    expect(mocks.read).not.toHaveBeenCalled();
  });

  it('404 when absent, 503 on a corrupt row or store failure', async () => {
    mocks.read.mockResolvedValue(null);
    const missing = await GET(get(`?accountId=${ID}`));
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: 'not_found' });
    mocks.read.mockRejectedValue(new Error('account_ledger_corrupt'));
    expect((await GET(get(`?accountId=${ID}`))).status).toBe(503);
  });

  it('429 with Retry-After when rate limited, and does not read', async () => {
    mocks.rate.mockResolvedValue({ allowed: false, retryAfterMs: 12_300 });
    const response = await GET(get(`?accountId=${ID}`));
    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('13');
    expect(mocks.read).not.toHaveBeenCalled();
  });
});

describe('POST', () => {
  it('created is 201, publishes once, and returns decision, ledger and discarded', async () => {
    offer('created');
    const response = await POST(post(JSON.stringify({ ledger })));
    expect(response.status).toBe(201);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({ decision: 'created', ledger, discarded: 0 });
    expect(mocks.offer).toHaveBeenCalledWith(ledger);
    expect(mocks.publish).toHaveBeenCalledTimes(1);
    expect(mocks.publish).toHaveBeenCalledWith(ID, ledger);
    expect(mocks.rate).toHaveBeenCalledWith('ledger-write', expect.any(String), { maxAttempts: 30, lockoutMs: 60_000 });
  });

  it('adopt is 200, publishes and reports discarded', async () => {
    offer('adopt', stored, 2);
    const response = await POST(post(JSON.stringify({ ledger })));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ decision: 'adopt', ledger, discarded: 2 });
    expect(mocks.publish).toHaveBeenCalledTimes(1);
  });

  it('keep is 200 and publishes nothing', async () => {
    offer('keep');
    const response = await POST(post(JSON.stringify({ ledger })));
    expect(response.status).toBe(200);
    expect((await response.json()).decision).toBe('keep');
    expect(mocks.publish).not.toHaveBeenCalled();
  });

  it('reject is 409 with the stored ledger or null, and publishes nothing', async () => {
    offer('reject');
    const withStored = await POST(post(JSON.stringify({ ledger })));
    expect(withStored.status).toBe(409);
    expect(await withStored.json()).toEqual({ error: 'ledger_rejected', ledger });
    expect(mocks.publish).not.toHaveBeenCalled();
  });

  it('reject with no stored account is 403 registration_closed', async () => {
    offer('reject', null);
    const response = await POST(post(JSON.stringify({ ledger, bootstrap: 'secret-value' })));
    expect(response.status).toBe(403);
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({ error: 'registration_closed' });
    expect(text).not.toContain('secret-value');
    expect(mocks.publish).not.toHaveBeenCalled();
  });

  it('forwards bootstrap as options.bootstrap, never logs it, and validates it', async () => {
    const spies = [vi.spyOn(console, 'error'), vi.spyOn(console, 'log'), vi.spyOn(console, 'warn')];
    offer('created');
    await POST(post(JSON.stringify({ ledger, bootstrap: 'secret-value' })));
    expect(mocks.offer).toHaveBeenLastCalledWith(ledger, { bootstrap: 'secret-value' });
    mocks.offer.mockRejectedValue(new Error('x'));
    await POST(post(JSON.stringify({ ledger, bootstrap: 'secret-value' })));
    for (const spy of spies) expect(JSON.stringify(spy.mock.calls)).not.toContain('secret-value');
    mocks.offer.mockClear();
    expect((await POST(post(JSON.stringify({ ledger, bootstrap: 'b'.repeat(257) })))).status).toBe(400);
    expect((await POST(post(JSON.stringify({ ledger, bootstrap: 5 })))).status).toBe(400);
    expect(mocks.offer).not.toHaveBeenCalled();
    offer('created');
    expect((await POST(post(JSON.stringify({ ledger, bootstrap: 'b'.repeat(256) })))).status).toBe(201);
  });

  it('503 on a store conflict or corruption, publishes nothing', async () => {
    mocks.offer.mockRejectedValue(new Error('account_ledger_conflict'));
    expect((await POST(post(JSON.stringify({ ledger })))).status).toBe(503);
    mocks.offer.mockRejectedValue(new Error('account_ledger_corrupt'));
    expect((await POST(post(JSON.stringify({ ledger })))).status).toBe(503);
    expect(mocks.publish).not.toHaveBeenCalled();
  });

  it('needs no session: no auth is consulted and a bare request works', async () => {
    offer('keep');
    expect((await POST(post(JSON.stringify({ ledger })))).status).toBe(200);
  });

  it('rejects an oversized body with 413 by content-length and by streamed size, without calling the store', async () => {
    const declared = await POST(post('{}', { 'content-length': String(LEDGER_BODY_MAX_BYTES + 1) }));
    expect(declared.status).toBe(413);
    const streamed = await POST(post(JSON.stringify({ ledger, pad: 'x'.repeat(LEDGER_BODY_MAX_BYTES) })));
    expect(streamed.status).toBe(413);
    expect(mocks.offer).not.toHaveBeenCalled();
  });

  it('400 for a non-JSON content type, malformed JSON, or a missing ledger member', async () => {
    expect((await POST(post('{}', { 'content-type': 'text/plain' }))).status).toBe(400);
    expect((await POST(post('{nope'))).status).toBe(400);
    expect((await POST(post('{}'))).status).toBe(400);
    expect((await POST(post('[]'))).status).toBe(400);
    expect(mocks.offer).not.toHaveBeenCalled();
  });

  it('429 when rate limited, before the body is read or the store is touched', async () => {
    mocks.rate.mockResolvedValue({ allowed: false, retryAfterMs: 1000 });
    const response = await POST(post(JSON.stringify({ ledger })));
    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('1');
    expect(mocks.offer).not.toHaveBeenCalled();
  });
});

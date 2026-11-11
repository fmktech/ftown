import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ offer: vi.fn(), read: vi.fn(), rate: vi.fn(), publish: vi.fn() }));
vi.mock('@/lib/account-ledger-store', () => ({ offerLedger: mocks.offer, readLedger: mocks.read }));
vi.mock('@/lib/login-rate-limit', () => ({ consumeRateLimit: mocks.rate }));
vi.mock('@/lib/ledger-publish', () => ({ publishLedger: mocks.publish, afterLedgerResponse: (work: () => Promise<void>) => { void work(); } }));
import { GET, POST } from './route';
import { LEDGER_BODY_MAX_BYTES } from '@/lib/ledger-limits';

const ID = 'A'.repeat(43);
const OTHER = 'B'.repeat(43);
const ledger = { genesis: { payload: { handle: 'h' } }, transitions: [] };
const stored = { ledger, trusted: { accountId: ID, head: 'head', revision: 3 } };
const get = (query: string) => new Request(`https://public.test/api/account/ledger${query}`);
const post = (body: string, headers: Record<string, string> = {}) => new Request('https://public.test/api/account/ledger', {
  method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body });
const offer = (decision: string, withStored: unknown = stored, discarded = 0) => mocks.offer.mockResolvedValue({ decision, stored: withStored, discarded });
const refuse = (reason: string) => mocks.offer.mockResolvedValue({ decision: 'reject', stored: null, discarded: 0, reason });
type Options = { admitCreation: () => Promise<boolean>; admitAccountWrite: (accountId: string) => Promise<boolean> };
const LIMITS = { admitCreation: expect.any(Function), admitAccountWrite: expect.any(Function) };
/** The store reaching the creation budget: consults it, then creates or refuses with rate_limited. */
const creating = () => mocks.offer.mockImplementation(async (_ledger: unknown, options: Options) => (await options.admitCreation()
  ? { decision: 'created', stored, discarded: 0 } : { decision: 'reject', stored: null, discarded: 0, reason: 'rate_limited' }));
/** The store reaching a real write on the existing account ID: consults its write budget, then adopts or refuses with rate_limited. */
const writing = () => mocks.offer.mockImplementation(async (_ledger: unknown, options: Options) => (await options.admitAccountWrite(ID)
  ? { decision: 'adopt', stored, discarded: 0 } : { decision: 'reject', stored, discarded: 0, reason: 'rate_limited' }));
const scopes = () => mocks.rate.mock.calls.map(call => call[0] as string);
const HOUR = 3_600_000;
const DAY = 86_400_000;

beforeEach(() => {
  vi.resetAllMocks();
  mocks.rate.mockResolvedValue({ allowed: true });
  mocks.read.mockResolvedValue(stored);
  mocks.publish.mockResolvedValue(undefined);
});
afterEach(() => {
  delete process.env.FLY_APP_NAME;
  delete process.env.FTOWN_ACCOUNT_CREATE_PER_IP_HOUR;
  delete process.env.FTOWN_ACCOUNT_CREATE_GLOBAL_DAY;
  delete process.env.FTOWN_ACCOUNT_WRITES_PER_10MIN;
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
    expect(mocks.offer).toHaveBeenCalledWith(ledger, LIMITS);
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
    expect(await response.json()).toEqual({ decision: 'keep', ledger, discarded: 0 });
    expect(mocks.publish).not.toHaveBeenCalled();
  });

  it('reject of an existing account is 409 with the stored ledger, and publishes nothing', async () => {
    offer('reject');
    const response = await POST(post(JSON.stringify({ ledger })));
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: 'ledger_rejected', ledger });
    expect(mocks.publish).not.toHaveBeenCalled();
  });

  it('a valid diverged chain is 409 diverged with the stored ledger, never ledger_rejected; nothing published or spent', async () => {
    mocks.offer.mockResolvedValue({ decision: 'reject', stored, discarded: 0, reason: 'diverged' });
    const response = await POST(post(JSON.stringify({ ledger })));
    expect(response.status).toBe(409);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({ error: 'diverged', ledger });
    expect(scopes()).toEqual(['ledger-write']);
    expect(mocks.publish).not.toHaveBeenCalled();
  });

  it('an owner-chosen history adopted over a diverged one is 200 adopt, published, with the count of discarded records', async () => {
    offer('adopt', stored, 3);
    const response = await POST(post(JSON.stringify({ ledger, expectHead: 'H'.repeat(43) })));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ decision: 'adopt', ledger, discarded: 3 });
    expect(mocks.publish).toHaveBeenCalledExactlyOnceWith(ID, ledger);
  });

  it('decision table: each store answer for an existing account has its own status and body, so the client can tell them apart', async () => {
    const table: Array<[string, Record<string, unknown>, number, Record<string, unknown>, boolean]> = [
      ['adopt (ahead)', { decision: 'adopt', stored, discarded: 0 }, 200, { decision: 'adopt', ledger, discarded: 0 }, true],
      ['adopt (owner-chosen, diverged)', { decision: 'adopt', stored, discarded: 2 }, 200, { decision: 'adopt', ledger, discarded: 2 }, true],
      ['keep (same or behind)', { decision: 'keep', stored, discarded: 0 }, 200, { decision: 'keep', ledger, discarded: 0 }, false],
      ['diverged (valid other history)', { decision: 'reject', stored, discarded: 0, reason: 'diverged' }, 409, { error: 'diverged', ledger }, false],
      ['invalid chain', { decision: 'reject', stored, discarded: 0 }, 409, { error: 'ledger_rejected', ledger }, false],
      ['head_changed', { decision: 'reject', stored, discarded: 0, reason: 'head_changed' }, 409, { error: 'head_changed', ledger }, false],
      ['account_unknown', { decision: 'reject', stored: null, discarded: 0, reason: 'account_unknown' }, 404, { error: 'account_unknown' }, false],
      ['rate_limited', { decision: 'reject', stored, discarded: 0, reason: 'rate_limited' }, 429, { error: 'rate_limited' }, false],
    ];
    for (const [name, result, status, body, published] of table) {
      mocks.publish.mockClear();
      mocks.offer.mockResolvedValue(result);
      const response = await POST(post(JSON.stringify({ ledger })));
      expect(response.status, name).toBe(status);
      expect(await response.json(), name).toEqual(body);
      expect(mocks.publish, name).toHaveBeenCalledTimes(published ? 1 : 0);
    }
  });

  it('maps every creation rejection to its status, with { error: reason } only', async () => {
    const table: Array<[string, number]> = [
      ['invalid_ledger', 400], ['registration_closed', 403], ['creation_too_large', 413], ['origin_mismatch', 400],
      ['server_misconfigured', 503], ['server_full', 503], ['handle_taken', 409], ['rate_limited', 429],
    ];
    for (const [reason, status] of table) {
      refuse(reason);
      const response = await POST(post(JSON.stringify({ ledger })));
      expect(response.status, reason).toBe(status);
      expect(response.headers.get('cache-control'), reason).toBe('no-store');
      expect(await response.json(), reason).toEqual({ error: reason });
    }
    expect(mocks.publish).not.toHaveBeenCalled();
  });

  describe('expectHead (a browser re-offering its chain)', () => {
    const HEAD = 'H'.repeat(43);
    it('passes a well-formed expectHead to the store; without it the store gets no options', async () => {
      offer('adopt');
      const response = await POST(post(JSON.stringify({ ledger, expectHead: HEAD })));
      expect(response.status).toBe(200);
      expect(mocks.offer).toHaveBeenLastCalledWith(ledger, LIMITS, { expectHead: HEAD });
      expect(mocks.publish).toHaveBeenCalledTimes(1);
      await POST(post(JSON.stringify({ ledger })));
      expect(mocks.offer.mock.calls[1]).toHaveLength(2);
    });

    it('an unknown account is 404 account_unknown and spends no creation budget', async () => {
      mocks.offer.mockResolvedValue({ decision: 'reject', stored: null, discarded: 0, reason: 'account_unknown' });
      const response = await POST(post(JSON.stringify({ ledger, expectHead: HEAD })));
      expect(response.status).toBe(404);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(await response.json()).toEqual({ error: 'account_unknown' });
      expect(scopes()).toEqual(['ledger-write']);
      expect(mocks.publish).not.toHaveBeenCalled();
    });

    it('a moved head is 409 head_changed with the stored chain, spending no account write budget', async () => {
      mocks.offer.mockResolvedValue({ decision: 'reject', stored, discarded: 0, reason: 'head_changed' });
      const response = await POST(post(JSON.stringify({ ledger, expectHead: HEAD })));
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({ error: 'head_changed', ledger });
      expect(scopes()).toEqual(['ledger-write']);
      expect(mocks.publish).not.toHaveBeenCalled();
    });

    it('400 for an expectHead that is not a head, without calling the store', async () => {
      for (const expectHead of [null, 5, '', 'short', 'H'.repeat(44), '+'.repeat(43), ['x'], { head: HEAD }]) {
        const response = await POST(post(JSON.stringify({ ledger, expectHead })));
        expect(response.status, JSON.stringify(expectHead)).toBe(400);
        expect(await response.json()).toEqual({ error: 'invalid_request' });
      }
      expect(mocks.offer).not.toHaveBeenCalled();
    });
  });

  it('ignores unknown body members, a stray bootstrap included', async () => {
    offer('created');
    for (const extra of [{ bootstrap: 'secret-value' }, { bootstrap: 5 }, { bootstrap: 'b'.repeat(1000) }, { other: true }]) {
      const response = await POST(post(JSON.stringify({ ledger, ...extra })));
      expect(response.status, JSON.stringify(extra)).toBe(201);
      expect(mocks.offer).toHaveBeenLastCalledWith(ledger, LIMITS);
    }
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

describe('POST creation budget', () => {
  it('a creation spends the per-IP hourly budget, then the single global daily key', async () => {
    creating();
    expect((await POST(post(JSON.stringify({ ledger })))).status).toBe(201);
    expect(scopes()).toEqual(['ledger-write', 'account-create-ip', 'account-create-global']);
    expect(mocks.rate).toHaveBeenCalledWith('account-create-ip', mocks.rate.mock.calls[0][1], { maxAttempts: 5, lockoutMs: HOUR });
    expect(mocks.rate).toHaveBeenCalledWith('account-create-global', 'global', { maxAttempts: 200, lockoutMs: DAY });
  });

  it('honours FTOWN_ACCOUNT_CREATE_PER_IP_HOUR and FTOWN_ACCOUNT_CREATE_GLOBAL_DAY', async () => {
    process.env.FTOWN_ACCOUNT_CREATE_PER_IP_HOUR = '50';
    process.env.FTOWN_ACCOUNT_CREATE_GLOBAL_DAY = '10000';
    creating();
    await POST(post(JSON.stringify({ ledger })));
    expect(mocks.rate).toHaveBeenCalledWith('account-create-ip', expect.any(String), { maxAttempts: 50, lockoutMs: HOUR });
    expect(mocks.rate).toHaveBeenCalledWith('account-create-global', 'global', { maxAttempts: 10000, lockoutMs: DAY });
  });

  it('per-IP over budget: 429 rate_limited with Retry-After, and the global budget is not touched', async () => {
    creating();
    mocks.rate.mockImplementation(async (scope: string) => (scope === 'account-create-ip' ? { allowed: false, retryAfterMs: 1_799_500 } : { allowed: true }));
    const response = await POST(post(JSON.stringify({ ledger })));
    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('1800');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({ error: 'rate_limited' });
    expect(scopes()).toEqual(['ledger-write', 'account-create-ip']);
    expect(mocks.publish).not.toHaveBeenCalled();
  });

  it('global over budget: 429 rate_limited, Retry-After bounded by the day window', async () => {
    creating();
    mocks.rate.mockImplementation(async (scope: string) => (scope === 'account-create-global' ? { allowed: false } : { allowed: true }));
    const response = await POST(post(JSON.stringify({ ledger })));
    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe(String(DAY / 1000));
    expect(await response.json()).toEqual({ error: 'rate_limited' });
  });

  it('replica offers and early rejections spend no creation budget', async () => {
    for (const decision of ['adopt', 'keep', 'reject']) {
      offer(decision);
      await POST(post(JSON.stringify({ ledger })));
    }
    mocks.offer.mockResolvedValue({ decision: 'reject', stored, discarded: 0, reason: 'diverged' });
    await POST(post(JSON.stringify({ ledger })));
    for (const reason of ['invalid_ledger', 'registration_closed', 'creation_too_large', 'origin_mismatch']) {
      refuse(reason);
      await POST(post(JSON.stringify({ ledger })));
    }
    await POST(post('{}'));
    expect(scopes().every(scope => scope === 'ledger-write')).toBe(true);
  });
});

describe('POST account write budget', () => {
  it('a real write to an existing account spends ledger-adopt-account, 60 per 10 minutes, keyed by accountId', async () => {
    writing();
    const response = await POST(post(JSON.stringify({ ledger })));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ decision: 'adopt', ledger, discarded: 0 });
    expect(scopes()).toEqual(['ledger-write', 'ledger-adopt-account']);
    expect(mocks.rate).toHaveBeenCalledWith('ledger-adopt-account', ID, { maxAttempts: 60, lockoutMs: 600_000 });
  });

  it('honours FTOWN_ACCOUNT_WRITES_PER_10MIN, read per request', async () => {
    process.env.FTOWN_ACCOUNT_WRITES_PER_10MIN = '3';
    writing();
    await POST(post(JSON.stringify({ ledger })));
    expect(mocks.rate).toHaveBeenCalledWith('ledger-adopt-account', ID, { maxAttempts: 3, lockoutMs: 600_000 });
    process.env.FTOWN_ACCOUNT_WRITES_PER_10MIN = '7';
    mocks.rate.mockClear();
    await POST(post(JSON.stringify({ ledger })));
    expect(mocks.rate).toHaveBeenCalledWith('ledger-adopt-account', ID, { maxAttempts: 7, lockoutMs: 600_000 });
  });

  it('over budget: 429 rate_limited with Retry-After bounded by the window, nothing published', async () => {
    writing();
    mocks.rate.mockImplementation(async (scope: string) => (scope === 'ledger-adopt-account' ? { allowed: false, retryAfterMs: 9_999_999 } : { allowed: true }));
    const response = await POST(post(JSON.stringify({ ledger })));
    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('600');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({ error: 'rate_limited' });
    expect(mocks.publish).not.toHaveBeenCalled();
  });

  it('a keep, a diverged refusal or a rejection never reaches it', async () => {
    for (const result of [{ decision: 'keep', stored, discarded: 0 }, { decision: 'reject', stored, discarded: 0, reason: 'diverged' }, { decision: 'reject', stored, discarded: 0 },
      { decision: 'reject', stored, discarded: 0, reason: 'head_changed' }]) {
      mocks.offer.mockResolvedValue(result);
      await POST(post(JSON.stringify({ ledger })));
    }
    expect(scopes()).toEqual(['ledger-write', 'ledger-write', 'ledger-write', 'ledger-write']);
  });

  it('a creation never spends it, and a write never spends the creation budget', async () => {
    creating();
    await POST(post(JSON.stringify({ ledger })));
    writing();
    await POST(post(JSON.stringify({ ledger })));
    expect(scopes()).toEqual(['ledger-write', 'account-create-ip', 'account-create-global', 'ledger-write', 'ledger-adopt-account']);
  });
});

describe('POST client keys', () => {
  it('buckets an IPv6 client by /64 for the per-IP limits; IPv4 is unchanged', async () => {
    process.env.FLY_APP_NAME = 'ftown';
    creating();
    await POST(post(JSON.stringify({ ledger }), { 'fly-client-ip': '2001:db8:aa:bb:1:2:3:4' }));
    await POST(post(JSON.stringify({ ledger }), { 'fly-client-ip': '2001:db8:aa:bb:ffff::9' }));
    await POST(post(JSON.stringify({ ledger }), { 'fly-client-ip': '203.0.113.7' }));
    const keys = (scope: string) => mocks.rate.mock.calls.filter(call => call[0] === scope).map(call => call[1] as string);
    expect(keys('ledger-write')).toEqual(['2001:db8:aa:bb::/64', '2001:db8:aa:bb::/64', '203.0.113.7']);
    expect(keys('account-create-ip')).toEqual(['2001:db8:aa:bb::/64', '2001:db8:aa:bb::/64', '203.0.113.7']);
    expect(keys('account-create-global')).toEqual(['global', 'global', 'global']);
  });
});

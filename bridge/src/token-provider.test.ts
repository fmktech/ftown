import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { UnauthorizedError } from 'centrifuge';

import { createTokenProvider, tokenLifetimeMs, type ProvidedToken } from './token-provider.js';

/** A non-JWT token: never reused (keeps the ported refresher cases about the exchange itself). */
const once = (token: string): ProvidedToken => ({ token, expiresAt: 0 });
const b64 = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url');
/** A JWT-shaped token with the given claims; `expiresAt` is a deliberately wrong absolute time the provider must ignore. */
const jwt = (name: string, claims: Record<string, unknown>): ProvidedToken => ({ token: `${b64({ alg: 'HS256' })}.${b64({ ...claims, name })}.sig`, expiresAt: 1 });
const hour = (name: string): ProvidedToken => jwt(name, { iat: 1_000, exp: 4_600 });

function make(opts: { fetchToken: () => Promise<ProvidedToken>; random?: () => number; head?: () => string | null }) {
  const clock = { t: 1000 };
  const provider = createTokenProvider({ fetchToken: opts.fetchToken, now: () => clock.t, random: opts.random ?? (() => 0.5), head: opts.head });
  return { clock, provider };
}

describe('tokenLifetimeMs', () => {
  it('reads exp − iat from the JWT payload, capped at two hours', () => {
    assert.equal(tokenLifetimeMs(hour('a').token), 3_600_000);
    assert.equal(tokenLifetimeMs(jwt('b', { iat: 0, exp: 86_400 }).token), 7_200_000);
  });

  it('is null for anything that is not a JWT with a positive numeric lifetime', () => {
    for (const token of ['ok', 'a.b', 'a..c', `x.${b64([1])}.y`, jwt('c', { iat: 5, exp: 5 }).token, jwt('d', { exp: 9 }).token, jwt('e', { iat: '1', exp: 9 }).token, 'a.%%%.c']) {
      assert.equal(tokenLifetimeMs(token), null, token);
    }
  });
});

describe('createTokenProvider', () => {
  it('serializes concurrent requests into one exchange', async () => {
    let release!: (value: ProvidedToken) => void;
    let calls = 0;
    const { provider } = make({ fetchToken: () => { calls++; return new Promise<ProvidedToken>(resolve => { release = resolve; }); } });
    const first = provider.getToken();
    const second = provider.getToken();
    assert.equal(first, second);
    release(once('shared-connect-token'));
    assert.deepEqual(await Promise.all([first, second]), ['shared-connect-token', 'shared-connect-token']);
    assert.equal(calls, 1);
  });

  it('propagates an UnauthorizedError as is', async () => {
    let attempts = 0;
    const { provider } = make({ fetchToken: async () => { attempts++; throw new UnauthorizedError('revoked'); } });
    await assert.rejects(provider.getToken(), UnauthorizedError);
    assert.equal(attempts, 1);
  });

  describe('token reuse (timed from arrival and exp − iat, never the absolute expiresAt)', () => {
    it('reuses a token until a minute before its lifetime ends after arrival, then exchanges again', async () => {
      let calls = 0;
      const { clock, provider } = make({ fetchToken: async () => { calls++; clock.t += 5_000; return hour(`t${calls}`); } });
      const first = await provider.getToken();
      clock.t += 3_540_000 - 1;
      assert.equal(await provider.getToken(), first);
      assert.equal(calls, 1);
      clock.t += 1;
      assert.notEqual(await provider.getToken(), first);
      assert.equal(calls, 2);
    });

    it('never reuses a token without a usable lifetime, or with a minute or less', async () => {
      let calls = 0;
      const tokens = [jwt('short', { iat: 0, exp: 60 }), once('plain'), jwt('broken', { iat: 10, exp: 1 })];
      const { provider } = make({ fetchToken: async () => tokens[calls++] });
      for (let i = 0; i < 3; i++) await provider.getToken();
      assert.equal(calls, 3);
    });

    it('a failed exchange after expiry does not resurrect the old token', async () => {
      let fail = false;
      const { clock, provider } = make({ fetchToken: async () => { if (fail) throw new Error('down'); return jwt('old', { iat: 0, exp: 120 }); } });
      await provider.getToken();
      fail = true;
      clock.t += 60_000;
      await assert.rejects(provider.getToken(), /down/);
      clock.t += 15_000;
      await assert.rejects(provider.getToken(), /down/);
    });
  });

  describe('remembered 401', () => {
    it('rethrows the same UnauthorizedError for 10 minutes without another exchange', async () => {
      let calls = 0;
      const { clock, provider } = make({ fetchToken: async () => { calls++; throw new UnauthorizedError(`no ${calls}`); } });
      const first = await provider.getToken().then(() => assert.fail('should reject'), (e: unknown) => e);
      clock.t += 599_999;
      const again = await provider.getToken().then(() => assert.fail('should reject'), (e: unknown) => e);
      assert.equal(again, first);
      assert.equal(calls, 1);
      assert.equal(provider.cooldownRemainingMs(), 0);
      clock.t += 1;
      await assert.rejects(provider.getToken(), UnauthorizedError);
      assert.equal(calls, 2);
    });

    it('forgets the 401 as soon as the local ledger head changes', async () => {
      let calls = 0;
      let head: string | null = 'H1';
      const { provider } = make({ head: () => head, fetchToken: async () => { calls++; if (calls === 1) throw new UnauthorizedError('no'); return once('ok'); } });
      await assert.rejects(provider.getToken(), UnauthorizedError);
      await assert.rejects(provider.getToken(), UnauthorizedError);
      assert.equal(calls, 1);
      head = 'H2';
      assert.equal(await provider.getToken(), 'ok');
      assert.equal(calls, 2);
    });

    it('a success clears the memory', async () => {
      const results: Array<() => ProvidedToken> = [() => { throw new UnauthorizedError('no'); }, () => once('ok'), () => once('ok2')];
      const { clock, provider } = make({ fetchToken: async () => results.shift()!() });
      await assert.rejects(provider.getToken(), UnauthorizedError);
      clock.t += 600_000;
      assert.equal(await provider.getToken(), 'ok');
      assert.equal(await provider.getToken(), 'ok2');
    });
  });

  describe('transient failure cooldown', () => {
    it('rejects without exchanging during the cooldown, not as UnauthorizedError', async () => {
      let calls = 0;
      const { provider } = make({ fetchToken: async () => { calls++; throw new Error('HTTP 503'); } });
      await assert.rejects(provider.getToken(), /HTTP 503/);
      assert.equal(calls, 1);
      const err = await provider.getToken().then(() => assert.fail('should reject'), (e: unknown) => e);
      assert.ok(err instanceof Error);
      assert.ok(!(err instanceof UnauthorizedError));
      assert.match(err.message, /cooling down for 15s after 1 failed attempts/);
      assert.equal(calls, 1);
    });

    it('grows 15s..480s then caps at 600s', async () => {
      let calls = 0;
      const { clock, provider } = make({ fetchToken: async () => { calls++; throw new Error('down'); } });
      const expected = [15, 30, 60, 120, 240, 480, 600, 600];
      for (const seconds of expected) {
        await assert.rejects(provider.getToken(), /down/);
        assert.equal(provider.cooldownRemainingMs(), seconds * 1000);
        const before = calls;
        await assert.rejects(provider.getToken(), /cooling down/);
        assert.equal(calls, before);
        clock.t += seconds * 1000;
        assert.equal(provider.cooldownRemainingMs(), 0);
      }
      assert.equal(calls, expected.length);
    });

    it('applies 0.8x to just under 1.2x jitter', async () => {
      const fail = async (): Promise<ProvidedToken> => { throw new Error('down'); };
      const low = make({ fetchToken: fail, random: () => 0 });
      await assert.rejects(low.provider.getToken());
      assert.equal(low.provider.cooldownRemainingMs(), 12_000);

      const high = make({ fetchToken: fail, random: () => 0.999999 });
      await assert.rejects(high.provider.getToken());
      const ms = high.provider.cooldownRemainingMs();
      assert.ok(ms < 18_000 && ms > 17_990, `got ${ms}`);
    });

    it('resets the counter after a success', async () => {
      let fail = true;
      const { clock, provider } = make({ fetchToken: async () => { if (fail) throw new Error('down'); return once('ok'); } });
      await assert.rejects(provider.getToken());
      clock.t += 15_000;
      await assert.rejects(provider.getToken());
      assert.equal(provider.cooldownRemainingMs(), 30_000);
      clock.t += 30_000;

      fail = false;
      assert.equal(await provider.getToken(), 'ok');
      assert.equal(provider.cooldownRemainingMs(), 0);

      fail = true;
      await assert.rejects(provider.getToken());
      assert.equal(provider.cooldownRemainingMs(), 15_000);
    });

    it('UnauthorizedError arms no cooldown', async () => {
      const { provider } = make({ fetchToken: async () => { throw new UnauthorizedError('revoked'); } });
      await assert.rejects(provider.getToken(), UnauthorizedError);
      assert.equal(provider.cooldownRemainingMs(), 0);
    });

    it('UnauthorizedError keeps an earlier cooldown count and a success clears it', async () => {
      const results: Array<() => ProvidedToken> = [
        () => { throw new Error('down'); },
        () => { throw new UnauthorizedError('revoked'); },
        () => once('ok'),
        () => { throw new Error('down'); },
      ];
      const { clock, provider } = make({ fetchToken: async () => results.shift()!() });
      await assert.rejects(provider.getToken(), /down/);
      clock.t += 15_000;
      await assert.rejects(provider.getToken(), UnauthorizedError);
      assert.equal(provider.cooldownRemainingMs(), 0);
      clock.t += 600_000;
      assert.equal(await provider.getToken(), 'ok');
      await assert.rejects(provider.getToken(), /down/);
      assert.equal(provider.cooldownRemainingMs(), 15_000);
    });

    it('limits exchanges during a one-hour outage polled every 5s', async () => {
      let calls = 0;
      const { clock, provider } = make({ fetchToken: async () => { calls++; throw new Error('down'); } });
      for (let elapsed = 0; elapsed < 3_600_000; elapsed += 5_000) {
        await provider.getToken().catch(() => undefined);
        clock.t += 5_000;
      }
      assert.ok(calls <= 15, `exchanged ${calls} times`);
    });
  });
});

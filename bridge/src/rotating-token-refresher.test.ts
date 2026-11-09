import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { UnauthorizedError } from 'centrifuge';

import type { BridgeAuthResponse } from './bridge-auth.js';
import { RotatingTokenRefresher } from './rotating-token-refresher.js';

function auth(token: string, refreshToken: string): BridgeAuthResponse {
  return {
    token,
    refreshToken,
    userId: 'user@example.com',
    centrifugoUrl: 'wss://centrifugo.test/connection/websocket',
  };
}

describe('RotatingTokenRefresher', () => {
  it('recovers from stale in-memory state using a newer persisted token', async () => {
    const attempted: string[] = [];
    const persisted: string[] = [];
    let recovered = 0;
    const refresher = new RotatingTokenRefresher({
      initialRefreshToken: 'stale-in-memory',
      loadPersistedRefreshToken: () => 'newer-on-disk',
      persistRefreshToken: (token) => persisted.push(token),
      onPersistedTokenRecovery: () => recovered++,
      refresh: async (token) => {
        attempted.push(token);
        if (token === 'stale-in-memory') {
          throw new UnauthorizedError('rotated');
        }
        return auth('connect-token', 'next-refresh-token');
      },
    });

    assert.equal(await refresher.getToken(), 'connect-token');
    assert.deepEqual(attempted, ['stale-in-memory', 'newer-on-disk']);
    assert.deepEqual(persisted, ['next-refresh-token']);
    assert.equal(recovered, 1);
  });

  it('stops after a permanent rejection when disk has no newer token', async () => {
    let attempts = 0;
    const refresher = new RotatingTokenRefresher({
      initialRefreshToken: 'revoked-token',
      loadPersistedRefreshToken: () => 'revoked-token',
      persistRefreshToken: () => assert.fail('must not persist after rejection'),
      refresh: async () => {
        attempts++;
        throw new UnauthorizedError('revoked');
      },
    });

    await assert.rejects(refresher.getToken(), UnauthorizedError);
    assert.equal(attempts, 1);
  });

  it('serializes concurrent requests so a rotating token is used only once', async () => {
    let release!: (value: BridgeAuthResponse) => void;
    const response = new Promise<BridgeAuthResponse>((resolve) => {
      release = resolve;
    });
    const attempted: string[] = [];
    const refresher = new RotatingTokenRefresher({
      initialRefreshToken: 'current-token',
      loadPersistedRefreshToken: () => 'current-token',
      persistRefreshToken: () => undefined,
      refresh: async (token) => {
        attempted.push(token);
        return response;
      },
    });

    const first = refresher.getToken();
    const second = refresher.getToken();
    assert.equal(first, second);
    assert.deepEqual(attempted, ['current-token']);

    release(auth('shared-connect-token', 'rotated-token'));
    assert.deepEqual(await Promise.all([first, second]), [
      'shared-connect-token',
      'shared-connect-token',
    ]);
  });

  describe('transient failure cooldown', () => {
    function make(opts: {
      refresh: (token: string) => Promise<BridgeAuthResponse>;
      random?: () => number;
      persisted?: string;
      onRecovery?: () => void;
    }) {
      const clock = { t: 1000 };
      const refresher = new RotatingTokenRefresher({
        initialRefreshToken: 'tok',
        loadPersistedRefreshToken: () => opts.persisted,
        persistRefreshToken: () => undefined,
        onPersistedTokenRecovery: opts.onRecovery,
        refresh: opts.refresh,
        now: () => clock.t,
        random: opts.random ?? (() => 0.5),
      });
      return { clock, refresher };
    }

    it('rejects without calling refresh during the cooldown, not as UnauthorizedError', async () => {
      let calls = 0;
      const { refresher } = make({
        refresh: async () => {
          calls++;
          throw new Error('HTTP 503');
        },
      });

      await assert.rejects(refresher.getToken(), /HTTP 503/);
      assert.equal(calls, 1);
      const err = await refresher.getToken().then(
        () => assert.fail('should reject'),
        (e: unknown) => e,
      );
      assert.ok(err instanceof Error);
      assert.ok(!(err instanceof UnauthorizedError));
      assert.match(err.message, /cooling down for 15s after 1 failed attempts/);
      assert.equal(calls, 1);
    });

    it('grows 15s..480s then caps at 600s', async () => {
      let calls = 0;
      const { clock, refresher } = make({
        refresh: async () => {
          calls++;
          throw new Error('down');
        },
      });
      const expected = [15, 30, 60, 120, 240, 480, 600, 600];
      for (const seconds of expected) {
        await assert.rejects(refresher.getToken(), /down/);
        assert.equal(refresher.cooldownRemainingMs(), seconds * 1000);
        const before = calls;
        await assert.rejects(refresher.getToken(), /cooling down/);
        assert.equal(calls, before);
        clock.t += seconds * 1000;
        assert.equal(refresher.cooldownRemainingMs(), 0);
      }
      assert.equal(calls, expected.length);
    });

    it('applies 0.8x to just under 1.2x jitter', async () => {
      const fail = async (): Promise<BridgeAuthResponse> => {
        throw new Error('down');
      };
      const low = make({ refresh: fail, random: () => 0 });
      await assert.rejects(low.refresher.getToken());
      assert.equal(low.refresher.cooldownRemainingMs(), 12_000);

      const high = make({ refresh: fail, random: () => 0.999999 });
      await assert.rejects(high.refresher.getToken());
      const ms = high.refresher.cooldownRemainingMs();
      assert.ok(ms < 18_000 && ms > 17_990, `got ${ms}`);
    });

    it('resets the counter after a success', async () => {
      let fail = true;
      const { clock, refresher } = make({
        refresh: async () => {
          if (fail) throw new Error('down');
          return auth('ok', 'next');
        },
      });
      await assert.rejects(refresher.getToken());
      clock.t += 15_000;
      await assert.rejects(refresher.getToken());
      assert.equal(refresher.cooldownRemainingMs(), 30_000);
      clock.t += 30_000;

      fail = false;
      assert.equal(await refresher.getToken(), 'ok');
      assert.equal(refresher.cooldownRemainingMs(), 0);

      fail = true;
      await assert.rejects(refresher.getToken());
      assert.equal(refresher.cooldownRemainingMs(), 15_000);
    });

    it('UnauthorizedError arms no cooldown and the next call retries', async () => {
      let calls = 0;
      const { refresher } = make({
        persisted: 'tok',
        refresh: async () => {
          calls++;
          throw new UnauthorizedError('revoked');
        },
      });
      await assert.rejects(refresher.getToken(), UnauthorizedError);
      assert.equal(refresher.cooldownRemainingMs(), 0);
      await assert.rejects(refresher.getToken(), UnauthorizedError);
      assert.equal(calls, 2);
    });

    it('persisted-token recovery still works and a transient retry failure arms the cooldown', async () => {
      let recovered = 0;
      const ok = make({
        persisted: 'disk',
        onRecovery: () => recovered++,
        refresh: async (token) => {
          if (token === 'tok') throw new UnauthorizedError('rotated');
          return auth('adopted', 'next');
        },
      });
      assert.equal(await ok.refresher.getToken(), 'adopted');
      assert.equal(recovered, 1);
      assert.equal(ok.refresher.cooldownRemainingMs(), 0);

      const attempted: string[] = [];
      const bad = make({
        persisted: 'disk',
        refresh: async (token) => {
          attempted.push(token);
          if (token === 'tok') throw new UnauthorizedError('rotated');
          throw new Error('HTTP 502');
        },
      });
      await assert.rejects(bad.refresher.getToken(), /HTTP 502/);
      assert.deepEqual(attempted, ['tok', 'disk']);
      assert.equal(bad.refresher.cooldownRemainingMs(), 15_000);
    });

    it('shares one in-flight refresh between concurrent callers', async () => {
      let calls = 0;
      let release!: (value: BridgeAuthResponse) => void;
      const { refresher } = make({
        refresh: () => {
          calls++;
          return new Promise<BridgeAuthResponse>((resolve) => {
            release = resolve;
          });
        },
      });
      const a = refresher.getToken();
      const b = refresher.getToken();
      assert.equal(a, b);
      release(auth('shared', 'next'));
      assert.deepEqual(await Promise.all([a, b]), ['shared', 'shared']);
      assert.equal(calls, 1);
    });

    it('limits calls during a one-hour outage polled every 5s', async () => {
      let calls = 0;
      const { clock, refresher } = make({
        refresh: async () => {
          calls++;
          throw new Error('down');
        },
      });
      for (let elapsed = 0; elapsed < 3_600_000; elapsed += 5_000) {
        await refresher.getToken().catch(() => undefined);
        clock.t += 5_000;
      }
      assert.ok(calls <= 15, `refresh called ${calls} times`);
    });
  });
});

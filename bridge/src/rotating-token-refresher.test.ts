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
});

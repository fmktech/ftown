import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { UnauthorizedError } from 'centrifuge';

import { refreshBridgeToken } from './bridge-auth.js';

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('refreshBridgeToken', () => {
  it('classifies a rejected rotating credential as permanent authorization failure', async () => {
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({ error: 'Refresh token has been rotated or revoked' }),
        { status: 401, headers: { 'Content-Type': 'application/json' } },
      );

    await assert.rejects(
      refreshBridgeToken(
        'https://ftown.test',
        'stale-refresh-token',
        'bridge-1',
        { localPort: 43123, localNonce: 'nonce' },
      ),
      (error: unknown) => {
        assert.ok(
          error instanceof UnauthorizedError,
          '401 must be terminal so centrifuge-js does not retry the stale token forever',
        );
        return true;
      },
    );
  });

  it('keeps transient server failures retryable', async () => {
    globalThis.fetch = async () =>
      new Response('temporarily unavailable', { status: 503 });

    await assert.rejects(
      refreshBridgeToken(
        'https://ftown.test',
        'current-refresh-token',
        'bridge-1',
        { localPort: 43123, localNonce: 'nonce' },
      ),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(error instanceof UnauthorizedError, false);
        assert.match(error.message, /Token refresh failed \(503\)/);
        return true;
      },
    );
  });
});

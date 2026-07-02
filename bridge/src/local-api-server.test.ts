import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ProviderAuthMissingError, WorkingDirMissingError } from './create-ftown-session.js';
import { LocalApiServer, providerAuthMissingResponse, workingDirMissingResponse } from './local-api-server.js';
import { SessionStore } from './session-store.js';
import type { CentrifugoClient } from './centrifugo-client.js';
import type { ProcessRunner } from './claude-runner.js';
import type { Loop } from './types.js';

async function api(
  port: number,
  token: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; data: Record<string, unknown> }> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, data: (await res.json()) as Record<string, unknown> };
}

// A blocked provider create/revive must surface as a 422 carrying the provider,
// the env-var KEY-bearing message, and the `ftown env set` fix — and NEVER the
// secret token itself. providerAuthMissingResponse builds that body once so both
// the create and revive catch branches stay identical.
describe('providerAuthMissingResponse', () => {
  it('maps a ProviderAuthMissingError to a 422 with {error, provider, fix}', () => {
    const err = new ProviderAuthMissingError('zai', 'ZAI_API_TOKEN', 'ftown env set zai <token>');
    const response = providerAuthMissingResponse(err);

    assert.strictEqual(response.status, 422);
    assert.strictEqual(response.body.error, err.message);
    assert.strictEqual(response.body.provider, 'zai');
    assert.strictEqual(response.body.fix, 'ftown env set zai <token>');
  });

  it('carries only the env-var KEY and fix, never a token value', () => {
    const secret = 'sk-super-secret-token-value-1234';
    const err = new ProviderAuthMissingError('kimi', 'KIMI_API_TOKEN', 'ftown env set kimi <token>');
    const response = providerAuthMissingResponse(err);

    const serialized = JSON.stringify(response.body);
    assert.ok(serialized.includes('KIMI_API_TOKEN'), 'body should name the env-var KEY');
    assert.ok(!serialized.includes(secret), 'body must not contain any token value');
    assert.strictEqual(response.body.provider, 'kimi');
    assert.strictEqual(response.body.fix, 'ftown env set kimi <token>');
  });

  it('echoes the provider flavor verbatim for each mapped flavor', () => {
    for (const provider of ['zai', 'fireworks', 'kimi', 'deepseek']) {
      const err = new ProviderAuthMissingError(
        provider,
        `${provider.toUpperCase()}_API_TOKEN`,
        `ftown env set ${provider} <token>`,
      );
      const response = providerAuthMissingResponse(err);
      assert.strictEqual(response.status, 422);
      assert.strictEqual(response.body.provider, provider);
      assert.strictEqual(response.body.fix, `ftown env set ${provider} <token>`);
    }
  });
});

describe('workingDirMissingResponse', () => {
  it('maps a WorkingDirMissingError to a 422 with a createable code and path', () => {
    const err = new WorkingDirMissingError('/tmp/missing-project');
    const response = workingDirMissingResponse(err);

    assert.strictEqual(response.status, 422);
    assert.strictEqual(response.body.error, err.message);
    assert.strictEqual(response.body.code, 'working_dir_missing');
    assert.strictEqual(response.body.workingDir, '/tmp/missing-project');
    assert.strictEqual(response.body.canCreate, true);
  });
});

describe('LocalApiServer loop routes', () => {
  it('creates, lists, runs, pauses, and deletes bridge-owned loops', async () => {
    const realHome = process.env.HOME;
    const home = mkdtempSync(join(tmpdir(), 'ftw-loop-api-'));
    process.env.HOME = home;

    const server = new LocalApiServer();
    const token = 'test-token';
    const published: Loop[] = [];
    const removed: string[] = [];
    const deleted: Loop[] = [];
    let kicks = 0;

    const store = new SessionStore(join(home, 'data'));
    const runner = { isRunning: () => false } as unknown as ProcessRunner;
    const centrifugo = {
      publishLoopUpdate: async (_userId: string, loop: Loop) => {
        published.push(loop);
      },
      publishLoopRemoved: async (_userId: string, loopId: string) => {
        removed.push(loopId);
      },
    } as unknown as CentrifugoClient;

    server.setAuthToken(token);
    server.setDependencies(store, runner, centrifugo, 'user-1');
    server.setLoopApi({
      bridgeId: 'bridge-1',
      scheduler: {
        kick: () => {
          kicks += 1;
        },
        onLoopDeleted: (loop) => {
          deleted.push(loop);
        },
      },
    });

    const port = await server.start();
    try {
      const create = await api(port, token, 'POST', '/api/loops', {
        name: 'nightly',
        schedule: { kind: 'interval', everyMs: 60_000 },
        harness: 'codex',
        task: 'run checks',
        enabled: true,
        overlapPolicy: 'skip',
        retention: { autoClearAfterRuns: 3 },
      });
      assert.strictEqual(create.status, 201);
      const loop = create.data.loop as Loop;
      assert.strictEqual(loop.bridgeId, 'bridge-1');
      assert.strictEqual(loop.harness, 'codex');
      assert.strictEqual(published.length, 1);

      const list = await api(port, token, 'GET', '/api/loops');
      assert.strictEqual(list.status, 200);
      assert.strictEqual((list.data.loops as Loop[]).length, 1);

      const runNow = await api(port, token, 'POST', `/api/loops/${loop.id}/run-now`);
      assert.strictEqual(runNow.status, 200);
      assert.strictEqual(runNow.data.fired, true);
      assert.strictEqual(kicks, 1);

      const pause = await api(port, token, 'PATCH', `/api/loops/${loop.id}`, { enabled: false });
      assert.strictEqual(pause.status, 200);
      assert.strictEqual((pause.data.loop as Loop).enabled, false);

      const del = await api(port, token, 'DELETE', `/api/loops/${loop.id}`);
      assert.strictEqual(del.status, 200);
      assert.strictEqual(del.data.removed, true);
      assert.deepStrictEqual(removed, [loop.id]);
      assert.strictEqual(deleted[0].id, loop.id);
    } finally {
      server.stop();
      if (realHome === undefined) delete process.env.HOME;
      else process.env.HOME = realHome;
      rmSync(home, { recursive: true, force: true });
    }
  });
});

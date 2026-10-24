import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AttentionStore } from './attention-store.js';

import type { CommandRpcDeps } from './command-rpc.js';
import { createCommandHandler } from './command-rpc.js';
import type { SessionController } from './session-controller.js';
import type { Command, CommandResponse, Session } from './types.js';

test('attention RPC requires owner targeting and persists read/resolve results', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'attention-rpc-'));
  await mkdir(join(dir, 'session'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const attentionStore = new AttentionStore(id => join(dir, id));
  const event = (await attentionStore.record('session', 'Notification', { notification_type: 'agent_needs_input', message: 'Review' }))!;
  const responses: CommandResponse[] = [];
  const handler = createCommandHandler({ bridgeId: 'owner', attentionStore,
    sessionController: { get: async (id: string) => id === 'session' ? { id, bridgeId: 'owner' } : null } as unknown as SessionController,
    publishCommandResponse: async response => { responses.push(response); } });
  for (const payload of [{ sessionId: 'session' }, { bridgeId: 'owner', sessionId: 'missing' }, { bridgeId: 'owner', sessionId: '../session' }]) {
    await handler({ type: 'get_session_attention', requestId: 'invalid', payload });
    assert.equal(responses.at(-1)?.success, false);
  }
  const count = responses.length;
  await handler({ type: 'get_session_attention', requestId: 'foreign', payload: { bridgeId: 'foreign', sessionId: 'session' } });
  assert.equal(responses.length, count);
  await handler({ type: 'get_session_attention', requestId: 'read', payload: { bridgeId: 'owner', sessionId: 'session' } });
  assert.deepEqual(responses.at(-1)?.data, { sessionId: 'session', attention: event, sequence: event.sequence });
  await handler({ type: 'resolve_session_attention', requestId: 'resolve', payload: { bridgeId: 'owner', sessionId: 'session', eventId: event.id } });
  assert.equal(responses.at(-1)?.success, true);
  assert.equal((await new AttentionStore(id => join(dir, id)).explicitSnapshot('session')).attention, null);
});

test('update_session_parent rejects a missing or invalid parentSessionId', async () => {
  const responses: CommandResponse[] = [];
  const session = {
    id: 'child',
    name: 'child',
    command: 'claude',
    status: 'running',
    bridgeId: 'bridge-1',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  } as Session;
  const sessionController = {
    update: async () => ({ ok: true, session }) as const,
  } as unknown as SessionController;
  const handler = createCommandHandler({
    bridgeId: 'bridge-1',
    sessionController,
    publishCommandResponse: async (response) => {
      responses.push(response);
    },
  });

  await handler({
    type: 'update_session_parent',
    payload: { sessionId: 'child' },
    requestId: 'request-1',
  } as unknown as Command);
  await handler({
    type: 'update_session_parent',
    payload: { sessionId: 'child', parentSessionId: 42 },
    requestId: 'request-2',
  } as unknown as Command);

  assert.deepEqual(responses, [
    {
      requestId: 'request-1',
      success: false,
      error: 'Missing or invalid parentSessionId',
    },
    {
      requestId: 'request-2',
      success: false,
      error: 'Missing or invalid parentSessionId',
    },
  ]);
});

test('get_sessions_usage returns one id-keyed response for a session batch', async () => {
  const responses: CommandResponse[] = [];
  const calls: string[][] = [];
  const usage = {
    inputTokens: 1,
    outputTokens: 2,
    cacheReadTokens: 3,
    cacheWriteTokens: 4,
    totalTokens: 10,
    models: ['claude-sonnet-5'],
    harness: 'claude',
    collectedAt: '2026-08-07T00:00:00.000Z',
  };
  const sessionController = {
    usages: async (sessionIds: string[]) => {
      calls.push(sessionIds);
      return { 'session-1': usage };
    },
  } as unknown as SessionController;
  const handler = createCommandHandler({
    bridgeId: 'bridge-1',
    sessionController,
    publishCommandResponse: async (response) => { responses.push(response); },
  });

  await handler({
    type: 'get_sessions_usage',
    payload: { bridgeId: 'bridge-1', sessionIds: ['session-1', 'session-2'] },
    requestId: 'usage-batch-1',
  } as unknown as Command);

  assert.deepEqual(calls, [['session-1', 'session-2']]);
  assert.deepEqual(responses, [{
    requestId: 'usage-batch-1',
    success: true,
    data: { usages: { 'session-1': usage } },
  }]);
});

for (const populated of [false, true]) {
  test(`list_sessions supplies bridge identity (${populated ? 'nonempty' : 'empty'}) and strips env`, async () => {
    const session = { id: 'scratch', bridgeId: 'owner', status: 'completed', env: { SECRET: 'scratch' } } as unknown as Session;
    const responses: CommandResponse[] = [];
    const handler = createCommandHandler({ bridgeId: 'owner', sessionController: { list: async () => populated ? [session] : [] }, publishCommandResponse: async r => { responses.push(r); } } as unknown as CommandRpcDeps);
    await handler({ type: 'list_sessions', requestId: 'broadcast', payload: {} });
    assert.equal(responses[0].success, true);
    const data = responses[0].data as { bridgeId: string; sessions: Session[] };
    assert.equal(data.bridgeId, 'owner'); assert.equal(data.sessions.length, Number(populated));
    if (populated) { assert.equal('env' in data.sessions[0], false); assert.deepEqual(session.env, { SECRET: 'scratch' }); }
    await handler({ type: 'list_sessions', requestId: 'foreign', payload: { bridgeId: 'other' } });
    assert.equal(responses.length, 1);
  });
}
test('retired RPC commands reject without dependencies, preserving routing and correlation', async () => {
  const responses: CommandResponse[] = [];
  const handler = createCommandHandler({ bridgeId: 'owner', sessionController: new Proxy({}, {
    get() { throw new Error('Retired commands must not touch sessions'); },
  }) as SessionController, publishCommandResponse: async (response) => { responses.push(response); } });
  const retired = ['create_loop', 'list_loops', 'update_loop', 'delete_loop', 'run_loop_now', 'get_loop_runs'];
  for (const type of retired) {
    await handler({ type, requestId: type, payload: { bridgeId: 'owner' } } as unknown as Command);
    assert.deepEqual(responses.at(-1), { requestId: type, success: false,
      error: 'Recurring loops and factory automation have been removed', data: { code: 'automation_removed' } });
    const count = responses.length;
    await handler({ type, requestId: 'foreign', payload: { bridgeId: 'other' } } as unknown as Command);
    assert.equal(responses.length, count);
  }
});

test('legacy automation retry preserves retirement code in RPC response', async () => {
  const responses: CommandResponse[] = [];
  const handler = createCommandHandler({ bridgeId: 'owner', sessionController: {
    retry: async () => ({ ok: false, code: 'automation_removed', message: 'Recurring loops and factory automation have been removed' }),
  } as unknown as SessionController, publishCommandResponse: async (response) => { responses.push(response); } });
  await handler({ type: 'retry_session', requestId: 'retry', payload: { sessionId: 'legacy' } });
  assert.deepEqual(responses, [{ requestId: 'retry', success: false,
    error: 'Recurring loops and factory automation have been removed', data: { code: 'automation_removed' } }]);
});

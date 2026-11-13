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
import { UpdateAdmission, UpdateResponseTicket } from './update-admission.js';
import { UpdateEffects } from './update-effects.js';
import type { BridgeUpdateCoordinator } from './bridge-update.js';
import type { BridgeSecurityService } from './security/bridge/security.js';
import type { VerifiedApplication } from './security/protocol.js';

test('targeted update commands validate payloads and bind an accepted ticket to verified dispatch', async () => {
  const responses: CommandResponse[] = []; let requests = 0, starts = 0;
  const effects = new UpdateEffects(new UpdateAdmission());
  const updates = { snapshot: async () => ({ bridgeId: 'bridge' }), request: async () => {
    requests++; return { accepted: { bridgeId: 'bridge', operation: { id: 'op', targetVersion: '1.2.3' } }, ticket: new UpdateResponseTicket(() => { starts++; }, () => {}) };
  } } as unknown as BridgeUpdateCoordinator;
  const security = { revalidate: async () => {} } as unknown as BridgeSecurityService;
  const handler = createCommandHandler({ bridgeId: 'bridge', updates, updateEffects: effects, security,
    sessionController: {} as SessionController, publishCommandResponse: async response => { responses.push(response); } });
  const message = (requestId: string, command: string, payload: Record<string, unknown>) => ({ envelope: { messageId: requestId }, principal: {}, application: { route: { kind: 'command', requestId, command, sessionId: null }, data: { type: command, requestId, payload } } }) as unknown as VerifiedApplication;
  const payload = { bridgeId: 'bridge', targetVersion: '1.2.3', operationId: 'op' };
  const verified = message('r', 'update_bridge', payload); effects.admitted(verified);
  await handler({ type: 'update_bridge', requestId: 'r', payload }, verified);
  assert.equal(responses.at(-1)?.success, true); assert.equal(requests, 1);
  effects.sealed(verified, { type: 'command_response', response: responses.at(-1)! as unknown as import('./security/protocol.js').ApplicationJson });
  assert.equal(starts, 0); effects.delivered('r'); await new Promise(resolve => setImmediate(resolve)); assert.equal(starts, 1);
  const before = responses.length;
  await handler({ type: 'update_bridge', requestId: 'foreign', payload: { ...payload, bridgeId: 'other' } }, message('foreign', 'update_bridge', payload));
  assert.equal(responses.length, before);
  await handler({ type: 'get_bridge_update', requestId: 'invalid', payload: { bridgeId: 'bridge', refresh: 'yes' } }, message('invalid', 'get_bridge_update', {}));
  assert.equal(responses.at(-1)?.success, false); assert.equal((responses.at(-1)?.data as { code: string }).code, 'invalid_update_request');
  await handler({ type: 'update_bridge', requestId: 'unauthenticated', payload }); assert.equal(responses.at(-1)?.success, false); assert.equal(requests, 1);
});

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

test('answer_session_attention delivers via waiter, hook, or mail and maps errors', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'attention-answer-rpc-'));
  await mkdir(join(dir, 'session'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const attentionStore = new AttentionStore(id => join(dir, id));
  const question = { question: 'Pick', options: [{ label: 'A' }, { label: 'B' }], multiSelect: false, allowText: false };
  const ask = async (channel: 'mail' | 'hook') => (await attentionStore.record('session', 'Notification', { notification_type: 'agent_needs_input', message: 'Q' }, { prompt: { channel, questions: [question] } }))!;
  const responses: CommandResponse[] = [];
  const mails: Record<string, unknown>[] = [];
  let mailMode: 'ok' | 'fail' | 'throw' = 'ok';
  const make = (extra: Partial<CommandRpcDeps> = {}) => createCommandHandler({ bridgeId: 'owner', attentionStore,
    acceptSessionMail: async (_s, body) => { if (mailMode === 'throw') throw new Error('boom'); if (mailMode === 'fail') return { ok: false, error: 'nope' }; mails.push(body); return { ok: true, id: 'm1' }; },
    sessionController: { get: async (id: string) => id === 'session' ? { id, bridgeId: 'owner' } : null } as unknown as SessionController,
    publishCommandResponse: async response => { responses.push(response); }, ...extra });
  const handler = make();
  const send = (eventId: string, extra: Record<string, unknown> = {}) => handler({ type: 'answer_session_attention', requestId: 'r', payload: { bridgeId: 'owner', sessionId: 'session', eventId, answers: [{ selected: [1] }], ...extra } });
  const code = () => (responses.at(-1)?.data as { code?: string }).code;

  const mailEvent = await ask('mail');
  await send(mailEvent.id);
  assert.equal(responses.at(-1)?.success, true);
  assert.equal((responses.at(-1)?.data as { delivery: string }).delivery, 'mail');
  assert.equal(mails.length, 1);
  assert.equal(mails[0]?.from, 'browser'); assert.equal(mails[0]?.fromName, 'You'); assert.equal(mails[0]?.type, 'message');
  assert.equal(mails[0]?.threadId, `attention:${mailEvent.id}`); assert.match(String(mails[0]?.body), /B/);

  await send(mailEvent.id); assert.equal(responses.at(-1)?.success, false); assert.equal(code(), 'attention_already_resolved');

  const goneEvent = await ask('hook');
  await send(goneEvent.id); assert.equal(responses.at(-1)?.success, false); assert.equal(code(), 'answer_waiter_gone');

  const hookEvent = await ask('hook');
  const waiting = attentionStore.waitForItem('session', hookEvent.id, 5000);
  await send(hookEvent.id);
  assert.equal((await waiting).resolution, 'answered');
  assert.equal((responses.at(-1)?.data as { delivery: string }).delivery, 'waiter');
  assert.equal(mails.length, 1);

  mailMode = 'fail';
  const failEvent = await ask('mail');
  await send(failEvent.id);
  assert.equal(responses.at(-1)?.success, true);
  assert.equal((responses.at(-1)?.data as { delivery: string }).delivery, 'mail_failed');
  mailMode = 'throw';
  const throwEvent = await ask('mail');
  await send(throwEvent.id);
  assert.equal((responses.at(-1)?.data as { delivery: string }).delivery, 'mail_failed');

  const invalidEvent = await ask('mail');
  await send(invalidEvent.id, { answers: [{ selected: [9] }] }); assert.equal(responses.at(-1)?.success, false); assert.equal(code(), 'invalid_answer');
  await send('missing'); assert.equal(code(), 'attention_not_found');
  const plain = (await attentionStore.record('session', 'Notification', { notification_type: 'agent_needs_input', message: 'plain' }))!;
  await send(plain.id); assert.equal(code(), 'attention_not_answerable');

  const before = responses.length;
  await handler({ type: 'answer_session_attention', requestId: 'foreign', payload: { bridgeId: 'foreign', sessionId: 'session', eventId: 'x', answers: [] } });
  assert.equal(responses.length, before);
  for (const bad of [{ extra: 1 }, { answers: 'x' }, { eventId: '../x' }, { sessionId: 'missing' }]) {
    await send(invalidEvent.id, bad); assert.equal(responses.at(-1)?.success, false);
  }
});

test('answer_session_attention: live waiter on mail channel skips mail; missing mail dep reports mail_failed but stores the answer', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'attention-answer-rpc2-'));
  await mkdir(join(dir, 'session'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const attentionStore = new AttentionStore(id => join(dir, id));
  const question = { question: 'Pick', options: [{ label: 'A' }, { label: 'B' }], multiSelect: false, allowText: false };
  const ask = async () => (await attentionStore.record('session', 'Notification', { notification_type: 'agent_needs_input', message: 'Q' }, { prompt: { channel: 'mail', questions: [question] } }))!;
  const responses: CommandResponse[] = [];
  const mails: Record<string, unknown>[] = [];
  const sessionController = { get: async (id: string) => id === 'session' ? { id, bridgeId: 'owner' } : null } as unknown as SessionController;
  const withMail = createCommandHandler({ bridgeId: 'owner', attentionStore, sessionController,
    acceptSessionMail: async (_s, body) => { mails.push(body); return { ok: true, id: 'm' }; }, publishCommandResponse: async r => { responses.push(r); } });
  const noMail = createCommandHandler({ bridgeId: 'owner', attentionStore, sessionController, publishCommandResponse: async r => { responses.push(r); } });
  const send = (h: typeof withMail, eventId: string) => h({ type: 'answer_session_attention', requestId: 'r', payload: { bridgeId: 'owner', sessionId: 'session', eventId, answers: [{ selected: [0] }] } });

  const live = await ask();
  const waiting = attentionStore.waitForItem('session', live.id, 5000);
  await send(withMail, live.id);
  assert.equal(responses.at(-1)?.success, true);
  assert.equal((responses.at(-1)?.data as { delivery: string }).delivery, 'waiter');
  assert.equal(mails.length, 0);
  assert.equal((await waiting).resolution, 'answered');

  const orphan = await ask();
  await send(noMail, orphan.id);
  assert.equal(responses.at(-1)?.success, true);
  assert.equal((responses.at(-1)?.data as { delivery: string }).delivery, 'mail_failed');
  const stored = (await attentionStore.explicitSnapshot('session')).attention;
  assert.ok(stored === null || stored.id !== orphan.id);
  assert.equal((await attentionStore.waitForItem('session', orphan.id, 0)).resolution, 'answered');
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
test('create_session forwards the grok and antigravity native session ids to the controller', async () => {
  const responses: CommandResponse[] = []; const inputs: Record<string, unknown>[] = [];
  const handler = createCommandHandler({ bridgeId: 'owner', sessionController: {
    create: async (input: Record<string, unknown>) => { inputs.push(input); return { id: 'created', bridgeId: 'owner', status: 'running', ...input }; },
  } as unknown as SessionController, publishCommandResponse: async (response) => { responses.push(response); } });
  for (const payload of [
    { shellType: 'grok', grokSessionId: 'grok-abc' },
    { shellType: 'antigravity', antigravitySessionId: 'conv-abc' },
  ]) {
    await handler({ type: 'create_session', requestId: payload.shellType, payload } as unknown as Command);
    assert.equal(responses.at(-1)?.success, true);
  }
  assert.equal(inputs[0].grokSessionId, 'grok-abc'); assert.equal(inputs[0].antigravitySessionId, undefined);
  assert.equal(inputs[1].antigravitySessionId, 'conv-abc'); assert.equal(inputs[1].grokSessionId, undefined);
});

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

test('PR status RPC requires verified security and targets only validated local session URLs', async () => {
  const responses: CommandResponse[] = []; let lookups = 0; let requested: readonly string[] = [];
  const security = { revalidate: async () => {} } as unknown as BridgeSecurityService;
  const service = { get: async (urls: readonly string[]) => { requested = urls; return { statuses: [], nextRefreshAt: '2026-01-01T00:00:00.000Z' }; } } as unknown as import('./pull-request-status.js').PullRequestStatusService;
  const sessionController = { get: async (id: string) => { lookups++; return id === 'good' ? { bridgeId: 'owner', pullRequestUrl: 'https://github.com/a/b/pull/1' } : id === 'foreign' ? { bridgeId: 'other', pullRequestUrl: 'https://github.com/a/b/pull/2' } : null; } } as unknown as SessionController;
  const payload = { bridgeId: 'owner', sessionIds: ['good', 'foreign', 'missing'] };
  const command: Command = { type: 'get_pull_request_statuses', requestId: 'one', payload };
  const verified = { principal: {} } as VerifiedApplication;
  const make = (configured?: BridgeSecurityService) => createCommandHandler({ bridgeId: 'owner', security: configured, sessionController, pullRequestStatuses: service, publishCommandResponse: async response => { responses.push(response); } });
  await make()(command, verified); assert.equal(responses.at(-1)?.success, false);
  await make(security)(command); assert.equal(responses.at(-1)?.success, false); assert.equal(lookups, 0);
  await make(security)(command, verified); assert.equal(responses.at(-1)?.success, true); assert.deepEqual(requested, ['https://github.com/a/b/pull/1']);
  for (const bad of [{ bridgeId: 'owner', sessionIds: [] }, { bridgeId: 'owner', sessionIds: ['good', 'good'] }, { bridgeId: 'owner', sessionIds: ['../bad'] }, { bridgeId: 'owner', sessionIds: ['good'], url: 'https://evil' }, { sessionIds: ['good'] }]) {
    await make(security)({ ...command, payload: bad }, verified); assert.equal(responses.at(-1)?.success, false);
  }
});

test('browser session mail requires control authority and queues only valid local running targets', async () => {
  const { BridgeSecurityError } = await import('./security/bridge/errors.js');
  const responses: CommandResponse[] = []; let sessionReads = 0; let enqueues = 0; let authorized = true;
  const running = { id: 'session', bridgeId: 'bridge', status: 'running' } as Session;
  const calls: Array<{ session: Session; message: string }> = [];
  const security = { revalidate: async () => {}, policy: { revalidate: async (_principal: unknown, permission: string) => {
    assert.equal(permission, 'control'); if (!authorized) throw new BridgeSecurityError('permission_denied');
  } } } as unknown as BridgeSecurityService;
  const verified = { principal: {} } as VerifiedApplication;
  const sessionController = { get: async (id: string) => { sessionReads++; return id === 'session' ? running : id === 'stopped' ? { ...running, id, status: 'completed' } : id === 'foreign' ? { ...running, id, bridgeId: 'other' } : null; } } as unknown as SessionController;
  const enqueueSessionMessage: NonNullable<CommandRpcDeps['enqueueSessionMessage']> = async (session, message) => { enqueues++; calls.push({ session, message }); return { ok: true, id: 'mail-1' }; };
  const attentionStore = new Proxy({}, { get() { throw new Error('Reply must not resolve attention'); } }) as unknown as NonNullable<CommandRpcDeps['attentionStore']>;
  const make = (override: Partial<CommandRpcDeps> = {}) => createCommandHandler({ bridgeId: 'bridge', security, sessionController, enqueueSessionMessage, attentionStore,
    publishCommandResponse: async response => { responses.push(response); }, ...override });
  const command = (payload: unknown): Command => ({ type: 'send_message', requestId: 'request', payload } as Command);
  const payload = { bridgeId: 'bridge', sessionId: 'session', message: 'line one\nline two' };
  await make({ security: undefined })(command(payload), verified); assert.equal(responses.at(-1)?.success, false);
  await make()(command(payload)); assert.equal(responses.at(-1)?.success, false);
  authorized = false; await make()(command(payload), verified); assert.equal((responses.at(-1)?.data as { code?: string } | undefined)?.code, 'permission_denied');
  assert.equal(sessionReads, 0); assert.equal(enqueues, 0); authorized = true;
  for (const invalid of [null, {}, { ...payload, message: '  ' }, { ...payload, message: 'x'.repeat(65_537) }, { ...payload, sessionId: '../x' }, { ...payload, sessionId: 'a'.repeat(201) }, { ...payload, from: 'spoof' }]) {
    await make()(command(invalid), verified); assert.equal((responses.at(-1)?.data as { code?: string } | undefined)?.code, 'invalid_request');
  }
  assert.equal(sessionReads, 0); assert.equal(enqueues, 0);
  for (const sessionId of ['missing', 'stopped', 'foreign']) {
    await make()(command({ ...payload, sessionId }), verified); assert.equal((responses.at(-1)?.data as { code?: string } | undefined)?.code, 'session_unavailable');
  }
  const previous = responses.length; await make()(command({ ...payload, bridgeId: 'other' }), verified);
  assert.equal(responses.length, previous); assert.equal(enqueues, 0);
  await make()(command(payload), verified);
  assert.deepEqual(responses.at(-1), { requestId: 'request', success: true, data: { sessionId: 'session', messageId: 'mail-1', status: 'queued' } });
  assert.deepEqual(calls, [{ session: running, message: payload.message }]);
  await make()(command({ ...payload, message: 'x'.repeat(65_536) }), verified);
  assert.equal(responses.at(-1)?.success, true); assert.equal(calls[1].message.length, 65_536);
});

test('browser session mail reports readiness and uncertain enqueue failures without leaking errors', async () => {
  const responses: CommandResponse[] = []; let calls = 0;
  const session = { id: 'session', bridgeId: 'bridge', status: 'running' } as Session;
  const security = { revalidate: async () => {}, policy: { revalidate: async () => {} } } as unknown as BridgeSecurityService;
  const verified = { principal: {} } as VerifiedApplication;
  const deps = { bridgeId: 'bridge', security, sessionController: { get: async () => session } as unknown as SessionController,
    publishCommandResponse: async (response: CommandResponse) => { responses.push(response); } };
  const command: Command = { type: 'send_message', requestId: 'r', payload: { bridgeId: 'bridge', sessionId: 'session', message: 'reply' } };
  await createCommandHandler(deps)(command, verified); assert.equal((responses.at(-1)?.data as { code?: string } | undefined)?.code, 'mail_not_ready');
  await createCommandHandler({ ...deps, enqueueSessionMessage: async () => ({ ok: false, error: 'Mail store not ready' }) })(command, verified);
  assert.equal((responses.at(-1)?.data as { code?: string } | undefined)?.code, 'mail_not_ready');
  await createCommandHandler({ ...deps, enqueueSessionMessage: async () => { calls++; throw new Error('private error after append'); } })(command, verified);
  assert.equal(calls, 1); assert.equal((responses.at(-1)?.data as { code?: string } | undefined)?.code, 'enqueue_failed');
  assert.match(responses.at(-1)?.error ?? '', /may have been queued/); assert.doesNotMatch(JSON.stringify(responses.at(-1)), /private error/);
  await createCommandHandler({ ...deps, enqueueSessionMessage: async () => ({ ok: true, id: '' }) })(command, verified);
  assert.equal((responses.at(-1)?.data as { code?: string } | undefined)?.code, 'enqueue_failed');
});

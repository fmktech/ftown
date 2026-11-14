import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AttentionStore } from './attention-store.js';
import { PlanItemError } from './create-ftown-session.js';
import { WorktreeError } from './coordination/contract-b.js';
import type { Board, SessionCard, TreeEvent } from './coordination/contract.js';
import type { AttentionItem } from './attention-events.js';

import type { CommandRpcDeps } from './command-rpc.js';
import { createCommandHandler } from './command-rpc.js';
import type { SessionController } from './session-controller.js';
import type { Command, CommandResponse, Session } from './types.js';
import { UpdateAdmission, UpdateResponseTicket } from './update-admission.js';
import { UpdateEffects } from './update-effects.js';
import type { BridgeUpdateCoordinator } from './bridge-update.js';
import { BridgeSecurityError } from './security/bridge/errors.js';
import type { BridgeSecurityService } from './security/bridge/security.js';
import type { VerifiedApplication } from './security/protocol.js';
import type { ModelRoutingService } from './quota/routing-service.js';
import type { ModelRoutingSnapshot, SetModelRoutingResult } from './quota/types.js';

test('human answers store provenance and route fields flow through the attention projection', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'attention-provenance-'));
  await mkdir(join(dir, 'session'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const attentionStore = new AttentionStore(id => join(dir, id));
  const question = { question: 'Pick', options: [{ label: 'A' }, { label: 'B' }], multiSelect: false, allowText: false };
  const responses: CommandResponse[] = [];
  const handler = createCommandHandler({ bridgeId: 'owner', attentionStore,
    sessionController: { get: async (id: string) => id === 'session' ? { id, bridgeId: 'owner' } : null } as unknown as SessionController,
    publishCommandResponse: async response => { responses.push(response); } });
  const ask = () => attentionStore.record('session', 'Notification', { notification_type: 'agent_needs_input', message: 'Q' }, { prompt: { channel: 'mail', questions: [question] } });
  const attentionOf = (requestId: string): AttentionItem | null =>
    (responses.find(response => response.requestId === requestId)?.data as { attention: AttentionItem | null } | undefined)?.attention ?? null;

  const routed = (await ask())!;
  await attentionStore.setRoute('session', routed.id, { route: 'parent', routedTo: 'parent' });
  await handler({ type: 'get_session_attention', requestId: 'routed-read', payload: { bridgeId: 'owner', sessionId: 'session' } });
  const projected = attentionOf('routed-read');
  assert.equal(projected?.route, 'parent'); assert.equal(projected?.routedTo, 'parent');
  assert.equal(projected?.escalatedAt, undefined); assert.equal(projected?.escalationNote, undefined); assert.equal(projected?.answeredBy, undefined);

  // A human may answer a parent-routed item directly (no route check on this path).
  await handler({ type: 'answer_session_attention', requestId: 'human-answer', payload: { bridgeId: 'owner', sessionId: 'session', eventId: routed.id, answers: [{ selected: [1] }] } });
  assert.equal(responses.at(-1)?.success, true);
  const answered = await attentionStore.waitForItem('session', routed.id, 0);
  assert.equal(answered.resolution, 'answered');
  assert.deepEqual(answered.answeredBy, { kind: 'human' });
  assert.equal(answered.route, 'parent'); assert.equal(answered.routedTo, 'parent');

  const escalated = (await ask())!;
  await attentionStore.setRoute('session', escalated.id, { route: 'human', escalatedAt: '2026-01-02T00:00:00.000Z', escalationNote: 'Parent unavailable' });
  await handler({ type: 'get_session_attention', requestId: 'escalated-read', payload: { bridgeId: 'owner', sessionId: 'session' } });
  const projectedEscalated = attentionOf('escalated-read');
  assert.equal(projectedEscalated?.id, escalated.id);
  assert.equal(projectedEscalated?.route, 'human'); assert.equal(projectedEscalated?.escalatedAt, '2026-01-02T00:00:00.000Z');
  assert.equal(projectedEscalated?.escalationNote, 'Parent unavailable'); assert.equal(projectedEscalated?.answeredBy, undefined);
});

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
test('create_session maps WorktreeError to a 400-class code without leaking git details', async () => {
  const responses: CommandResponse[] = [];
  const handler = createCommandHandler({ bridgeId: 'owner', sessionController: {
    create: async () => { throw new WorktreeError('exists', 'worktree path already exists'); },
  } as unknown as SessionController, publishCommandResponse: async response => { responses.push(response); } });
  await handler({ type: 'create_session', requestId: 'wt', payload: { prompt: 'p', name: 'job', worktree: true } } as unknown as Command);
  assert.deepEqual(responses.at(-1), { requestId: 'wt', success: false, error: 'worktree path already exists', data: { code: 'exists' } });
});

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

test('create_session resolves shellType alias agy to canonical antigravity', async () => {
  const responses: CommandResponse[] = []; const inputs: Record<string, unknown>[] = [];
  const handler = createCommandHandler({ bridgeId: 'owner', sessionController: {
    create: async (input: Record<string, unknown>) => { inputs.push(input); return { id: 'created', bridgeId: 'owner', status: 'running', ...input }; },
  } as unknown as SessionController, publishCommandResponse: async (response) => { responses.push(response); } });

  await handler({ type: 'create_session', requestId: 'req-agy', payload: { shellType: 'agy', model: 'gemini-4-hydrogen-medium' } } as unknown as Command);
  assert.equal(responses.at(-1)?.success, true);
  assert.equal(inputs[0].shellType, 'antigravity');
});

test('create_session rejects unknown shellType with client error listing valid values', async () => {
  const responses: CommandResponse[] = []; const inputs: Record<string, unknown>[] = [];
  const handler = createCommandHandler({ bridgeId: 'owner', sessionController: {
    create: async (input: Record<string, unknown>) => { inputs.push(input); return { id: 'created', bridgeId: 'owner', status: 'running', ...input }; },
  } as unknown as SessionController, publishCommandResponse: async (response) => { responses.push(response); } });

  await handler({ type: 'create_session', requestId: 'req-bad', payload: { shellType: 'bogus' } } as unknown as Command);
  assert.equal(responses.at(-1)?.success, false);
  assert.match(responses.at(-1)?.error ?? '', /Invalid shellType "bogus"/);
  assert.match(responses.at(-1)?.error ?? '', /Valid values:/);
  assert.deepEqual(responses.at(-1)?.data, { code: 'invalid_shell_type' });
  assert.equal(inputs.length, 0);
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

test('model routing RPC validates payloads and dispatches to the injected service', async () => {
  const responses: CommandResponse[] = [];
  const gets: unknown[] = []; const sets: unknown[] = [];
  let fail = false;
  const modelRouting = {
    get: async (payload: unknown) => { gets.push(payload); if (fail) throw new Error('quota could not be collected: offline'); return { schema: 1, cached: true } as unknown as ModelRoutingSnapshot; },
    set: async (payload: unknown) => { sets.push(payload); if (fail) throw new Error('quota could not be collected: offline'); return { schema: 1, saved: true, errors: [] } as SetModelRoutingResult; },
  } as ModelRoutingService;
  const handler = createCommandHandler({ bridgeId: 'bridge', modelRouting: () => modelRouting, sessionController: {} as SessionController,
    publishCommandResponse: async response => { responses.push(response); } });
  const send = async (type: string, payload: Record<string, unknown>) => {
    await handler({ type: type as Command['type'], requestId: type, payload }); return responses.at(-1)!;
  };

  assert.deepEqual(await send('get_model_routing', { bridgeId: 'bridge' }), { requestId: 'get_model_routing', success: true, data: { schema: 1, cached: true } });
  await send('get_model_routing', { bridgeId: 'bridge', refresh: true });
  assert.deepEqual(gets, [{}, { refresh: true }]);
  const config = { version: 1, tiers: [], steering: '' };
  assert.deepEqual(await send('set_model_routing', { bridgeId: 'bridge', config }), { requestId: 'set_model_routing', success: true, data: { schema: 1, saved: true, errors: [] } });
  assert.deepEqual(sets, [{ config }]);
  for (const overwriteInvalid of [true, false, 'true', 1, null]) {
    const response = await send('set_model_routing', { bridgeId: 'bridge', config, overwriteInvalid });
    assert.equal(response.success, true, JSON.stringify(overwriteInvalid));
  }
  assert.deepEqual(sets, [{ config }, { config, overwriteInvalid: true }, { config }, { config }, { config }, { config }]);
  sets.length = 1;

  for (const [type, payload] of [
    ['get_model_routing', { bridgeId: 'bridge', refresh: 'yes' }],
    ['get_model_routing', { bridgeId: 'bridge', extra: 1 }],
    ['get_model_routing', {}],
    ['set_model_routing', { bridgeId: 'bridge' }],
    ['set_model_routing', { bridgeId: 'bridge', config, extra: true }],
  ] as const) {
    const response = await send(type, payload);
    assert.equal(response.success, false, JSON.stringify(payload));
    assert.deepEqual(response.data, { code: 'invalid' });
  }
  const huge = await send('set_model_routing', { bridgeId: 'bridge', config: { ...config, steering: 'x'.repeat(256 * 1024) } });
  assert.equal(huge.success, false); assert.equal(huge.error, 'routing config is too large');
  assert.equal(gets.length, 2); assert.equal(sets.length, 1);

  const before = responses.length;
  await handler({ type: 'get_model_routing', requestId: 'foreign', payload: { bridgeId: 'other' } });
  assert.equal(responses.length, before);

  fail = true;
  for (const [type, payload] of [['get_model_routing', { bridgeId: 'bridge' }], ['set_model_routing', { bridgeId: 'bridge', config }]] as const) {
    const response = await send(type, payload);
    assert.equal(response.success, false); assert.equal(response.error, 'quota could not be collected: offline');
  }

  const bare = createCommandHandler({ bridgeId: 'bridge', sessionController: {} as SessionController, publishCommandResponse: async response => { responses.push(response); } });
  await bare({ type: 'get_model_routing', requestId: 'bare', payload: { bridgeId: 'bridge' } });
  assert.equal(responses.at(-1)?.success, false); assert.deepEqual(responses.at(-1)?.data, { code: 'unavailable' });
});

test('model routing RPC revalidates before any service call and writes nothing when that fails', async () => {
  const responses: CommandResponse[] = [];
  const levels: string[] = [];
  let touched = false;
  const modelRouting = { get: async () => { touched = true; throw new Error('get must not run'); }, set: async () => { touched = true; throw new Error('set must not run'); } } as ModelRoutingService;
  const security = { revalidate: async () => {}, policy: { revalidate: async (_principal: unknown, permission: string) => {
    levels.push(permission); throw new BridgeSecurityError('permission_denied');
  } } } as unknown as BridgeSecurityService;
  const verified = { principal: {} } as VerifiedApplication;
  const handler = createCommandHandler({ bridgeId: 'bridge', security, modelRouting: () => { touched = true; return modelRouting; }, sessionController: {} as SessionController,
    publishCommandResponse: async response => { responses.push(response); } });
  const config = { version: 1, tiers: [], steering: '' };
  await handler({ type: 'get_model_routing', requestId: 'get', payload: { bridgeId: 'bridge', refresh: true } }, verified);
  await handler({ type: 'set_model_routing', requestId: 'set', payload: { bridgeId: 'bridge', config, overwriteInvalid: true } }, verified);
  assert.deepEqual(levels, ['read', 'control']);
  assert.equal(touched, false);
  assert.deepEqual(responses.map(response => response.success), [false, false]);
  assert.deepEqual(responses.map(response => (response.data as { code?: string }).code), ['permission_denied', 'permission_denied']);
});

function boardCard(sessionId: string, archived = false): SessionCard {
  return {
    sessionId,
    name: sessionId,
    declared: null,
    derived: { status: 'running', activity: 'idle', openAttention: 1, unreadMail: 0, previews: [] },
    stale: false,
    ...(archived ? { archived: true } : {}),
  };
}

function attentionItem(id: string, route: 'parent' | 'human', resolved = false): AttentionItem {
  return {
    id,
    sequence: 1,
    type: 'agent_needs_input',
    title: id,
    message: id,
    createdAt: '2026-11-13T10:00:00.000Z',
    lastSeenAt: '2026-11-13T10:00:00.000Z',
    occurrences: 1,
    route,
    ...(resolved ? { resolvedAt: '2026-11-13T11:00:00.000Z' } : {}),
  };
}

test('get_session_board returns a read-only snapshot and rejects a bad payload', async () => {
  const responses: CommandResponse[] = [];
  const queries: unknown[] = [];
  const attentionCalls: string[] = [];
  const mutations: string[] = [];
  const events: TreeEvent[] = Array.from({ length: 55 }, (_, index) => ({
    seq: index + 1,
    ts: '2026-11-13T12:00:00.000Z',
    sessionId: index % 2 === 0 ? 'child-a' : 'child-b',
    sessionName: 'Worker',
    kind: 'status',
    summary: `event ${index + 1}`,
  }));
  const board: Board = {
    rootId: 'root',
    cursor: 55,
    plan: { items: [], ready: [] },
    cards: [boardCard('child-a'), boardCard('child-b'), boardCard('old', true)],
    rollup: { working: 0, blocked: 0, waiting_review: 0, done: 0, failed: 0, unset: 2 },
  };
  const sessionController = {
    get: async (id: string) => id === 'root' || id === 'other-bridge'
      ? { id, bridgeId: id === 'other-bridge' ? 'elsewhere' : 'bridge', name: id, command: 'claude', status: 'running', createdAt: '', updatedAt: '' }
      : null,
    create: async () => { mutations.push('create'); throw new Error('must not create'); },
    remove: async () => { mutations.push('remove'); throw new Error('must not remove'); },
    stop: async () => { mutations.push('stop'); throw new Error('must not stop'); },
  } as unknown as SessionController;
  const handler = createCommandHandler({
    bridgeId: 'bridge',
    sessionController,
    sessionBoard: {
      board: async (query) => { queries.push(query); return board; },
      events: {
        head: async () => events.length,
        read: async (_rootId, opts) => {
          const since = opts?.since ?? 0;
          const limit = opts?.limit ?? 100;
          const page = events.filter((event) => event.seq > since).slice(0, limit);
          return { events: page, cursor: page.at(-1)?.seq ?? since };
        },
      },
      openAttention: async (sessionId) => {
        attentionCalls.push(sessionId);
        if (sessionId === 'child-b') throw new Error('ledger missing');
        return [attentionItem('parent-q', 'parent'), attentionItem('human-q', 'human'), attentionItem('done-q', 'parent', true)];
      },
    },
    publishCommandResponse: async (response) => { responses.push(response); },
  });
  const send = async (requestId: string, payload: Record<string, unknown>) => {
    await handler({ type: 'get_session_board' as Command['type'], requestId, payload });
    return responses.at(-1);
  };

  const ok = await send('ok', { bridgeId: 'bridge', sessionId: 'root' });
  assert.equal(ok?.success, true);
  const data = ok?.data as { board: Board; events: TreeEvent[]; attention: Array<{ sessionId: string; event: AttentionItem }> };
  assert.equal(data.board.rootId, 'root');
  assert.deepEqual(queries, [{ sessionId: 'root', all: true }]);
  assert.equal(data.events.length, 50);
  assert.equal(data.events[0].seq, 6);
  assert.equal(data.events.at(-1)?.seq, 55);
  assert.deepEqual(data.events.map((event) => event.seq), data.events.map((event) => event.seq).sort((a, b) => a - b));
  assert.deepEqual(attentionCalls, ['child-a', 'child-b']);
  assert.deepEqual(data.attention.map((item) => ({ sessionId: item.sessionId, id: item.event.id, route: item.event.route })), [
    { sessionId: 'child-a', id: 'parent-q', route: 'parent' },
    { sessionId: 'child-a', id: 'human-q', route: 'human' },
  ]);
  assert.deepEqual(mutations, []);

  for (const payload of [
    { bridgeId: 'bridge', sessionId: 'root', extra: true },
    { bridgeId: 'bridge' },
    { sessionId: 'root' },
    { bridgeId: 'bridge', sessionId: '../root' },
    null,
  ]) {
    const response = await send(`bad-${JSON.stringify(payload)}`, payload as Record<string, unknown>);
    assert.equal(response?.success, false);
    assert.equal(response?.error, 'Invalid board request');
  }
  assert.equal(queries.length, 1);

  const missing = await send('missing', { bridgeId: 'bridge', sessionId: 'nope' });
  assert.equal(missing?.success, false);
  assert.equal(missing?.error, 'Unknown session');
  const foreignSession = await send('foreign-session', { bridgeId: 'bridge', sessionId: 'other-bridge' });
  assert.equal(foreignSession?.success, false);
  assert.equal(foreignSession?.error, 'Unknown session');

  const before = responses.length;
  await handler({ type: 'get_session_board' as Command['type'], requestId: 'foreign', payload: { bridgeId: 'other', sessionId: 'root' } });
  assert.equal(responses.length, before);

  const bare = createCommandHandler({
    bridgeId: 'bridge',
    sessionController,
    publishCommandResponse: async (response) => { responses.push(response); },
  });
  await bare({ type: 'get_session_board' as Command['type'], requestId: 'bare', payload: { bridgeId: 'bridge', sessionId: 'root' } });
  assert.equal(responses.at(-1)?.success, false);
  assert.deepEqual(responses.at(-1)?.data, { code: 'unavailable' });

  let read = false;
  const security = {
    revalidate: async () => {},
    policy: { revalidate: async () => { throw new BridgeSecurityError('permission_denied'); } },
  } as unknown as BridgeSecurityService;
  const denied = createCommandHandler({
    bridgeId: 'bridge',
    security,
    sessionController,
    sessionBoard: {
      board: async () => { read = true; return board; },
      events: { head: async () => 0, read: async () => { read = true; return { events: [], cursor: 0 }; } },
      openAttention: async () => { read = true; return []; },
    },
    publishCommandResponse: async (response) => { responses.push(response); },
  });
  await denied(
    { type: 'get_session_board' as Command['type'], requestId: 'denied', payload: { bridgeId: 'bridge', sessionId: 'root' } },
    { principal: {} } as VerifiedApplication,
  );
  assert.equal(read, false);
  assert.equal(responses.at(-1)?.success, false);
  assert.equal((responses.at(-1)?.data as { code?: string } | undefined)?.code, 'permission_denied');
});

test('create_session forwards planItem and maps PlanItemError to a client error', async () => {
  const responses: CommandResponse[] = [];
  const inputs: Array<{ planItem?: string }> = [];
  const handler = createCommandHandler({
    bridgeId: 'bridge',
    sessionController: {
      create: async (input: { planItem?: string }) => {
        inputs.push(input);
        if (input.planItem === 'p2') throw new PlanItemError('Plan item p2 is started, not todo');
        return { id: 'child', name: 'child', command: 'claude', status: 'running', bridgeId: 'bridge', createdAt: '', updatedAt: '' };
      },
    } as unknown as SessionController,
    publishCommandResponse: async (response) => { responses.push(response); },
  });
  const send = async (requestId: string, payload: Record<string, unknown>) => {
    await handler({ type: 'create_session', requestId, payload });
    return responses.at(-1);
  };

  const created = await send('ok', { command: 'claude', bridgeId: 'bridge', parentSessionId: 'parent', planItem: 'p1' });
  assert.equal(created?.success, true);
  assert.equal(inputs[0]?.planItem, 'p1');

  const rejected = await send('bad', { command: 'claude', bridgeId: 'bridge', parentSessionId: 'parent', planItem: 'p2' });
  assert.equal(rejected?.success, false);
  assert.equal(rejected?.error, 'Plan item p2 is started, not todo');

  await send('drop', { command: 'claude', bridgeId: 'bridge', planItem: 'not-an-id' });
  assert.equal(inputs.at(-1)?.planItem, undefined);
});

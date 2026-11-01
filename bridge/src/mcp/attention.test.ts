import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from './server.js';
import { Fleet, FleetError, configSchema } from './fleet.js';
import type { AttentionItem } from '../attention-events.js';

const item = (id = 'event-1', sequence = 1): AttentionItem => ({ id, sequence, type: 'ask_user', title: 'Question', message: 'Which branch?', createdAt: '2026-10-16T00:00:00Z', lastSeenAt: '2026-10-16T00:00:00Z', occurrences: 1 });
const supported = { session: { id: 's' }, capabilities: { attention: { version: 1 } } };
const page = (events: AttentionItem[] = []) => ({ events, cursor: 'bridge-cursor', hasMore: false, cursorReset: false, activity: { state: 'unknown' }, openCount: events.length, ...(events.length ? { latest: events.at(-1) } : {}) });
async function connect(t: { after: (fn: () => Promise<void>) => void }, request: Fleet['request'], options: Parameters<typeof createMcpServer>[1] = {}) {
  const config = configSchema.parse({ concurrency: 2, machines: [{ id: 'a', transport: 'local' }, { id: 'b', transport: 'local' }] });
  const server = createMcpServer({ config, request }, options);
  const client = new Client({ name: 'attention-test', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a); await client.connect(b);
  t.after(async () => { await client.close(); await server.close(); });
  return client;
}

test('aggregate wait returns a fast match and cancels a blocked target without losing its cursor', async (t) => {
  let blockedAborted = false;
  let verified = 0;
  const client = await connect(t, async (machine, _method, _path, _body, signal) => {
    if (!_path.includes('/attention')) return supported;
    if (machine === 'a') return page([item()]);
    return new Promise((_resolve, reject) => {
      const abort = () => { blockedAborted = true; reject(new FleetError('cancelled', 'cancelled')); };
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
    });
  }, { revalidate: async () => { verified++; } });
  const started = Date.now();
  const result = await client.callTool({ name: 'attention_wait', arguments: { targets: [{ machine: 'a', sessionId: 's' }, { machine: 'b', sessionId: 's' }], timeoutSeconds: 2 } });
  const data = result.structuredContent as { matched: boolean; results: { machine: string; events?: AttentionItem[]; cursor?: string; error?: { code: string } }[] };
  assert.equal(data.matched, true);
  assert.equal(data.results[0].events?.[0].id, 'event-1');
  assert.equal(data.results[1].cursor, undefined);
  assert.equal(data.results[1].error?.code, 'timeout');
  assert.equal(blockedAborted, true);
  assert.ok(Date.now() - started < 1000);
  assert.ok(verified > 0);
});

test('progress requires a supplied token and current authorization; strict wait rejects historical option', async (t) => {
  let allowed = true;
  const client = await connect(t, async (_m, _method, path) => path.includes('/attention') ? page([item()]) : supported, { revalidate: async () => { if (!allowed) throw new FleetError('forbidden', 'Access revoked'); } });
  const notifications: unknown[] = [];
  const args = { targets: [{ machine: 'a', sessionId: 's' }], timeoutSeconds: 1 };
  const first = await client.callTool({ name: 'attention_wait', arguments: args });
  assert.equal(first.isError, undefined);
  await client.callTool({ name: 'attention_wait', arguments: args }, undefined, { onprogress: (progress) => notifications.push(progress) });
  assert.equal(notifications.length, 1);
  allowed = false;
  const denied = await client.callTool({ name: 'attention_wait', arguments: args }, undefined, { onprogress: (progress) => notifications.push(progress) });
  assert.equal(denied.isError, true); assert.equal(notifications.length, 1);
  const invalid = await client.callTool({ name: 'attention_wait', arguments: { ...args, includeResolved: true } });
  assert.equal(invalid.isError, true);
});

test('target cursors reject cross-machine reuse; timeout and failure preserve caller cursor', async (t) => {
  let events = [item()];
  const client = await connect(t, async (machine, _method, path) => { if (!path.includes('/attention')) return supported; if (machine === 'b') throw new FleetError('connection_error', 'offline'); return page(events); });
  const inbox = await client.callTool({ name: 'attention_inbox', arguments: { machine: 'a', sessionId: 's' } });
  const cursor = (inbox.structuredContent as { cursor: string }).cursor;
  const foreign = await client.callTool({ name: 'attention_inbox', arguments: { machine: 'b', sessionId: 's', cursor } });
  assert.equal(foreign.isError, true); assert.equal((foreign.structuredContent as { error: { code: string } }).error.code, 'invalid_cursor');
  events = [];
  const wait = await client.callTool({ name: 'attention_wait', arguments: { targets: [{ machine: 'a', sessionId: 's', cursor }], timeoutSeconds: 1 } });
  const data = wait.structuredContent as { matched: boolean; timedOut: boolean; results: { cursor: string }[] };
  assert.equal(data.matched, false); assert.equal(data.timedOut, true); assert.equal(data.results[0].cursor, cursor);
});

test('overview returns newest unresolved excerpt without changing ascending inbox replay', async (t) => {
  const client = await connect(t, async (_machine, _method, path) => path === '/api/sessions' ? { sessions: [{ id: 's', name: 'Worker', status: 'running' }] } : !path.includes('/attention') ? supported : { ...page([item('old', 1)]), latest: item('new', 2), openCount: 2 });
  const result = await client.callTool({ name: 'fleet_overview', arguments: { machines: ['a'] } });
  const data = result.structuredContent as { sessions: { attention: { latest: AttentionItem; openCount: number } }[] };
  assert.equal(data.sessions[0].attention.latest.id, 'new'); assert.equal(data.sessions[0].attention.openCount, 2);
});

test('legacy attention endpoint is explicit upgrade-required and never a fabricated empty inbox', async (t) => {
  let attentionDispatches = 0;
  const client = await connect(t, async (_m, _method, path) => { if (path.includes('/attention')) { attentionDispatches++; throw new FleetError('bridge_error', 'Old native schema rejected new route'); } return { session: { id: 's' } }; });
  const result = await client.callTool({ name: 'attention_inbox', arguments: { machine: 'a', sessionId: 's' } });
  assert.equal(result.isError, true); assert.equal((result.structuredContent as { error: { code: string } }).error.code, 'bridge_upgrade_required');
  assert.equal(attentionDispatches, 0, 'old native request allowlists never see the unsupported new route');
  const identity = await client.callTool({ name: 'whoami' });
  assert.equal(identity.isError, true); assert.equal((identity.structuredContent as { error: { code: string } }).error.code, 'identity_unavailable');
});


test('attention_request is discoverable, mutating and non-idempotent with exact event response', async (t) => {
  const calls: { machine: string; method: string; path: string; body: unknown }[] = [];
  const exact = { ...item('returned-event', 17), type: 'agent_needs_input' as const, occurrences: 3 };
  let revalidations = 0;
  const client = await connect(t, async (machine, method, path, body) => {
    calls.push({ machine, method, path, body });
    return method === 'GET' ? { capabilities: { attention: { version: 1, request: true } } } : { event: exact };
  }, { revalidate: async (machines) => { assert.deepEqual(machines, ['b']); revalidations++; } });
  const tool = (await client.listTools()).tools.find((tool) => tool.name === 'attention_request');
  assert.equal(tool?.annotations?.readOnlyHint, false);
  assert.equal(tool?.annotations?.idempotentHint, false);
  const result = await client.callTool({ name: 'attention_request', arguments: { machine: 'b', sessionId: 's', title: ' Review ', message: ' Please check API_KEY=secret ' } });
  assert.equal(result.isError, undefined);
  assert.deepEqual(result.structuredContent, { machine: 'b', sessionId: 's', event: exact });
  assert.deepEqual(calls, [
    { machine: 'b', method: 'GET', path: '/api/sessions/s', body: undefined },
    { machine: 'b', method: 'POST', path: '/api/sessions/s/attention', body: { title: 'Review', message: 'Please check API_KEY=[redacted]' } },
  ]);
  assert.equal(revalidations, 3, 'authorization is checked before probe, before mutation and before returning');
});

test('attention_request invalid local arguments never dispatch to any bridge', async (t) => {
  let dispatches = 0;
  const client = await connect(t, async () => { dispatches++; return {}; });
  for (const args of [
    { machine: 'a', message: 'Question' }, { sessionId: 's', message: 'Question' },
    { machine: 'a', sessionId: '../s', message: 'Question' },
    { machine: 'a', sessionId: 's', message: ' ' }, { machine: 'a', sessionId: 's', message: '\x1b[31m' },
    { machine: 'a', sessionId: 's', message: 'x'.repeat(2001) },
    { machine: 'a', sessionId: 's', message: 'Question', title: ' ' },
    { machine: 'a', sessionId: 's', message: 'Question', title: 'x'.repeat(201) },
    { machine: 'a', sessionId: 's', message: 'Question', unexpected: true },
  ]) assert.equal((await client.callTool({ name: 'attention_request', arguments: args })).isError, true);
  assert.equal(dispatches, 0);
});

test('attention_request requires version 1 and explicit request capability; it never guesses on older bridges', async (t) => {
  let capabilities: unknown = {};
  const calls: string[] = [];
  const client = await connect(t, async (_machine, method) => { calls.push(method); return { capabilities }; });
  for (const value of [{}, { attention: { version: 1 } }, { attention: { version: 1, request: false } }, { attention: { version: 2, request: true } }]) {
    capabilities = value;
    const result = await client.callTool({ name: 'attention_request', arguments: { machine: 'a', sessionId: 's', message: 'Question' } });
    assert.equal(result.isError, true);
    assert.equal((result.structuredContent as { error: { code: string } }).error.code, 'bridge_upgrade_required');
  }
  assert.deepEqual(calls, ['GET', 'GET', 'GET', 'GET']);
});

test('read-only surface hides attention_request and denied access prevents any mutation', async (t) => {
  let calls = 0;
  const readOnly = await connect(t, async () => { calls++; return {}; }, { readOnly: true });
  assert.ok(!(await readOnly.listTools()).tools.some((tool) => tool.name === 'attention_request'));
  assert.equal((await readOnly.callTool({ name: 'attention_request', arguments: { machine: 'a', sessionId: 's', message: 'Question' } })).isError, true);
  const denied = await connect(t, async () => { calls++; return {}; }, { revalidate: async () => { throw new FleetError('forbidden', 'Revoked'); } });
  const result = await denied.callTool({ name: 'attention_request', arguments: { machine: 'a', sessionId: 's', message: 'Question' } });
  assert.equal((result.structuredContent as { error: { code: string } }).error.code, 'forbidden');
  assert.equal(calls, 0);
});

test('attention_request revalidates after capability probe and never retries uncertain writes', async (t) => {
  const methods: string[] = [];
  let checks = 0;
  const revoked = await connect(t, async (_m, method) => { methods.push(method); return { capabilities: { attention: { version: 1, request: true } } }; }, { revalidate: async () => { if (++checks === 2) throw new FleetError('forbidden', 'Revoked during probe'); } });
  assert.equal((await revoked.callTool({ name: 'attention_request', arguments: { machine: 'a', sessionId: 's', message: 'Question' } })).isError, true);
  assert.deepEqual(methods, ['GET']);
  methods.length = 0;
  const uncertain = await connect(t, async (_m, method) => {
    methods.push(method);
    if (method === 'GET') return { capabilities: { attention: { version: 1, request: true } } };
    throw new FleetError('timeout', 'Outcome unknown', true);
  });
  const result = await uncertain.callTool({ name: 'attention_request', arguments: { machine: 'a', sessionId: 's', message: 'Question' } });
  assert.equal((result.structuredContent as { error: { outcomeUnknown: boolean } }).error.outcomeUnknown, true);
  assert.deepEqual(methods, ['GET', 'POST']);
});


test('attention_request malformed success is outcome-unknown and revoked final access withholds event', async (t) => {
  let posts = 0;
  const malformed = await connect(t, async (_m, method) => {
    if (method === 'GET') return { capabilities: { attention: { version: 1, request: true } } };
    posts++; return { event: { id: 'incomplete' } };
  });
  const result = await malformed.callTool({ name: 'attention_request', arguments: { machine: 'a', sessionId: 's', message: 'Question' } });
  assert.equal((result.structuredContent as { error: { outcomeUnknown: boolean } }).error.outcomeUnknown, true);
  assert.equal(posts, 1);
  let checks = 0;
  const revoked = await connect(t, async (_m, method) => method === 'GET' ? { capabilities: { attention: { version: 1, request: true } } } : { event: item() }, {
    revalidate: async () => { if (++checks === 3) throw new FleetError('forbidden', 'Revoked after request'); },
  });
  const denied = await revoked.callTool({ name: 'attention_request', arguments: { machine: 'a', sessionId: 's', message: 'Question' } });
  assert.equal(denied.isError, true);
  assert.equal((denied.structuredContent as { error: { code: string } }).error.code, 'forbidden');
  assert.equal((denied.structuredContent as { event?: unknown }).event, undefined);
});

const promptCaps = { session: { id: 's' }, capabilities: { attention: { version: 1, request: true, prompt: true } } };
const noPromptCaps = { session: { id: 's' }, capabilities: { attention: { version: 1, request: true } } };
const questions = [{ question: 'Which branch?', header: 'Branch', options: ['main', { label: 'dev', description: 'Development' }], multiSelect: false, allowText: true }];
const answered = (): Record<string, unknown> => ({
  ...item('event-9', 3), resolvedAt: '2026-10-16T00:01:00Z', resolution: 'answered',
  prompt: { channel: 'mail', questions: [{ question: 'Which branch?', options: [{ label: 'main' }, { label: 'dev', description: 'Development' }], multiSelect: false, allowText: true }] },
  answer: { answers: [{ selected: [1], text: 'thanks' }], answeredAt: '2026-10-16T00:01:00Z' },
});

test('attention_request forwards questions only when the bridge advertises prompt support', async (t) => {
  const bodies: unknown[] = [];
  const client = await connect(t, async (_m, method, _path, body) => {
    if (method === 'GET') return promptCaps;
    bodies.push(body); return { event: answered() };
  });
  const result = await client.callTool({ name: 'attention_request', arguments: { machine: 'a', sessionId: 's', message: 'Pick', questions } });
  assert.equal(result.isError, undefined);
  assert.deepEqual(bodies, [{ message: 'Pick', questions }]);
  const event = (result.structuredContent as { event: { answer: { answers: { selected: number[] }[] }; resolution: string } }).event;
  assert.equal(event.resolution, 'answered');
  assert.deepEqual(event.answer.answers[0].selected, [1]);

  let posts = 0;
  const old = await connect(t, async (_m, method) => { if (method === 'GET') return noPromptCaps; posts++; return { event: item() }; });
  const denied = await old.callTool({ name: 'attention_request', arguments: { machine: 'a', sessionId: 's', message: 'Pick', questions } });
  assert.equal(denied.isError, true);
  assert.equal((denied.structuredContent as { error: { code: string } }).error.code, 'bridge_upgrade_required');
  const plain = await old.callTool({ name: 'attention_request', arguments: { machine: 'a', sessionId: 's', message: 'Plain' } });
  assert.equal(plain.isError, undefined);
  assert.equal(posts, 1);
});

test('attention_request rejects malformed questions before contacting the bridge', async (t) => {
  let calls = 0;
  const client = await connect(t, async () => { calls++; return promptCaps; });
  const bad = [
    [],
    Array.from({ length: 5 }, () => ({ question: 'q' })),
    [{ question: 'q', options: Array.from({ length: 9 }, (_, i) => `o${i}`) }],
    [{ question: 'q', extra: true }],
  ];
  for (const q of bad) {
    const result = await client.callTool({ name: 'attention_request', arguments: { machine: 'a', sessionId: 's', message: 'Pick', questions: q } });
    assert.equal(result.isError, true);
  }
  assert.equal(calls, 0);
});

test('attention_get returns one event, passes waitSeconds, and is gated on prompt support', async (t) => {
  const seen: string[] = [];
  const timeouts: Array<number | undefined> = [];
  const client = await connect(t, async (_m, method, path, _body, _signal, timeout) => {
    seen.push(`${method} ${path}`);
    if (path.includes('/attention/')) timeouts.push(timeout);
    return path.includes('/attention/') ? { event: answered() } : promptCaps;
  });
  const result = await client.callTool({ name: 'attention_get', arguments: { machine: 'a', sessionId: 's', eventId: 'event-9', waitSeconds: 20 } });
  assert.equal(result.isError, undefined);
  const data = result.structuredContent as { machine: string; sessionId: string; event: { id: string; answer: { answers: { text: string }[] } } };
  assert.equal(data.machine, 'a'); assert.equal(data.sessionId, 's');
  assert.equal(data.event.id, 'event-9'); assert.equal(data.event.answer.answers[0].text, 'thanks');
  assert.ok(seen.includes('GET /api/sessions/s/attention/event-9?waitSeconds=20'));
  assert.deepEqual(timeouts, [30_000]);

  seen.length = 0;
  await client.callTool({ name: 'attention_get', arguments: { machine: 'a', sessionId: 's', eventId: 'event-9' } });
  assert.ok(seen.includes('GET /api/sessions/s/attention/event-9'));

  const invalid = await client.callTool({ name: 'attention_get', arguments: { machine: 'a', sessionId: 's', eventId: 'event-9', waitSeconds: 26 } });
  assert.equal(invalid.isError, true);
  const badId = await client.callTool({ name: 'attention_get', arguments: { machine: 'a', sessionId: 's', eventId: '../x' } });
  assert.equal(badId.isError, true);
  const longId = await client.callTool({ name: 'attention_get', arguments: { machine: 'a', sessionId: 's', eventId: 'a'.repeat(101) } });
  assert.equal(longId.isError, true);

  const old = await connect(t, async (_m, _method, path) => path.includes('/attention/') ? { event: answered() } : noPromptCaps);
  const denied = await old.callTool({ name: 'attention_get', arguments: { machine: 'a', sessionId: 's', eventId: 'event-9' } });
  assert.equal(denied.isError, true);
  assert.equal((denied.structuredContent as { error: { code: string } }).error.code, 'bridge_upgrade_required');
});

test('attention_get surfaces an unknown event and a malformed bridge response as errors', async (t) => {
  const missing = await connect(t, async (_m, _method, path) => { if (path.includes('/attention/')) throw new FleetError('attention_not_found', 'not found', false, 404); return promptCaps; });
  const r1 = await missing.callTool({ name: 'attention_get', arguments: { machine: 'a', sessionId: 's', eventId: 'nope' } });
  assert.equal(r1.isError, true);
  const err = (r1.structuredContent as { error: { code: string } }).error;
  assert.equal(err.code, 'attention_not_found');
  const malformed = await connect(t, async (_m, _method, path) => path.includes('/attention/') ? { event: { id: 'x' } } : promptCaps);
  const r2 = await malformed.callTool({ name: 'attention_get', arguments: { machine: 'a', sessionId: 's', eventId: 'x' } });
  assert.equal(r2.isError, true);
});

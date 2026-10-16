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

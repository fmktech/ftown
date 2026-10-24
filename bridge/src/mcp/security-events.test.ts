import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { safeTool, safeFailureCode, validateSecurityEvent, encodeSecurityCursor, decodeSecurityCursor, listSecurityPage, SecurityEventStore, finishSecurityEvent, type SecurityFinalizationState } from './security-events.js';
import type { Pool } from 'pg';
import type { SecurityEvent } from '../security/protocol.js';
const ownerId = '349f8d2e-38e4-4d59-888d-687dcfa19e39';
function event(time = '2026-10-24T12:00:00.000Z'): SecurityEvent {
  return { version: 1, id: randomUUID(), actionId: randomUUID(), parentActionId: null, ownerId, source: 'gateway', bridgeId: 'machine-a', clientId: 'client-a', grantId: 'grant-a', endpointId: null, tool: 'sessions_get', operation: null, sessionId: 'session-a', startedAt: time, finishedAt: time, status: 'succeeded', errorCode: null, mutating: false };
}
test('attacker supplied tool names and error strings become fixed metadata, never copied text', () => {
  assert.equal(safeTool('sessions_get'), 'sessions_get');
  for (const name of ['Bearer secret', 'sk-ant-sensitive', 'arbitrary_credential', '']) assert.equal(safeTool(name), 'unknown_tool');
  assert.equal(safeTool({ secret: true }), 'invalid_tool');
  assert.equal(safeFailureCode('permission_denied'), 'permission_denied');
  assert.equal(safeFailureCode('sensitive arbitrary error'), 'internal_error');
  assert.throws(() => validateSecurityEvent({ ...event(), tool: 'arbitrary_credential' }));
  assert.throws(() => validateSecurityEvent({ ...event(), errorCode: 'sensitive arbitrary error' }));
  assert.throws(() => validateSecurityEvent({ ...event(), arguments: 'sensitive' }));
});
test('audit admission and terminal status cannot contradict timestamps', () => {
  assert.throws(() => validateSecurityEvent({ ...event(), status: 'started' }));
  assert.throws(() => validateSecurityEvent({ ...event(), finishedAt: null }));
  const started = { ...event(), status: 'started', finishedAt: null };
  assert.equal(validateSecurityEvent(started).status, 'started');
});
test('opaque cursors bind account and bridge filter and reject noncanonical/malformed input', () => {
  const first = event(); const last = event('2026-10-23T12:00:00.000Z');
  const cursor = encodeSecurityCursor(ownerId, 'machine-a', last, first);
  const parsed = decodeSecurityCursor(cursor, ownerId, 'machine-a');
  assert.equal(parsed.afterAt, last.startedAt);
  assert.equal(parsed.upperId, first.id);
  for (const args of [
    [cursor, '619f68a6-77c1-49f6-ae2d-c5fa169d284b', 'machine-a'],
    [cursor, ownerId, 'machine-b'], [cursor + '=', ownerId, 'machine-a'],
    ['invalid', ownerId, 'machine-a'],
  ]) assert.throws(() => decodeSecurityCursor(args[0], args[1], args[2]), { code: 'invalid_cursor' });
});
test('pagination preserves an upper boundary and exposes retention reset', async () => {
  const first = event(); const second = event('2026-10-24T11:00:00.000Z');
  const third = event('2026-10-24T10:00:00.000Z');
  const queries: { text: string; values: unknown[] }[] = [];
  const query = async (text: string, values: unknown[]) => {
    queries.push({ text, values });
    return text.startsWith('SELECT MIN') ? [{ oldest: third.startedAt, count: 3 }] : [{ event: first }, { event: second }, { event: third }];
  };
  const page = await listSecurityPage(query, ownerId, { bridgeId: 'machine-a', limit: 2 });
  assert.deepEqual(page.events, [first, second]);
  assert.ok(page.nextCursor);
  const cursor = decodeSecurityCursor(page.nextCursor, ownerId, 'machine-a');
  assert.equal(cursor.afterId, second.id);
  assert.equal(cursor.upperId, first.id);
  await listSecurityPage(query, ownerId, { bridgeId: 'machine-a', limit: 2, cursor: page.nextCursor });
  assert.equal(queries.at(-1)?.values[2], first.startedAt);
  assert.equal(queries.at(-1)?.values[4], second.startedAt);
  const expired = encodeSecurityCursor(ownerId, 'machine-a', event('2020-01-01T00:00:00.000Z'), first);
  const reset = await listSecurityPage(query, ownerId, { bridgeId: 'machine-a', cursor: expired });
  assert.equal(reset.reset, true);
  assert.equal(reset.truncated, true);
  assert.equal(queries.at(-1)?.values[2], null);
});
test('reader fails closed on rows outside authenticated owner/filter and rejects unbounded limits', async () => {
  const query = async (text: string) => text.startsWith('SELECT MIN') ? [{ oldest: null, count: 0 }] : [{ event: { ...event(), ownerId: '619f68a6-77c1-49f6-ae2d-c5fa169d284b' } }];
  await assert.rejects(listSecurityPage(query, ownerId), { code: 'audit_unavailable' });
  await assert.rejects(listSecurityPage(query, ownerId, { limit: 101 }), { code: 'invalid_cursor' });
});
test('missing or failed final audit update never reports a confirmed outcome', async () => {
  for (const rowCount of [0, null]) {
    const pool = { query: async () => ({ rowCount }) } as unknown as Pool;
    await assert.rejects(new SecurityEventStore(pool).finish(event(), { status: 'succeeded', errorCode: null }), { code: 'outcome_unknown' });
  }
  const pool = { query: async () => ({ rowCount: 1 }) } as unknown as Pool;
  await new SecurityEventStore(pool).finish(event(), { status: 'succeeded', errorCode: null });
});
test('concurrent finalization shares a write and transient failure permits one unknown retry', async () => {
  const state: SecurityFinalizationState = { event: event(), finished: false };
  let calls = 0;
  let release: (() => void) | undefined;
  const writes: string[] = [];
  const audit = { finish: async (_event: SecurityEvent, outcome: { status: string }) => {
    calls++; writes.push(outcome.status);
    if (calls === 1) { await new Promise<void>(resolve => { release = resolve; }); throw new Error('temporary storage outage'); }
  } };
  const first = finishSecurityEvent(audit, state, { status: 'succeeded', errorCode: null });
  const close = finishSecurityEvent(audit, state, { status: 'unknown', errorCode: 'outcome_unknown' });
  await Promise.resolve();
  assert.equal(calls, 1); assert.equal(state.finished, false);
  release!();
  await Promise.all([assert.rejects(first), assert.rejects(close)]);
  assert.equal(state.finished, false);
  await finishSecurityEvent(audit, state, { status: 'unknown', errorCode: 'outcome_unknown' });
  assert.equal(state.finished, true);
  await finishSecurityEvent(audit, state, { status: 'succeeded', errorCode: null });
  assert.deepEqual(writes, ['succeeded', 'unknown']);
});

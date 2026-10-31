import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionStore } from './session-store.js';
import { SessionController } from './session-controller.js';
import { PreviewChatStore, validateChatInput } from './preview-chat.js';
import { PREVIEW_CHAT_PAGE_BYTES } from './preview-chat-protocol.js';
import type { Session } from './types.js';
import { createCommandHandler } from './command-rpc.js';
import type { CommandResponse } from './types.js';

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'preview-chat-')); const store = new SessionStore(dir);
  const sample: Session = { id: 'one', name: 'one', command: 'test', status: 'running', shellType: 'codex', bridgeId: 'bridge', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  await store.saveSession(sample); const chat = new PreviewChatStore(id => store.sessionDir(id));
  let calls = 0; let body = ''; let fail = false;
  const makeController = () => new SessionController({ store, runner: { stop: () => true }, previewChat: chat, previewChatBridgeId: 'bridge', previewChatRunning: () => true,
    enqueuePreviewChat: async (_session, text) => { calls++; body = text; if (fail) throw new Error('unknown'); return { ok: true, id: 'mail' }; },
    publishSessionUpdate: async () => {}, removeSession: async id => { const previous = await store.loadSession(id); await store.deleteSession(id); return previous; } });
  return { dir, store, chat, sample, makeController, calls: () => calls, body: () => body, setFail: () => { fail = true; } };
}
test('concurrent duplicate send enqueues once, keeps multiline, and conflicts across roles', async t => {
  const f = await fixture(); t.after(() => rm(f.dir, { recursive: true, force: true }));
  const controller = f.makeController(); const input = { id: randomUUID(), text: 'First\nSecond\tline' };
  const [one, two] = await Promise.all([controller.sendPreviewChat('one', input), controller.sendPreviewChat('one', input)]);
  assert.equal(one.ok, true); assert.deepEqual(two, one); assert.equal(f.calls(), 1);
  assert.ok(f.body().startsWith(input.text)); assert.match(f.body(), /preview-reply/);
  if (one.ok) assert.equal(one.result.turn.delivery, 'queued');
  assert.deepEqual((await controller.replyPreviewChat('one', input)).ok, false);
  const conflict = await controller.sendPreviewChat('one', { ...input, text: 'changed' });
  if (!conflict.ok) assert.equal(conflict.code, 'conflict'); else assert.fail('expected conflict');
  const page = await controller.listPreviewChat('one'); assert.equal(page.ok && page.page.turns.length, 1);
});
test('uncertain enqueue survives restart and is never repeated even after stop', async t => {
  const f = await fixture(); t.after(() => rm(f.dir, { recursive: true, force: true }));
  f.setFail(); const input = { id: randomUUID(), text: 'hello' };
  const first = await f.makeController().sendPreviewChat('one', input);
  assert.equal(first.ok && first.result.turn.delivery, 'unconfirmed');
  await f.store.saveSession({ ...f.sample, status: 'completed' });
  assert.deepEqual(await f.makeController().sendPreviewChat('one', input), first); assert.equal(f.calls(), 1);
  assert.equal((await f.makeController().replyPreviewChat('one', { id: randomUUID(), text: 'answer' })).ok, true);
});
test('a crash after reservation but before enqueue never replays that ID', async t => {
  const f = await fixture(); t.after(() => rm(f.dir, { recursive: true, force: true }));
  const input = { id: randomUUID(), text: 'not yet delivered' };
  await f.chat.reserve('one', input, 'user');
  const result = await f.makeController().sendPreviewChat('one', input);
  assert.equal(result.ok && result.result.turn.delivery, 'unconfirmed'); assert.equal(f.calls(), 0);
});
test('queued-marker failure after accepted mail stays unconfirmed and retry does not enqueue again', async t => {
  const f = await fixture(); t.after(() => rm(f.dir, { recursive: true, force: true }));
  class BrokenMarker extends PreviewChatStore { override async markQueued(): Promise<never> { throw new Error('storage failed'); } }
  const broken = new BrokenMarker(id => f.store.sessionDir(id)); let calls = 0;
  const controller = new SessionController({ store: f.store, runner: { stop: () => true }, previewChat: broken, previewChatBridgeId: 'bridge', previewChatRunning: () => true,
    enqueuePreviewChat: async () => { calls++; return { ok: true, id: 'accepted' }; }, publishSessionUpdate: async () => {}, removeSession: async () => null });
  const input = { id: randomUUID(), text: 'important' }; const first = await controller.sendPreviewChat('one', input);
  assert.equal(first.ok && first.result.turn.delivery, 'unconfirmed');
  assert.deepEqual(await controller.sendPreviewChat('one', input), first); assert.equal(calls, 1);
});
test('invalid controls, UTF-8 bounds, unsupported sessions and cursor isolation', async t => {
  const f = await fixture(); t.after(() => rm(f.dir, { recursive: true, force: true }));
  assert.throws(() => validateChatInput({ id: randomUUID(), text: 'bad\r' }), { code: 'invalid' });
  assert.throws(() => validateChatInput({ id: randomUUID(), text: 'é'.repeat(2049) }), { code: 'too_large' });
  validateChatInput({ id: randomUUID(), text: 'é'.repeat(2048) });
  const c = f.makeController(); await f.store.saveSession({ ...f.sample, shellType: 'shell' });
  const denied = await c.sendPreviewChat('one', { id: randomUUID(), text: 'hello' }); assert.equal(denied.ok, false); if (!denied.ok) assert.equal(denied.code, 'unsupported');
  const page = await c.listPreviewChat('one', 'other:0'); assert.equal(page.ok, false); if (!page.ok) assert.equal(page.code, 'invalid');
  await f.store.saveSession({ ...f.sample, status: 'completed' });
  const stopped = await c.sendPreviewChat('one', { id: randomUUID(), text: 'hello' }); assert.equal(stopped.ok, false); if (!stopped.ok) assert.equal(stopped.code, 'not_running');
  const missing = await c.sendPreviewChat('missing', { id: randomUUID(), text: 'hello' }); assert.equal(missing.ok, false); if (!missing.ok) assert.equal(missing.code, 'not_found');
  assert.equal(f.calls(), 0);
});
test('paged ledger is bounded and corrupted data fails closed', async t => {
  const f = await fixture(); t.after(() => rm(f.dir, { recursive: true, force: true })); const c = f.makeController();
  for (let i = 0; i < 27; i++) assert.equal((await c.replyPreviewChat('one', { id: randomUUID(), text: `turn ${i}` })).ok, true);
  const page = await c.listPreviewChat('one'); assert.ok(page.ok); assert.equal(page.page.turns.length, 25); assert.equal(page.page.hasMore, true);
  assert.ok(Buffer.byteLength(JSON.stringify(page.page)) <= PREVIEW_CHAT_PAGE_BYTES);
  const next = await c.listPreviewChat('one', page.page.cursor); assert.ok(next.ok); assert.equal(next.page.turns.length, 2); assert.equal(next.page.hasMore, false);
  await writeFile(join(f.store.sessionDir('one'), 'preview-chat.json'), '{broken');
  const bad = await c.listPreviewChat('one'); assert.equal(bad.ok, false); if (!bad.ok) assert.equal(bad.code, 'unavailable');
});
test('full conversation retains all IDs and refuses additional turns', async t => {
  const f = await fixture(); t.after(() => rm(f.dir, { recursive: true, force: true }));
  const turns = Array.from({ length: 1000 }, (_, index) => ({ id: randomUUID(), sequence: index + 1, role: 'agent', delivery: 'recorded', text: 'x', createdAt: new Date().toISOString() }));
  await writeFile(join(f.store.sessionDir('one'), 'preview-chat.json'), JSON.stringify({ schema: 1, turns }));
  const existing = await f.makeController().replyPreviewChat('one', { id: turns[0].id, text: 'x' }); assert.equal(existing.ok, true);
  const full = await f.makeController().replyPreviewChat('one', { id: randomUUID(), text: 'next' });
  assert.equal(full.ok, false); if (!full.ok) assert.equal(full.code, 'capacity_exceeded');
});
test('page limits serialized bytes without omitting or duplicating turns', async t => {
  const f = await fixture(); t.after(() => rm(f.dir, { recursive: true, force: true }));
  const turns = Array.from({ length: 25 }, (_, index) => ({ id: randomUUID(), sequence: index + 1, role: 'agent', delivery: 'recorded', text: 'x'.repeat(4096), createdAt: new Date().toISOString() }));
  await writeFile(join(f.store.sessionDir('one'), 'preview-chat.json'), JSON.stringify({ schema: 1, turns }));
  let cursor: string | undefined; const read: string[] = [];
  do { const page = await f.makeController().listPreviewChat('one', cursor); assert.ok(page.ok); assert.ok(Buffer.byteLength(JSON.stringify(page.page)) <= PREVIEW_CHAT_PAGE_BYTES);
    read.push(...page.page.turns.map(turn => turn.id)); cursor = page.page.hasMore ? page.page.cursor : undefined; } while (cursor);
  assert.deepEqual(read, turns.map(turn => turn.id));
});
test('ledger byte quota rejects new entries before mutation', async t => {
  const f = await fixture(); t.after(() => rm(f.dir, { recursive: true, force: true }));
  const turns = Array.from({ length: 988 }, (_, index) => ({ id: randomUUID(), sequence: index + 1, role: 'agent', delivery: 'recorded', text: 'x'.repeat(4096), createdAt: new Date().toISOString() }));
  await writeFile(join(f.store.sessionDir('one'), 'preview-chat.json'), JSON.stringify({ schema: 1, turns }));
  const result = await f.makeController().replyPreviewChat('one', { id: randomUUID(), text: 'y'.repeat(4096) });
  assert.equal(result.ok, false); if (!result.ok) assert.equal(result.code, 'capacity_exceeded');
  const page = await f.makeController().listPreviewChat('one', 'one:987'); assert.ok(page.ok); assert.equal(page.page.turns.length, 1);
});
test('remove serializes with a paused enqueue and cannot recreate session data', async t => {
  const f = await fixture(); t.after(() => rm(f.dir, { recursive: true, force: true }));
  let release!: () => void; let entered!: () => void; const waiting = new Promise<void>(r => { release = r; }); const ready = new Promise<void>(r => { entered = r; });
  const controller = new SessionController({ store: f.store, runner: { stop: () => true }, previewChat: f.chat, previewChatBridgeId: 'bridge', previewChatRunning: () => true,
    enqueuePreviewChat: async () => { entered(); await waiting; return { ok: true, id: 'mail' }; }, publishSessionUpdate: async () => {},
    removeSession: async id => { const s = await f.store.loadSession(id); await f.store.deleteSession(id); return s; } });
  const send = controller.sendPreviewChat('one', { id: randomUUID(), text: 'hello' }); await ready;
  const remove = controller.remove('one'); release(); assert.equal((await send).ok, true); assert.equal((await remove).removed, true);
  assert.equal(await f.store.loadSession('one'), null);
});
test('reads wait for a successful send instead of exposing its transient reservation', async t => {
  const f = await fixture(); t.after(() => rm(f.dir, { recursive: true, force: true }));
  let release!: () => void; let entered!: () => void; const waiting = new Promise<void>(r => { release = r; }); const ready = new Promise<void>(r => { entered = r; });
  const controller = new SessionController({ store: f.store, runner: { stop: () => true }, previewChat: f.chat, previewChatBridgeId: 'bridge', previewChatRunning: () => true,
    enqueuePreviewChat: async () => { entered(); await waiting; return { ok: true, id: 'mail' }; }, publishSessionUpdate: async () => {}, removeSession: async () => null });
  const send = controller.sendPreviewChat('one', { id: randomUUID(), text: 'hello' }); await ready;
  let readDone = false; const page = controller.listPreviewChat('one').then(result => { readDone = true; return result; });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(readDone, false);
  release(); await send; const result = await page; assert.ok(result.ok); assert.equal(result.page.turns[0].delivery, 'queued');
});
test('RPC preserves typed result, validates payload and enforces bridge ownership', async t => {
  const f = await fixture(); t.after(() => rm(f.dir, { recursive: true, force: true }));
  const responses: CommandResponse[] = []; const handler = createCommandHandler({ bridgeId: 'bridge', sessionController: f.makeController(), publishCommandResponse: async response => { responses.push(response); } });
  const id = randomUUID();
  await handler({ type: 'preview_chat_send', requestId: 'one', payload: { bridgeId: 'bridge', sessionId: 'one', id, text: 'hello' } });
  assert.equal(responses.at(-1)?.success, true); assert.equal((responses.at(-1)?.data as { turn: { delivery: string } }).turn.delivery, 'queued');
  await handler({ type: 'preview_chat_list', requestId: 'bad', payload: { bridgeId: 'bridge', sessionId: 'one', extra: true } });
  assert.equal(responses.at(-1)?.success, false); assert.deepEqual(responses.at(-1)?.data, { code: 'invalid' });
  await f.store.saveSession({ ...f.sample, bridgeId: 'different' });
  await handler({ type: 'preview_chat_list', requestId: 'foreign', payload: { bridgeId: 'bridge', sessionId: 'one' } });
  assert.deepEqual(responses.at(-1)?.data, { code: 'not_found' }); assert.equal(f.calls(), 1);
});

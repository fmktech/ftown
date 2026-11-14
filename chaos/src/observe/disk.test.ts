import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readAttention, readInbox, readSessionDisk, readStatus, readTree } from './disk.ts';
import type { Ids } from './disk.ts';

const DATA = new URL('./fixtures/bridge-data', import.meta.url).pathname;
const IDS: Ids = { root: 'root-0001', child1: 'child-0001', child2: 'child-0002', child3: null };

test('status: valid, unparseable, missing id, missing file', async () => {
  assert.equal(await readStatus(DATA, 'root-0001'), 'running');
  assert.equal(await readStatus(DATA, 'child-0001'), 'completed');
  assert.equal(await readStatus(DATA, 'child-0002'), 'unparseable');
  assert.equal(await readStatus(DATA, null), 'missing');
  assert.equal(await readStatus(DATA, 'nope'), 'missing');
});

test('status: JSON with an unknown status value is unparseable', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'obs-'));
  try {
    await mkdir(join(dir, 'sessions', 's'), { recursive: true });
    await writeFile(join(dir, 'sessions', 's', 'session.json'), '{"status":"weird"}');
    assert.equal(await readStatus(dir, 's'), 'unparseable');
    await writeFile(join(dir, 'sessions', 's', 'session.json'), '[]');
    assert.equal(await readStatus(dir, 's'), 'unparseable');
  } finally {
    await rm(dir, { recursive: true });
  }
});

test('inbox: tagged mail only, in file order, checkpoint and untagged skipped', async () => {
  const r = await readInbox(DATA, 'root-0001');
  assert.equal(r.inboxParses, true);
  assert.deepEqual(r.inbox.map((m) => m.tag), ['CHAOS-M-1001', 'CHAOS-M-2', 'CHAOS-M-2001', 'CHAOS-M-1002', 'CHAOS-M-3', 'CHAOS-M-4']);
  assert.deepEqual(r.inbox[0], { tag: 'CHAOS-M-1001', type: 'result', fromRole: 'child1', delivered: true, deliveredVia: 'poll', nudged: false });
  assert.deepEqual(r.inbox[1], { tag: 'CHAOS-M-2', type: 'task', fromRole: 'external', delivered: false, deliveredVia: null, nudged: false });
  assert.deepEqual(r.inbox[2], { tag: 'CHAOS-M-2001', type: 'message', fromRole: 'child2', delivered: false, deliveredVia: null, nudged: true });
  assert.deepEqual(r.inbox[3], { tag: 'CHAOS-M-1002', type: 'fyi', fromRole: 'child1', delivered: true, deliveredVia: 'drain', nudged: false });
  assert.deepEqual(r.inbox[4], { tag: 'CHAOS-M-3', type: 'message', fromRole: 'external', delivered: true, deliveredVia: 'nudge', nudged: true });
  assert.equal(r.untaggedWakingMail, 2, 'untagged escalation + untagged answer mail; untagged fyi and checkpoint are not counted');
  assert.equal(r.inbox[5].fromRole, 'unknown', 'no from= in the body');
  assert.equal(r.inbox[5].deliveredVia, 'cli');
});

test('inbox: a torn last line makes parses false but keeps earlier mail', async () => {
  const r = await readInbox(DATA, 'child-0001');
  assert.equal(r.inboxParses, false);
  assert.equal(r.untaggedWakingMail, 0, 'the torn line is not counted');
  assert.deepEqual(r.inbox.map((m) => m.tag), ['CHAOS-M-1']);
  assert.equal(r.inbox[0].fromRole, 'root');
});

test('inbox: missing file or null id is empty and parses', async () => {
  assert.deepEqual(await readInbox(DATA, 'child-0002'), { inbox: [], inboxParses: true, untaggedWakingMail: 0 });
  assert.deepEqual(await readInbox(DATA, null), { inbox: [], inboxParses: true, untaggedWakingMail: 0 });
});

test('inbox: a checkpoint line alone is not corrupt; a non-object JSON line is', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'obs-'));
  try {
    await mkdir(join(dir, 'sessions', 's'), { recursive: true });
    const file = join(dir, 'sessions', 's', 'inbox.jsonl');
    await writeFile(file, '{"_ftown":"pr-event-checkpoint","version":1}\n\n');
    assert.deepEqual(await readInbox(dir, 's'), { inbox: [], inboxParses: true, untaggedWakingMail: 0 });
    await writeFile(file, '42\n');
    assert.equal((await readInbox(dir, 's')).inboxParses, false);
  } finally {
    await rm(dir, { recursive: true });
  }
});

test('attention: tagged items only, sorted numerically by tag, fields mapped', async () => {
  const r = await readAttention(DATA, 'child-0001');
  assert.equal(r.attentionParses, true);
  assert.deepEqual(r.attention, [
    { askTag: 'CHAOS-Q-1', route: 'parent', resolved: true, resolution: 'replied', escalated: false },
    { askTag: 'CHAOS-Q-3', route: 'human', resolved: false, resolution: null, escalated: true },
    { askTag: 'CHAOS-Q-12', route: 'parent', resolved: false, resolution: null, escalated: false },
  ]);
});

test('attention: untagged permission prompt ignored, route and tag from root ledger', async () => {
  const r = await readAttention(DATA, 'root-0001');
  assert.deepEqual(r.attention, [{ askTag: 'CHAOS-Q-1000', route: 'human', resolved: false, resolution: null, escalated: false }]);
});

test('attention: unparseable ledger, missing file, null id', async () => {
  assert.deepEqual(await readAttention(DATA, 'child-0002'), { attention: [], attentionParses: false });
  assert.deepEqual(await readAttention(DATA, 'nope'), { attention: [], attentionParses: true });
  assert.deepEqual(await readAttention(DATA, null), { attention: [], attentionParses: true });
});

test('attention: the tag is found in the message when the title is generic', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'obs-'));
  try {
    await mkdir(join(dir, 'sessions', 's'), { recursive: true });
    await writeFile(join(dir, 'sessions', 's', 'attention.json'), JSON.stringify({ version: 1, events: [{ title: 'Session is asking a question', message: 'CHAOS-Q-7 from=root' }] }));
    assert.deepEqual((await readAttention(dir, 's')).attention.map((a) => a.askTag), ['CHAOS-Q-7']);
    await writeFile(join(dir, 'sessions', 's', 'attention.json'), '{"version":1}');
    assert.equal((await readAttention(dir, 's')).attentionParses, false, 'no events array');
  } finally {
    await rm(dir, { recursive: true });
  }
});

test('tree: file order, roles resolved, corrupt lines counted, duplicates kept', async () => {
  const r = await readTree(DATA, IDS);
  assert.equal(r.treeEventsCorruptLines, 1);
  assert.deepEqual(r.treeEvents, [
    { seq: 1, kind: 'status', role: 'root' },
    { seq: 2, kind: 'mail', role: 'child1' },
    { seq: 3, kind: 'attention', role: 'child2' },
    { seq: 4, kind: 'exit', role: null },
    { seq: 4, kind: 'idle', role: 'root' },
  ]);
});

test('tree: no root id or no file is empty', async () => {
  assert.deepEqual(await readTree(DATA, { ...IDS, root: null }), { treeEvents: [], treeEventsCorruptLines: 0 });
  assert.deepEqual(await readTree(DATA, { ...IDS, root: 'nope' }), { treeEvents: [], treeEventsCorruptLines: 0 });
});

test('tree: a line with seq 0 or a non-integer seq is corrupt', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'obs-'));
  try {
    await mkdir(join(dir, 'sessions', 'r'), { recursive: true });
    await writeFile(join(dir, 'sessions', 'r', 'tree-events.jsonl'), '{"seq":0,"kind":"mail","sessionId":"r"}\n{"seq":1.5,"kind":"mail","sessionId":"r"}\n{"seq":1,"kind":"mail"}\n[]\n');
    const r = await readTree(dir, { root: 'r', child1: null, child2: null, child3: null });
    assert.equal(r.treeEventsCorruptLines, 4);
    assert.deepEqual(r.treeEvents, []);
  } finally {
    await rm(dir, { recursive: true });
  }
});

test('readSessionDisk combines the parts and is deterministic across calls', async () => {
  const a = await readSessionDisk(DATA, 'child-0001');
  const b = await readSessionDisk(DATA, 'child-0001');
  assert.deepEqual(a, b);
  assert.equal(a.status, 'completed');
  assert.equal(a.inboxParses, false);
  assert.equal(a.attention.length, 3);
});

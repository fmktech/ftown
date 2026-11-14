import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { takeSnapshot } from './snapshot.ts';
import type { ExecFn } from './procs.ts';

const DATA = new URL('./fixtures/bridge-data', import.meta.url).pathname;
const IDS = { root: 'root-0001', child1: 'child-0001', child2: 'child-0002', child3: null };

async function proc(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'snap-proc-'));
  await mkdir(join(root, '50'));
  await writeFile(join(root, '50', 'stat'), '50 (node) S 1');
  await mkdir(join(root, '60'));
  await writeFile(join(root, '60', 'cmdline'), ['node', '/opt/chaos/src/fake-agent/main.ts', '--role', 'child1', '--script', 'x'].join('\0') + '\0');
  return root;
}

test('snapshot combines disk, tmux and proc truth in ROLES order', async () => {
  const procRoot = await proc();
  const asked: string[] = [];
  const exec: ExecFn = async (_f, args) => { asked.push(args.at(-1)!); return { code: args.at(-1) === '=ftown-child-0001' ? 0 : 1 }; };
  try {
    const snap = await takeSnapshot({ dataDir: DATA, ids: IDS, bridgePid: 50, bridgeResponsive: async () => true, tmux: { env: {}, exec }, procRoot });
    assert.equal(snap.bridgeAlive, true);
    assert.equal(snap.bridgeResponsive, true);
    assert.deepEqual(snap.sessions.map((s) => s.role), ['root', 'child1', 'child2', 'child3']);
    assert.deepEqual(snap.sessions.map((s) => s.status), ['running', 'completed', 'unparseable', 'missing']);
    assert.deepEqual(snap.sessions.map((s) => s.tmuxAlive), [false, true, false, false]);
    assert.deepEqual(snap.sessions.map((s) => s.procAlive), [false, true, false, false]);
    assert.equal(snap.sessions[0].inbox.length, 6);
    assert.deepEqual(snap.sessions.map((x) => x.untaggedWakingMail), [2, 0, 0, 0]);
    assert.equal(snap.sessions[1].inboxParses, false);
    assert.equal(snap.sessions[2].attentionParses, false);
    assert.equal(snap.treeEvents.length, 5);
    assert.equal(snap.treeEventsCorruptLines, 1);
    assert.ok(!asked.includes('=ftown-null'), 'no tmux probe for a session that was not created');
  } finally {
    await rm(procRoot, { recursive: true });
  }
});

test('snapshot is stable: two takes of unchanged state are deep-equal', async () => {
  const procRoot = await proc();
  const opts = { dataDir: DATA, ids: IDS, bridgePid: 50, bridgeResponsive: async () => true, tmux: { env: {}, exec: async () => ({ code: 0 }) }, procRoot };
  try {
    assert.deepEqual(await takeSnapshot(opts), await takeSnapshot(opts));
  } finally {
    await rm(procRoot, { recursive: true });
  }
});

test('a dead bridge is not probed and is unresponsive', async () => {
  const procRoot = await proc();
  let probed = 0;
  try {
    const snap = await takeSnapshot({ dataDir: DATA, ids: IDS, bridgePid: 99, bridgeResponsive: async () => { probed++; return true; }, tmux: { env: {}, exec: async () => ({ code: 1 }) }, procRoot });
    assert.equal(snap.bridgeAlive, false);
    assert.equal(snap.bridgeResponsive, false);
    assert.equal(probed, 0);
  } finally {
    await rm(procRoot, { recursive: true });
  }
});

test('an alive but unresponsive or throwing probe gives bridgeResponsive false', async () => {
  const procRoot = await proc();
  const base = { dataDir: DATA, ids: IDS, bridgePid: 50, tmux: { env: {}, exec: async () => ({ code: 1 }) }, procRoot };
  try {
    assert.equal((await takeSnapshot({ ...base, bridgeResponsive: async () => false })).bridgeResponsive, false);
    const thrown = await takeSnapshot({ ...base, bridgeResponsive: async () => { throw new Error('timeout'); } });
    assert.equal(thrown.bridgeAlive, true);
    assert.equal(thrown.bridgeResponsive, false);
  } finally {
    await rm(procRoot, { recursive: true });
  }
});

test('before any session exists the snapshot is empty but well formed', async () => {
  const procRoot = await proc();
  try {
    const snap = await takeSnapshot({ dataDir: DATA, ids: { root: null, child1: null, child2: null, child3: null }, bridgePid: null, bridgeResponsive: async () => true, tmux: { env: {}, exec: async () => ({ code: 0 }) }, procRoot });
    assert.equal(snap.bridgeAlive, false);
    assert.deepEqual(snap.sessions.map((s) => s.status), ['missing', 'missing', 'missing', 'missing']);
    assert.ok(snap.sessions.every((s) => !s.tmuxAlive && s.inboxParses && s.attentionParses && s.inbox.length === 0));
    assert.deepEqual(snap.treeEvents, []);
  } finally {
    await rm(procRoot, { recursive: true });
  }
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bridgeAlive, procAlive, tmuxAlive, tmuxCommand } from './procs.ts';
import type { ExecFn } from './procs.ts';

async function fakeProc(entries: Record<string, { cmdline?: string[]; stat?: string }>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'proc-'));
  for (const [pid, e] of Object.entries(entries)) {
    await mkdir(join(root, pid), { recursive: true });
    if (e.cmdline) await writeFile(join(root, pid, 'cmdline'), e.cmdline.join('\0') + '\0');
    if (e.stat) await writeFile(join(root, pid, 'stat'), e.stat);
  }
  return root;
}
const AGENT = (role: string) => ['node', '/opt/chaos/src/fake-agent/main.ts', '--role', role, '--script', `/run/chaos/scripts/${role}.json`];

test('tmuxCommand runs as the bridge user with the bridge env, sorted', () => {
  const c = tmuxCommand('abc', { user: 'ftown', env: { TMUX_TMPDIR: '/tmp/t', HOME: '/home/ftown' } });
  assert.equal(c.file, 'runuser');
  assert.deepEqual(c.args, ['-u', 'ftown', '--', 'env', 'HOME=/home/ftown', 'TMUX_TMPDIR=/tmp/t', 'tmux', '-L', 'ftown', 'has-session', '-t', '=ftown-abc']);
});

test('tmuxCommand without a user runs tmux directly', () => {
  assert.deepEqual(tmuxCommand('abc', { env: { HOME: '/h' } }), { file: 'tmux', args: ['-L', 'ftown', 'has-session', '-t', '=ftown-abc'] });
});

test('tmuxAlive: exit 0 is alive, 1 is dead, null and throw are dead', async () => {
  const seen: string[][] = [];
  const mk = (code: number | null): ExecFn => async (_f, args) => { seen.push(args); return { code }; };
  const env = { HOME: '/h' };
  assert.equal(await tmuxAlive('x', { env, exec: mk(0) }), true);
  assert.equal(await tmuxAlive('x', { env, exec: mk(1) }), false);
  assert.equal(await tmuxAlive('x', { env, exec: mk(null) }), false);
  assert.equal(await tmuxAlive('x', { env, exec: async () => { throw new Error('boom'); } }), false);
  assert.equal(seen[0].at(-1), '=ftown-x');
});

test('tmuxAlive: without a user the env goes to exec, with a user it is inline', async () => {
  let got: Readonly<Record<string, string>> | null = null;
  const exec: ExecFn = async (_f, _a, env) => { got = env; return { code: 0 }; };
  await tmuxAlive('x', { env: { HOME: '/h' }, exec });
  assert.deepEqual(got, { HOME: '/h' });
  await tmuxAlive('x', { user: 'u', env: { HOME: '/h' }, exec });
  assert.deepEqual(got, {});
});

test('tmuxAlive: the default exec reports a missing binary as dead without throwing', async () => {
  const saved = process.env.PATH;
  process.env.PATH = '/nonexistent';
  try {
    assert.equal(await tmuxAlive('x', { env: { PATH: '/nonexistent' } }), false);
  } finally {
    process.env.PATH = saved;
  }
});

test('procAlive: finds the exact role, ignores other roles and wrappers', async () => {
  const root = await fakeProc({
    '100': { cmdline: AGENT('child1') },
    '101': { cmdline: ['tmux', '-L', 'ftown', 'new-session', 'node /opt/chaos/src/fake-agent/main.ts --role child2 --script x'] },
    '102': { cmdline: ['node', '/other/main.ts', '--role', 'child3'] },
    self: { cmdline: AGENT('root') },
  });
  try {
    assert.equal(await procAlive('child1', { procRoot: root }), true);
    assert.equal(await procAlive('child2', { procRoot: root }), false, 'single-arg tmux wrapper does not count');
    assert.equal(await procAlive('child3', { procRoot: root }), false, 'not the fake agent');
    assert.equal(await procAlive('root', { procRoot: root }), false, 'non-numeric entry ignored');
  } finally {
    await rm(root, { recursive: true });
  }
});

test('procAlive: unreadable or missing proc root, and a pid without cmdline, are false', async () => {
  assert.equal(await procAlive('root', { procRoot: '/nonexistent-proc' }), false);
  const root = await fakeProc({ '5': {}, '6': { cmdline: [] } });
  try {
    assert.equal(await procAlive('root', { procRoot: root }), false);
  } finally {
    await rm(root, { recursive: true });
  }
});

test('bridgeAlive: present, absent, null, invalid, zombie', async () => {
  const root = await fakeProc({
    '10': { stat: '10 (node) S 1 10' },
    '11': { stat: '11 (node (v24)) Z 1 11' },
    '12': { stat: '12 (node) T 1 12' },
    '13': {},
  });
  try {
    assert.equal(await bridgeAlive(10, { procRoot: root }), true);
    assert.equal(await bridgeAlive(11, { procRoot: root }), false, 'zombie');
    assert.equal(await bridgeAlive(12, { procRoot: root }), true, 'stopped is alive');
    assert.equal(await bridgeAlive(13, { procRoot: root }), true, 'dir without stat');
    assert.equal(await bridgeAlive(99, { procRoot: root }), false);
    assert.equal(await bridgeAlive(null, { procRoot: root }), false);
    assert.equal(await bridgeAlive(-1, { procRoot: root }), false);
    assert.equal(await bridgeAlive(1.5, { procRoot: root }), false);
  } finally {
    await rm(root, { recursive: true });
  }
});

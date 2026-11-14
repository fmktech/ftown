import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeClock } from '../core/clock.ts';
import type { Rec, Snapshot } from '../contract.ts';
import { runCheckpoints } from './checkpoints.ts';
import { agentCommand, createArgs, parseAgentLog, parseCli, parseCreatedId } from './main.ts';
import { allProperties } from './props.ts';
import { asFtownArgv, isAgentCmdline } from './target.ts';

test('create command lines follow the factsheet', () => {
  assert.equal(agentCommand('child1'), 'node /opt/chaos/src/fake-agent/main.ts --role child1 --script /run/chaos/scripts/child1.json');
  assert.deepEqual(createArgs('root', null), ['sessions', 'create', '--shell', 'claude', '--command', agentCommand('root'), '--name', 'root', '--workdir', '/work/repo']);
  assert.deepEqual(createArgs('child2', 'R').slice(-2), ['--parent-id', 'R']);
  assert.equal(parseCreatedId('{"session":{"id":"abc","name":"root"}}'), 'abc');
  assert.equal(parseCreatedId('not json'), null);
});

test('as_ftown argv: setpriv, env -i, FTOWN_DATA_DIR=/data', () => {
  const a = asFtownArgv(['ftown', 'sessions', 'list']);
  assert.equal(a.file, 'setpriv');
  assert.ok(a.args.includes('FTOWN_DATA_DIR=/data'));
  assert.deepEqual(a.args.slice(-3), ['ftown', 'sessions', 'list']);
});

test('agent cmdline match is exact-token', () => {
  assert.ok(isAgentCmdline('node\0/opt/chaos/src/fake-agent/main.ts\0--role\0child1\0--script\0x', 'child1'));
  assert.ok(!isAgentCmdline('node\0/opt/chaos/src/fake-agent/main.ts\0--role\0child1', 'child2'));
  assert.ok(!isAgentCmdline('/bin/zsh\0-l\0-c\0node /opt/chaos/src/fake-agent/main.ts --role child1', 'child1'));
});

test('parseCli', () => {
  assert.deepEqual(parseCli(['--seed', '3', '--level', 'high']), { seed: 3, level: 'high' });
  assert.equal(parseCli(['--seed', 'x', '--level', 'high']), null);
  assert.equal(parseCli(['--seed', '3']), null);
});

test('agent log parsing drops a truncated line and forces the role', () => {
  const lines = parseAgentLog('{"t":1,"role":"child1","e":{"ev":"start","pid":9}}\n{"t":2,"ro', 'child1');
  assert.deepEqual(lines, [{ t: 1, role: 'child1', e: { ev: 'start', pid: 9 } }]);
});

test('all eleven properties are declared', () => {
  assert.equal(allProperties.length, 11);
});

test('checkpoints every 30 s until stopped', async () => {
  const clock = fakeClock();
  const recs: Rec[] = [];
  const snap: Snapshot = { bridgeAlive: true, bridgeResponsive: true, sessions: [], treeEvents: [], treeEventsCorruptLines: 0 };
  let stop = false;
  const done = runCheckpoints({ clock, take: async () => snap, log: (r) => recs.push(r) }, () => stop);
  await clock.advance(95_000);
  stop = true;
  await clock.advance(1_000);
  await done;
  assert.deepEqual(recs.map((r) => (r.k === 'checkpoint' ? `${r.name}@${r.t}` : '')), ['cp1@30000', 'cp2@60000', 'cp3@90000']);
});

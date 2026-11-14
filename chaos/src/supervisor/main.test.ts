import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeClock } from '../core/clock.ts';
import { PROFILE, PROPERTY_IDS } from '../contract.ts';
import type { Rec, Snapshot } from '../contract.ts';
import { runCheckpoints } from './checkpoints.ts';
import { agentCommand, createArgs, idsDeadline, parseAgentLog, parseCli, parseCreatedId } from './main.ts';
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
  assert.deepEqual(parseCli(['--seed', '3', '--level', 'high']), { seed: 3, level: 'high', profile: 'short' });
  assert.deepEqual(parseCli(['--seed', '3', '--level', 'high', '--profile', 'soak']), { seed: 3, level: 'high', profile: 'soak' });
  assert.equal(parseCli(['--seed', '3', '--level', 'low', '--profile', 'bogus']), null);
  assert.equal(parseCli(['--seed', 'x', '--level', 'high']), null);
  assert.equal(parseCli(['--seed', '3']), null);
});

test('agent log parsing drops a truncated line and forces the role', () => {
  const { lines } = parseAgentLog('{"t":1,"role":"child1","e":{"ev":"start","pid":9}}\n{"t":2,"ro', 'child1');
  assert.deepEqual(lines, [{ t: 1, role: 'child1', e: { ev: 'start', pid: 0 } }]);
});

test('agent log merge drops stdin_line and keeps other events', () => {
  const text = [
    '{"t":1,"role":"root","e":{"ev":"start","pid":134}}',
    '{"t":2,"role":"root","e":{"ev":"stdin_line","text":"[ftown] You are child session (abc) since 06:55"}}',
    '{"t":3,"role":"root","e":{"ev":"nudge","n":2}}',
  ].join('\n');
  assert.deepEqual(parseAgentLog(text, 'root').lines, [
    { t: 1, role: 'root', e: { ev: 'start', pid: 0 } },
    { t: 3, role: 'root', e: { ev: 'nudge', n: 2 } },
  ]);
});

test('every declared property is in the set', () => {
  assert.deepEqual(allProperties.map((p) => p.id).sort(), [...PROPERTY_IDS].sort());
});

test('checkpoints every checkpointEveryMs until stopped', async () => {
  for (const profile of ['short', 'soak'] as const) {
    const every = PROFILE[profile].checkpointEveryMs;
    const clock = fakeClock();
    const recs: Rec[] = [];
    const snap: Snapshot = { bridgeAlive: true, bridgeResponsive: true, sessions: [], treeEvents: [], treeEventsCorruptLines: 0 };
    let stop = false;
    const done = runCheckpoints({ clock, take: async () => snap, log: (r) => recs.push(r) }, every, () => stop);
    await clock.advance(every * 3 + 5_000);
    stop = true;
    await clock.advance(1_000);
    await done;
    assert.deepEqual(
      recs.map((r) => (r.k === 'checkpoint' ? `${r.name}@${r.t}` : '')),
      [`cp1@${every}`, `cp2@${every * 2}`, `cp3@${every * 3}`],
      profile,
    );
  }
});

test('agent events are rebuilt from contract fields; bad strings become invalid and are counted', () => {
  const text = [
    '{"t":1,"e":{"ev":"mail_sent","tag":"CHAOS-M-2001","to":"root","type":"result","accepted":false,"error":"bridge_unreachable","extra":"abc-123"}}',
    '{"t":2,"e":{"ev":"cli_error","cmd":"status set","error":"connect ECONNREFUSED 127.0.0.1:4001"}}',
    '{"t":3,"e":{"ev":"answer_received","askTag":"CHAOS-Q-2000","answer":"maybe","via":"mail"}}',
    '{"t":4,"e":{"ev":"mail_received","tag":"CHAOS-M-7 junk","type":"task","fromRole":"external"}}',
    '{"t":5,"e":{"ev":"surprise"}}',
    '{"t":6,"e":{"ev":"cli_error","cmd":"mail read","error":"exit 1"}}',
  ].join('\n');
  const { lines, invalid } = parseAgentLog(text, 'child1');
  assert.deepEqual(lines.map((l) => l.e), [
    { ev: 'mail_sent', tag: 'CHAOS-M-2001', to: 'root', type: 'result', accepted: false, error: 'bridge_unreachable' },
    { ev: 'cli_error', cmd: 'status set', error: 'invalid' },
    { ev: 'answer_received', askTag: 'CHAOS-Q-2000', answer: 'invalid', via: 'mail' },
    { ev: 'mail_received', tag: 'invalid', type: 'task', fromRole: 'external' },
    { ev: 'cli_error', cmd: 'mail read', error: 'exit 1' },
  ]);
  assert.equal(invalid, 4);
});

test('ids deadline is root create start + root first sleep', () => {
  assert.equal(idsDeadline(4_000, 15_000), 19_000);
});

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import type { IdentityResetReason } from './identity-reset.js';
import { createRevokedRestart, PAIR_AGAIN_HINT, REVOKED_RESTART_MESSAGE, type RevokedRestartDeps } from './revoked-restart.js';

const DATA_DIR = '/data/ftown';
const SCRIPT = '/opt/ftown/cli/dist/ftown-cli.js';
const ARGV = ['start', '--bridge-id', 'old-id', '--new-identity', '--allow-updates'];
const RESTART_ARGV = ['start', '--allow-updates'];

function harness(overrides: Partial<RevokedRestartDeps> = {}) {
  const steps: string[] = [];
  const logs: string[] = [];
  const exits: number[] = [];
  const execs: Array<{ scriptPath: string; argv: string[] }> = [];
  const resets: Array<{ dataDir: string; reason: IdentityResetReason }> = [];
  const argvSeen: Array<readonly string[]> = [];
  const deps: RevokedRestartDeps = {
    dataDir: DATA_DIR,
    scriptPath: SCRIPT,
    argv: ARGV,
    log: (message) => { steps.push(`log:${message}`); logs.push(message); },
    exit: (code) => { steps.push(`exit:${code}`); exits.push(code); },
    shutdown: async () => { steps.push('shutdown'); },
    beginIdentityReset: (dataDir, reason) => { steps.push('begin'); resets.push({ dataDir, reason }); },
    argvForPairingRestart: (argv) => { argvSeen.push(argv); return RESTART_ARGV; },
    reexec: (scriptPath, argv) => { steps.push('reexec'); execs.push({ scriptPath, argv }); return true; },
    ...overrides,
  };
  return { restart: createRevokedRestart(deps), steps, logs, exits, execs, resets, argvSeen };
}

describe('createRevokedRestart', () => {
  it('logs, marks the reset, shuts down, then re-executes, in that order', async () => {
    const h = harness();
    await h.restart();
    assert.deepEqual(h.steps, [`log:${REVOKED_RESTART_MESSAGE}`, 'begin', 'shutdown', 'reexec']);
    assert.deepEqual(h.resets, [{ dataDir: DATA_DIR, reason: 'revoked' }]);
    assert.deepEqual(h.exits, []);
  });

  it('re-executes the same script with the pairing-restart argv', async () => {
    const h = harness();
    await h.restart();
    assert.deepEqual(h.argvSeen, [ARGV]);
    assert.deepEqual(h.execs, [{ scriptPath: SCRIPT, argv: RESTART_ARGV }]);
  });

  it('uses the real argvForPairingRestart by default', async () => {
    const h = harness({ argvForPairingRestart: undefined });
    await h.restart();
    assert.deepEqual(h.execs, [{ scriptPath: SCRIPT, argv: ['start', '--allow-updates'] }]);
  });

  it('runs at most once, even for concurrent and later calls', async () => {
    const h = harness();
    const first = h.restart();
    const second = h.restart();
    assert.equal(first, second);
    await Promise.all([first, second]);
    await h.restart();
    assert.equal(h.resets.length, 1);
    assert.equal(h.execs.length, 1);
    assert.equal(h.steps.filter(step => step === 'shutdown').length, 1);
    assert.equal(h.logs.filter(message => message === REVOKED_RESTART_MESSAGE).length, 1);
  });

  it('waits for the shutdown to finish before re-executing', async () => {
    let finishShutdown!: () => void;
    const h = harness({ shutdown: () => new Promise<void>(resolve => { finishShutdown = resolve; }) });
    const pending = h.restart();
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(h.execs, []);
    finishShutdown();
    await pending;
    assert.equal(h.execs.length, 1);
  });

  it('still re-executes when the shutdown throws', async () => {
    const h = harness({ shutdown: async () => { h.steps.push('shutdown'); throw new Error('policy flush failed'); } });
    await h.restart();
    assert.deepEqual(h.steps.filter(step => !step.startsWith('log:')), ['begin', 'shutdown', 'reexec']);
    assert.ok(h.logs.some(message => message.includes('policy flush failed')));
    assert.deepEqual(h.execs, [{ scriptPath: SCRIPT, argv: RESTART_ARGV }]);
    assert.deepEqual(h.exits, []);
  });

  it('prints the pairing hint and exits 0 when re-exec is unavailable', async () => {
    const h = harness({ reexec: () => { h.steps.push('reexec'); return false; } });
    await h.restart();
    assert.deepEqual(h.steps, [`log:${REVOKED_RESTART_MESSAGE}`, 'begin', 'shutdown', 'reexec', `log:${PAIR_AGAIN_HINT}`, 'exit:0']);
    assert.equal(PAIR_AGAIN_HINT, 'Run `ftown start` to pair this computer again.');
  });

  it('treats a throwing re-exec like an unavailable one', async () => {
    const h = harness({ reexec: () => { throw new Error('execve failed'); } });
    await h.restart();
    assert.ok(h.logs.some(message => message.includes('execve failed')));
    assert.equal(h.logs.at(-1), PAIR_AGAIN_HINT);
    assert.deepEqual(h.exits, [0]);
  });

  it('never re-executes when the reset marker cannot be written', async () => {
    const h = harness({ beginIdentityReset: () => { throw new Error('disk full'); } });
    await h.restart();
    assert.deepEqual(h.execs, []);
    assert.ok(h.steps.includes('shutdown'));
    assert.ok(h.logs.some(message => message.includes('disk full')));
    assert.deepEqual(h.exits, [1]);
  });

  it('marks the reset, shuts down, prints the hint and exits 1 without re-exec while an update blocks it', async () => {
    const h = harness({ canReexec: () => { h.steps.push('canReexec'); return false; } });
    await h.restart();
    assert.deepEqual(h.steps.filter(step => !step.startsWith('log:[Bridge]')),
      [`log:${REVOKED_RESTART_MESSAGE}`, 'begin', 'shutdown', 'canReexec', `log:${PAIR_AGAIN_HINT}`, 'exit:1']);
    assert.deepEqual(h.resets, [{ dataDir: DATA_DIR, reason: 'revoked' }]);
    assert.deepEqual(h.execs, []);
    assert.deepEqual(h.argvSeen, []);
    assert.deepEqual(h.exits, [1]);
  });

  it('consults canReexec only after the shutdown finished', async () => {
    const h = harness({ canReexec: () => { h.steps.push('canReexec'); return true; } });
    await h.restart();
    assert.deepEqual(h.steps.filter(step => !step.startsWith('log:')), ['begin', 'shutdown', 'canReexec', 'reexec']);
    assert.deepEqual(h.exits, []);
  });

  it('logs the exact C13 message first', async () => {
    const h = harness();
    await h.restart();
    assert.equal(h.logs[0], 'This computer was removed from your ftown account. Creating a new identity; pair it again with the link below.');
  });
});

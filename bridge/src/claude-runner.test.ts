import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { IPty } from 'node-pty';
import { ProcessRunner } from './claude-runner.js';

function fakePty() {
  let dataInstalled = false;
  let exitInstalled = false;
  const process = {
    pid: 123,
    onData: () => { dataInstalled = true; return { dispose() {} }; },
    onExit: () => { exitInstalled = true; return { dispose() {} }; },
    write() {},
  } as unknown as IPty;
  return { process, handlersReady: () => dataInstalled && exitInstalled };
}

describe('ProcessRunner attachment readiness', () => {
  it('signals direct readiness after registration and both handlers, never for spawn failure', () => {
    const fake = fakePty();
    let fail = false;
    const runner = new ProcessRunner({ spawn: () => {
      if (fail) throw new Error('expected fake failure');
      return fake.process;
    } });
    runner.getPreferredRuntime = () => 'direct';
    const ready: string[] = [];
    const errors: string[] = [];
    runner.on('ready', id => {
      assert.equal(runner.isRunning(id), true);
      assert.equal(fake.handlersReady(), true);
      ready.push(id);
    });
    runner.on('error', id => errors.push(id));
    runner.run('direct', 'harmless fake command');
    fail = true;
    runner.run('failed', 'harmless fake command');
    assert.deepEqual(ready, ['direct']);
    assert.deepEqual(errors, ['failed']);
  });

  it('waits for asynchronous tmux creation and also signals actual reattachment', async () => {
    let finishCreation!: () => void;
    let spawns = 0;
    const fakes: ReturnType<typeof fakePty>[] = [];
    const runner = new ProcessRunner({
      createTmuxSession: () => new Promise<void>(resolve => { finishCreation = resolve; }),
      spawn: () => {
        spawns++;
        const fake = fakePty(); fakes.push(fake); return fake.process;
      },
    });
    runner.getPreferredRuntime = () => 'tmux';
    runner.hasTmuxSession = () => true;
    const ready: string[] = [];
    runner.on('ready', id => {
      assert.equal(runner.isRunning(id), true);
      assert.equal(fakes.at(-1)?.handlersReady(), true);
      ready.push(id);
    });
    runner.run('created', 'harmless fake command');
    assert.deepEqual(ready, []);
    assert.equal(spawns, 0);
    finishCreation();
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.deepEqual(ready, ['created']);
    assert.equal(runner.reattach('restored'), true);
    assert.deepEqual(ready, ['created', 'restored']);
    runner.reattach('restored');
    assert.equal(spawns, 2, 'an already-attached receiver is not a new attachment');
  });

  it('does not signal readiness when tmux creation or attachment fails', async () => {
    const runner = new ProcessRunner({
      createTmuxSession: async () => { throw new Error('expected fake creation failure'); },
      spawn: () => { throw new Error('expected fake attachment failure'); },
    });
    runner.getPreferredRuntime = () => 'tmux';
    runner.hasTmuxSession = () => true;
    const ready: string[] = [];
    const errors: string[] = [];
    runner.on('ready', id => ready.push(id));
    runner.on('error', id => errors.push(id));
    runner.run('failed-create', 'harmless fake command');
    await new Promise<void>(resolve => setImmediate(resolve));
    runner.reattach('failed-attach');
    assert.deepEqual(ready, []);
    assert.deepEqual(errors, ['failed-create', 'failed-attach']);
  });
});

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

function controlledPty(pid: number) {
  let exit!: (event: { exitCode: number; signal?: number }) => void;
  let data!: (value: string) => void;
  const writes: string[] = [];
  const kills: (string | undefined)[] = [];
  const process = {
    pid,
    onData: (handler: (value: string) => void) => { data = handler; return { dispose() {} }; },
    onExit: (handler: (event: { exitCode: number; signal?: number }) => void) => { exit = handler; return { dispose() {} }; },
    write: (value: string) => { writes.push(value); },
    resize: () => {},
    kill: (signal?: string) => { kills.push(signal); },
  } as unknown as IPty;
  return { process, writes, kills, exit: (code = 0) => exit({ exitCode: code }), data: (value: string) => data(value) };
}

describe('ProcessRunner session generation ownership', () => {
  for (const runtime of ['direct', 'tmux'] as const) {
    it(`${runtime}: a current stop still force-kills an unresponsive process`, async () => {
      const timers: (() => void)[] = [];
      const original = globalThis.setTimeout;
      globalThis.setTimeout = ((callback: () => void, delay?: number) => {
        if (delay === 5000) { timers.push(callback); return {} as NodeJS.Timeout; }
        return original(callback, delay);
      }) as typeof setTimeout;
      try {
        const current = controlledPty(1);
        const runner = new ProcessRunner({ spawn: () => current.process, createTmuxSession: async () => {} });
        runner.getPreferredRuntime = () => runtime;
        (runner as unknown as { killTmuxSessionLogged: () => void }).killTmuxSessionLogged = () => {};
        const events: string[] = [];
        runner.on('complete', id => events.push(`complete:${id}`));
        runner.on('error', id => events.push(`error:${id}`));
        runner.run('current', 'command');
        if (runtime === 'tmux') await new Promise<void>(resolve => setImmediate(resolve));
        assert.equal(runner.resize('current', 91, 27), true);
        assert.equal(runner.stop('current'), true);
        assert.equal(timers.length, 1);
        timers[0]();
        assert.deepEqual(current.kills, [undefined, 'SIGKILL']);
        assert.equal(runner.isRunning('current'), false);
        current.exit();
        assert.equal(runner.getRuntime('current'), undefined);
        assert.equal((runner as unknown as { lastSizes: Map<string, unknown> }).lastSizes.has('current'), false);
        assert.equal((runner as unknown as { generations: Map<string, unknown> }).generations.has('current'), false);
        assert.deepEqual(events, []);
      } finally { globalThis.setTimeout = original; }
    });

    it(`${runtime}: ignores an old stop timer after a new process owns the same session`, async () => {
      const timers: (() => void)[] = [];
      const original = globalThis.setTimeout;
      globalThis.setTimeout = ((callback: () => void, delay?: number) => {
        if (delay === 5000) { timers.push(callback); return {} as NodeJS.Timeout; }
        return original(callback, delay);
      }) as typeof setTimeout;
      try {
        const old = controlledPty(1), replacement = controlledPty(2);
        const processes = [old.process, replacement.process];
        const runner = new ProcessRunner({ spawn: () => processes.shift()!, createTmuxSession: async () => {} });
        runner.getPreferredRuntime = () => runtime;
        (runner as unknown as { killTmuxSessionLogged: () => void }).killTmuxSessionLogged = () => {};
        runner.run('same', 'first');
        if (runtime === 'tmux') await new Promise<void>(resolve => setImmediate(resolve));
        assert.equal(runner.stop('same'), true);
        old.exit();
        runner.run('same', 'replacement');
        if (runtime === 'tmux') await new Promise<void>(resolve => setImmediate(resolve));
        assert.equal(runner.write('same', 'before'), true);
        assert.equal(timers.length, 1);
        timers[0]();
        assert.equal(runner.write('same', 'after'), true);
        assert.deepEqual(replacement.writes, ['before', 'after']);
        assert.deepEqual(replacement.kills, []);
        assert.deepEqual(old.kills, [undefined]);
      } finally { globalThis.setTimeout = original; }
    });

    it(`${runtime}: an exit after forced stop cannot clean up a replacement`, async () => {
      const timers: (() => void)[] = [];
      const original = globalThis.setTimeout;
      globalThis.setTimeout = ((callback: () => void, delay?: number) => {
        if (delay === 5000) { timers.push(callback); return {} as NodeJS.Timeout; }
        return original(callback, delay);
      }) as typeof setTimeout;
      try {
        const old = controlledPty(1), replacement = controlledPty(2);
        const processes = [old.process, replacement.process];
        const runner = new ProcessRunner({ spawn: () => processes.shift()!, createTmuxSession: async () => {} });
        runner.getPreferredRuntime = () => runtime;
        (runner as unknown as { killTmuxSessionLogged: () => void }).killTmuxSessionLogged = () => {};
        const events: string[] = [];
        runner.on('complete', id => events.push(id));
        runner.on('error', id => events.push(id));
        runner.run('same', 'old');
        if (runtime === 'tmux') await new Promise<void>(resolve => setImmediate(resolve));
        assert.equal(runner.stop('same'), true);
        timers[0]();
        assert.equal(runner.isRunning('same'), false);
        runner.run('same', 'new');
        if (runtime === 'tmux') await new Promise<void>(resolve => setImmediate(resolve));
        assert.equal(runner.resize('same', 80, 24), true);
        old.exit();
        assert.equal(runner.write('same', 'alive'), true);
        assert.equal(runner.getRuntime('same'), runtime);
        assert.deepEqual((runner as unknown as { lastSizes: Map<string, unknown> }).lastSizes.get('same'), { cols: 80, rows: 24 });
        assert.deepEqual(events, []);
      } finally { globalThis.setTimeout = original; }
    });

    it(`${runtime}: ignores late exit and data without consuming a new generation stop`, async () => {
      const old = controlledPty(1), replacement = controlledPty(2);
      const processes = [old.process, replacement.process];
      const runner = new ProcessRunner({ spawn: () => processes.shift()!, createTmuxSession: async () => {} });
      runner.getPreferredRuntime = () => runtime;
      (runner as unknown as { killTmuxSessionLogged: () => void }).killTmuxSessionLogged = () => {};
      const events: string[] = [];
      runner.on('complete', id => events.push(`complete:${id}`));
      runner.on('error', id => events.push(`error:${id}`));
      runner.on('data', (_id, value) => events.push(`data:${value}`));
      runner.run('same', 'first');
      if (runtime === 'tmux') await new Promise<void>(resolve => setImmediate(resolve));
      assert.equal(runner.stop('same'), true);
      runner.run('same', 'replacement');
      if (runtime === 'tmux') await new Promise<void>(resolve => setImmediate(resolve));
      assert.equal(runner.resize('same', 91, 27), true);
      assert.equal(runner.stop('same'), true);
      old.data('stale'); old.exit();
      assert.equal(runner.isRunning('same'), true);
      assert.equal(runner.getRuntime('same'), runtime);
      assert.deepEqual((runner as unknown as { lastSizes: Map<string, unknown> }).lastSizes.get('same'), { cols: 91, rows: 27 });
      assert.deepEqual(events, []);
      replacement.exit();
      assert.equal(runner.isRunning('same'), false);
      assert.deepEqual(events, []);
    });
  }

  it('current direct exit removes its own process and emits completion', () => {
    const current = controlledPty(1);
    const runner = new ProcessRunner({ spawn: () => current.process });
    runner.getPreferredRuntime = () => 'direct';
    const completed: string[] = [];
    runner.on('complete', id => completed.push(id));
    runner.run('current', 'command');
    current.exit();
    assert.equal(runner.isRunning('current'), false);
    assert.deepEqual(completed, ['current']);
  });

  it('tmux detach on shutdown suppresses completion and removes only its own client', () => {
    const current = controlledPty(1);
    const runner = new ProcessRunner({ spawn: () => current.process });
    runner.hasTmuxSession = () => true;
    const events: string[] = [];
    runner.on('complete', id => events.push(id));
    runner.on('error', id => events.push(id));
    assert.equal(runner.reattach('current'), true);
    runner.stopAll();
    current.exit();
    assert.equal(runner.isRunning('current'), false);
    assert.deepEqual(current.kills, [undefined]);
    assert.deepEqual(events, []);
  });

  it('honors stop while tmux creation is pending without attaching or emitting completion', async () => {
    let finish!: () => void;
    let attached = 0, killed = 0;
    const runner = new ProcessRunner({
      createTmuxSession: () => new Promise<void>(resolve => { finish = resolve; }),
      spawn: () => { attached++; return controlledPty(1).process; },
    });
    runner.getPreferredRuntime = () => 'tmux';
    (runner as unknown as { killTmuxSessionLogged: () => void }).killTmuxSessionLogged = () => { killed++; };
    const events: string[] = [];
    runner.on('complete', id => events.push(id));
    runner.on('error', id => events.push(id));
    runner.run('pending', 'command');
    assert.equal(runner.stop('pending'), true);
    finish();
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(attached, 0);
    assert.equal(killed, 2);
    assert.equal(runner.getRuntime('pending'), undefined);
    assert.deepEqual(events, []);
  });

  it('does not let a stale pending tmux creation cancel a newer launch', async () => {
    const finishes: (() => void)[] = [];
    const replacement = controlledPty(2);
    let killed = 0;
    const runner = new ProcessRunner({
      createTmuxSession: () => new Promise<void>(resolve => { finishes.push(resolve); }),
      spawn: () => replacement.process,
    });
    runner.getPreferredRuntime = () => 'tmux';
    (runner as unknown as { killTmuxSessionLogged: () => void }).killTmuxSessionLogged = () => { killed++; };
    runner.run('same', 'old');
    assert.equal(runner.stop('same'), true);
    runner.run('same', 'new');
    finishes[1]();
    await new Promise<void>(resolve => setImmediate(resolve));
    finishes[0]();
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(runner.write('same', 'still live'), true);
    assert.deepEqual(replacement.writes, ['still live']);
    assert.equal(killed, 1, 'stale creation must not kill the new session');
    assert.equal(runner.getRuntime('same'), 'tmux');
  });
});

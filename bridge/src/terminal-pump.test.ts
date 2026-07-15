import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { TerminalPump, type TerminalPumpDeps } from './terminal-pump.js';
import type { ProcessRunner } from './claude-runner.js';
import type { Session, SessionUsage } from './types.js';

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 's1',
    name: 'session',
    command: 'claude',
    status: 'running',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  } as Session;
}

interface Harness {
  pump: TerminalPump;
  appended: Array<{ sessionId: string; data: string }>;
  published: Array<{ sessionId: string; data: string }>;
  hookEvents: Array<{ sessionId: string; event: Record<string, unknown> }>;
  savedStatuses: string[];
  savedErrorReasons: Array<string | undefined>;
  publishedSessions: Session[];
  unregistered: string[];
  destroyed: string[];
  written: string[];
  session: Session;
}

function makeHarness(deps: Partial<TerminalPumpDeps> = {}): Harness {
  const h: Harness = {
    pump: undefined as unknown as TerminalPump,
    appended: [],
    published: [],
    hookEvents: [],
    savedStatuses: [],
    savedErrorReasons: [],
    publishedSessions: [],
    unregistered: [],
    destroyed: [],
    written: [],
    session: makeSession(),
  };
  h.pump = new TerminalPump({
    store: {
      appendTerminalData: async (sessionId, data) => { h.appended.push({ sessionId, data }); },
      loadSession: async () => h.session,
      saveSession: async (session) => {
        h.savedStatuses.push(session.status);
        h.savedErrorReasons.push(session.errorReason);
      },
      // The "flushed log" is everything appended so far for the session.
      loadTerminalLog: async (sessionId) =>
        h.appended.filter((a) => a.sessionId === sessionId).map((a) => a.data).join(''),
    },
    terminalManager: {
      write: (_sid: string, data: string) => { h.written.push(data); },
      destroy: (sid: string) => { h.destroyed.push(sid); },
    },
    publishTerminalData: (sessionId, data) => { h.published.push({ sessionId, data }); },
    publishSessionUpdate: async (session) => { h.publishedSessions.push({ ...session }); },
    publishHookEvent: async (sessionId, event) => { h.hookEvents.push({ sessionId, event }); },
    unregisterSession: (sid) => { h.unregistered.push(sid); },
    ...deps,
  });
  return h;
}

async function settle(): Promise<void> {
  // Let the withSessionWrite promise chain and .finally callbacks run.
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

describe('TerminalPump buffering', () => {
  it('coalesces output below the buffer cap until flushed explicitly', () => {
    const h = makeHarness();
    h.pump.handleData('s1', 'hello ');
    h.pump.handleData('s1', 'world');
    assert.deepEqual(h.published, []);
    h.pump.flush('s1');
    assert.deepEqual(h.published, [{ sessionId: 's1', data: 'hello world' }]);
    assert.deepEqual(h.appended, [{ sessionId: 's1', data: 'hello world' }]);
    assert.deepEqual(h.written, ['hello ', 'world']);
    // Flushing again is a no-op: the buffer is drained.
    h.pump.flush('s1');
    assert.equal(h.published.length, 1);
  });

  it('flushes synchronously once the buffer reaches maxBufferBytes', () => {
    const h = makeHarness({ maxBufferBytes: 8 });
    h.pump.handleData('s1', 'abcd');
    assert.equal(h.published.length, 0);
    h.pump.handleData('s1', 'efgh');
    assert.deepEqual(h.published, [{ sessionId: 's1', data: 'abcdefgh' }]);
  });

  it('keeps per-session buffers independent', () => {
    const h = makeHarness();
    h.pump.handleData('s1', 'one');
    h.pump.handleData('s2', 'two');
    h.pump.flush('s1');
    assert.deepEqual(h.published, [{ sessionId: 's1', data: 'one' }]);
  });
});

describe('TerminalPump lifecycle handlers', () => {
  it('on complete: flushes, publishes a synthetic Stop, persists completed status, unregisters', async () => {
    const h = makeHarness();
    const runner = makeRunnerStub();
    h.pump.attach(runner as unknown as Pick<ProcessRunner, 'on'>);
    h.pump.handleData('s1', 'tail output');

    runner.emit('complete', 's1');
    await settle();

    assert.deepEqual(h.published, [{ sessionId: 's1', data: 'tail output' }]);
    assert.deepEqual(h.hookEvents, [{
      sessionId: 's1',
      event: { type: 'hook_event', eventName: 'Stop', data: { synthetic: true, reason: 'complete' } },
    }]);
    assert.deepEqual(h.savedStatuses, ['completed']);
    assert.equal(h.publishedSessions[0]?.status, 'completed');
    assert.deepEqual(h.unregistered, ['s1']);
    assert.deepEqual(h.destroyed, []);
  });

  it('on error: persists error status, unregisters, and destroys the terminal', async () => {
    const h = makeHarness();
    const runner = makeRunnerStub();
    h.pump.attach(runner as unknown as Pick<ProcessRunner, 'on'>);

    runner.emit('error', 's1', new Error('boom'));
    await settle();

    assert.deepEqual(h.hookEvents.map((e) => (e.event.data as Record<string, unknown>).reason), ['error']);
    assert.deepEqual(h.savedStatuses, ['error']);
    assert.deepEqual(h.unregistered, ['s1']);
    assert.deepEqual(h.destroyed, ['s1']);
  });

  it('on error: persists errorReason with the message and recent terminal tail, ANSI stripped', async () => {
    const h = makeHarness();
    const runner = makeRunnerStub();
    h.pump.attach(runner as unknown as Pick<ProcessRunner, 'on'>);

    // Colored, multi-line startup output still buffered when the crash lands.
    h.pump.handleData('s1', '\u001b[31mkeychain\u001b[0m write\nfailed:   token refresh\u001b[2K\r');

    runner.emit('error', 's1', new Error('Process exited with code 1'));
    await settle();

    assert.deepEqual(h.savedStatuses, ['error']);
    const reason = h.savedErrorReasons[0];
    assert.ok(reason, 'errorReason must be persisted');
    assert.ok(reason.startsWith('Process exited with code 1 — '), reason);
    assert.ok(reason.includes('keychain write failed: token refresh'), reason);
    assert.ok(!/\u001b/.test(reason), 'ANSI escapes must be stripped');
    assert.equal(h.publishedSessions[0]?.errorReason, reason);
  });

  it('on error: caps errorReason at ~400 chars with a ~300-char tail', async () => {
    const h = makeHarness();
    const runner = makeRunnerStub();
    h.pump.attach(runner as unknown as Pick<ProcessRunner, 'on'>);

    h.pump.handleData('s1', 'x'.repeat(2000) + ' TAIL_MARKER_END');
    runner.emit('error', 's1', new Error('boom'));
    await settle();

    const reason = h.savedErrorReasons[0];
    assert.ok(reason);
    assert.ok(reason.length <= 400, `length ${reason.length} exceeds cap`);
    assert.ok(reason.startsWith('boom — '));
    // The tail keeps the END of the output (the most recent chars).
    assert.ok(reason.endsWith('TAIL_MARKER_END'), reason.slice(-40));
    // Tail portion is capped at ~300 chars.
    assert.ok(reason.length - 'boom — '.length <= 300);
  });

  it('on error with no terminal output: errorReason is just the message', async () => {
    const h = makeHarness();
    const runner = makeRunnerStub();
    h.pump.attach(runner as unknown as Pick<ProcessRunner, 'on'>);

    runner.emit('error', 's1', new Error('spawn ENOENT'));
    await settle();

    assert.equal(h.savedErrorReasons[0], 'spawn ENOENT');
  });

  it('withSessionWrite serializes tasks per session', async () => {
    const h = makeHarness();
    const order: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });

    const first = h.pump.withSessionWrite('s1', async () => {
      await firstGate;
      order.push('first');
    });
    const second = h.pump.withSessionWrite('s1', async () => {
      order.push('second');
    });

    releaseFirst();
    await Promise.all([first, second]);
    assert.deepEqual(order, ['first', 'second']);
  });
});

describe('TerminalPump usage collection', () => {
  function makeUsage(overrides: Partial<SessionUsage> = {}): SessionUsage {
    return {
      inputTokens: 10,
      outputTokens: 20,
      cacheReadTokens: 30,
      cacheWriteTokens: 40,
      totalTokens: 100,
      models: ['claude-sonnet-5'],
      costUsd: 0.001,
      harness: 'claude',
      collectedAt: new Date().toISOString(),
      ...overrides,
    };
  }

  async function waitFor(cond: () => boolean): Promise<void> {
    for (let i = 0; i < 100 && !cond(); i++) {
      await new Promise((resolve) => setImmediate(resolve));
    }
  }

  it('on complete: runs the injected collector and persists+publishes non-null usage', async () => {
    const usage = makeUsage();
    const collected: string[] = [];
    const h = makeHarness({
      collectUsage: async (session) => {
        collected.push(session.id);
        return usage;
      },
    });
    const runner = makeRunnerStub();
    h.pump.attach(runner as unknown as Pick<ProcessRunner, 'on'>);

    runner.emit('complete', 's1');
    await waitFor(() => h.session.usage !== undefined);

    assert.deepEqual(collected, ['s1']);
    assert.deepEqual(h.session.usage, usage);
    const last = h.publishedSessions[h.publishedSessions.length - 1];
    assert.deepEqual(last?.usage, usage);
    // status persist first, usage persist second
    assert.deepEqual(h.savedStatuses, ['completed', 'completed']);
  });

  it('on error: also collects usage', async () => {
    const usage = makeUsage({ harness: 'codex' });
    const h = makeHarness({ collectUsage: async () => usage });
    const runner = makeRunnerStub();
    h.pump.attach(runner as unknown as Pick<ProcessRunner, 'on'>);

    runner.emit('error', 's1', new Error('boom'));
    await waitFor(() => h.session.usage !== undefined);

    assert.deepEqual(h.session.usage, usage);
  });

  it('a null collector result never clobbers existing usage or triggers an extra save', async () => {
    const existing = makeUsage({ totalTokens: 999 });
    const h = makeHarness({ collectUsage: async () => null });
    h.session.usage = existing;
    const runner = makeRunnerStub();
    h.pump.attach(runner as unknown as Pick<ProcessRunner, 'on'>);

    runner.emit('complete', 's1');
    await settle();
    await settle();

    assert.deepEqual(h.session.usage, existing);
    // Only the status persist — no second save from the usage path.
    assert.deepEqual(h.savedStatuses, ['completed']);
  });

  it('without a collector dep, completion behaves exactly as before', async () => {
    const h = makeHarness();
    const runner = makeRunnerStub();
    h.pump.attach(runner as unknown as Pick<ProcessRunner, 'on'>);

    runner.emit('complete', 's1');
    await settle();

    assert.equal(h.session.usage, undefined);
    assert.deepEqual(h.savedStatuses, ['completed']);
  });
});

type RunnerListener = (...args: [string] | [string, string] | [string, Error]) => void;

function makeRunnerStub(): { on: (event: string, listener: RunnerListener) => unknown; emit: (event: string, ...args: unknown[]) => void } {
  const listeners = new Map<string, RunnerListener[]>();
  const stub = {
    on(event: string, listener: RunnerListener) {
      const list = listeners.get(event) ?? [];
      list.push(listener);
      listeners.set(event, list);
      return stub;
    },
    emit(event: string, ...args: unknown[]) {
      for (const listener of listeners.get(event) ?? []) {
        (listener as (...a: unknown[]) => void)(...args);
      }
    },
  };
  return stub;
}

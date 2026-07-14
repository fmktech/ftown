import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { TerminalPump, type TerminalPumpDeps } from './terminal-pump.js';
import type { ProcessRunner } from './claude-runner.js';
import type { Session } from './types.js';

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
      saveSession: async (session) => { h.savedStatuses.push(session.status); },
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

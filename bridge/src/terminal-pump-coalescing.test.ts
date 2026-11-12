import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SessionStore } from './session-store.js';
import { TerminalPump, type TerminalPumpDeps } from './terminal-pump.js';
import type { ProcessRunner } from './claude-runner.js';
import type { Session } from './types.js';

interface Harness {
  pump: TerminalPump;
  watched: Set<string>;
  /** Everything delivered, in delivery order: flushed chunks and snapshots. */
  wire: string[];
  appended: Array<{ sessionId: string; data: string }>;
  published: Array<{ sessionId: string; data: string }>;
  /** What the live emulator has been fed (never waits for a flush). */
  screen: string;
  tick(ms: number): void;
}

function makeHarness(t: TestContext, deps: Partial<TerminalPumpDeps> = {}): Harness {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const session: Session = { id: 's1', name: 'session', command: 'zsh', status: 'running',
    bridgeId: 'bridge-1', createdAt: '', updatedAt: '' };
  const h: Harness = {
    pump: undefined as unknown as TerminalPump,
    watched: new Set(),
    wire: [],
    appended: [],
    published: [],
    screen: '',
    tick: (ms) => t.mock.timers.tick(ms),
  };
  h.pump = new TerminalPump({
    store: {
      appendTerminalData: async (sessionId, data) => { h.appended.push({ sessionId, data }); },
      loadSession: async () => ({ ...session }),
      saveSession: async () => undefined,
      loadTerminalLog: async () => h.appended.map((a) => a.data).join(''),
    },
    terminalManager: {
      write: (_sid: string, data: string) => { h.screen += data; },
      destroy: () => undefined,
    },
    publishTerminalData: (sessionId, data) => {
      h.published.push({ sessionId, data });
      h.wire.push(`data:${data}`);
    },
    publishSessionUpdate: async () => undefined,
    publishHookEvent: async () => undefined,
    unregisterSession: () => undefined,
    isWatched: (sessionId) => h.watched.has(sessionId),
    ...deps,
  });
  return h;
}

/** A watcher attaching: a snapshot of the emulator at an exact cut in the stream. */
function attachWatcher(h: Harness, sessionId: string): void {
  h.watched.add(sessionId);
  h.pump.snapshot(sessionId, () => h.wire.push(`snapshot:${h.screen}`));
}

/** An emulator that reports "parsed" only when the test says so, like xterm's async write. */
function manualEmulator(h: () => Harness): { deps: Partial<TerminalPumpDeps>; parsed: string; settle(): void; waiting: number } {
  const waiters: Array<() => void> = [];
  const emulator = {
    parsed: '',
    get waiting() { return waiters.length; },
    settle(): void { waiters.shift()?.(); },
    deps: {
      terminalManager: {
        write: (_sid: string, data: string) => { h().screen += data; },
        destroy: () => undefined,
        whenParsed: (_sid: string, done: () => void) => {
          // The cut: exactly what was written before this call.
          const cut = h().screen;
          waiters.push(() => { emulator.parsed = cut; done(); });
        },
      },
    } satisfies Partial<TerminalPumpDeps>,
  };
  return emulator;
}

test('a snapshot waits for the emulator and holds later output back until it is produced', (t) => {
  let h!: Harness;
  const emulator = manualEmulator(() => h);
  h = makeHarness(t, emulator.deps);
  h.watched.add('s1');
  h.pump.handleData('s1', 'OLD ');
  h.pump.handleData('s1', 'SAMETICK');
  h.pump.snapshot('s1', () => h.wire.push(`snapshot:${emulator.parsed}`));
  assert.deepStrictEqual(h.wire, ['data:OLD SAMETICK'], 'bytes before the cut go out, the snapshot waits');

  h.pump.handleData('s1', ' LATER');
  h.tick(16);
  h.pump.handleData('s1', ' MORE');
  h.pump.flush('s1');
  assert.deepStrictEqual(h.wire, ['data:OLD SAMETICK'], 'nothing overtakes the snapshot');
  assert.deepStrictEqual(h.appended.map((a) => a.data), ['OLD SAMETICK', ' LATER', ' MORE'], 'the store is not held');

  emulator.settle();
  assert.deepStrictEqual(h.wire, ['data:OLD SAMETICK', 'snapshot:OLD SAMETICK', 'data: LATER', 'data: MORE']);

  h.pump.handleData('s1', ' AFTER');
  h.tick(16);
  assert.equal(h.wire.at(-1), 'data: AFTER');
});

test('concurrent snapshots of a session share one cut', (t) => {
  let h!: Harness;
  const emulator = manualEmulator(() => h);
  h = makeHarness(t, emulator.deps);
  h.pump.handleData('s1', 'A');
  h.pump.snapshot('s1', () => h.wire.push(`first:${emulator.parsed}`));
  h.pump.handleData('s1', 'B');
  h.pump.snapshot('s1', () => h.wire.push(`second:${emulator.parsed}`));
  assert.equal(emulator.waiting, 1);
  emulator.settle();
  h.tick(250);
  assert.deepStrictEqual(h.wire, ['data:A', 'first:A', 'second:A', 'data:B']);
});

test('a snapshot that never hears back from the emulator releases its output after the timeout', (t) => {
  let h!: Harness;
  const emulator = manualEmulator(() => h);
  h = makeHarness(t, { ...emulator.deps, snapshotTimeoutMs: 400 });
  h.watched.add('s1');
  h.pump.snapshot('s1', () => h.wire.push('snapshot'));
  h.pump.handleData('s1', 'held');
  h.tick(399);
  assert.deepStrictEqual(h.wire, []);
  h.tick(1);
  assert.deepStrictEqual(h.wire, ['snapshot', 'data:held']);
  emulator.settle();
  assert.deepStrictEqual(h.wire, ['snapshot', 'data:held'], 'a late report produces nothing twice');
});

test('a snapshot producer that throws still releases the held output', (t) => {
  let h!: Harness;
  const emulator = manualEmulator(() => h);
  h = makeHarness(t, emulator.deps);
  t.mock.method(console, 'error', () => undefined);
  h.watched.add('s1');
  h.pump.snapshot('s1', () => { throw new Error('serialize failed'); });
  h.pump.handleData('s1', 'held');
  h.pump.flush('s1');
  emulator.settle();
  assert.deepStrictEqual(h.wire, ['data:held']);
});

test('an unwatched session coalesces output for 250 ms', (t) => {
  const h = makeHarness(t);
  h.pump.handleData('s1', 'a');
  h.tick(16);
  assert.deepStrictEqual(h.published, [], 'the watched 16 ms cadence does not apply');
  h.pump.handleData('s1', 'b');
  h.tick(233);
  assert.deepStrictEqual(h.published, []);
  h.pump.handleData('s1', 'c');
  h.tick(1);
  assert.deepStrictEqual(h.published, [{ sessionId: 's1', data: 'abc' }]);
  assert.deepStrictEqual(h.appended, [{ sessionId: 's1', data: 'abc' }]);
  assert.equal(h.screen, 'abc');

  // The window restarts with the next chunk, not on a fixed schedule.
  h.tick(1000);
  h.pump.handleData('s1', 'd');
  h.tick(249);
  assert.equal(h.published.length, 1);
  h.tick(1);
  assert.deepStrictEqual(h.published[1], { sessionId: 's1', data: 'd' });
});

test('the emulator is fed immediately even while output is coalescing', (t) => {
  const h = makeHarness(t);
  h.pump.handleData('s1', 'visible now');
  assert.equal(h.screen, 'visible now');
  assert.deepStrictEqual(h.published, []);
});

test('an unwatched buffer larger than 256 KiB is flushed at once', (t) => {
  const h = makeHarness(t);
  h.pump.handleData('s1', 'x'.repeat(256 * 1024));
  assert.deepStrictEqual(h.published, [], 'exactly 256 KiB still waits');
  h.pump.handleData('s1', 'y');
  assert.equal(h.published.length, 1);
  assert.equal(h.published[0].data, 'x'.repeat(256 * 1024) + 'y');
  // The window's timer went with the flush: nothing fires later.
  h.tick(250);
  assert.equal(h.published.length, 1);
});

test('the unwatched size limit counts bytes', (t) => {
  const h = makeHarness(t);
  h.pump.handleData('s1', '€'.repeat(87_381)); // 262,143 bytes
  assert.deepStrictEqual(h.published, []);
  h.pump.handleData('s1', '€'); // 262,146 bytes
  assert.equal(h.published.length, 1);
});

test('a watched session keeps the 16 ms cadence and the 32,000-char cap', (t) => {
  const h = makeHarness(t);
  h.watched.add('s1');
  h.pump.handleData('s1', 'a');
  h.tick(15);
  assert.deepStrictEqual(h.published, []);
  h.tick(1);
  assert.deepStrictEqual(h.published, [{ sessionId: 's1', data: 'a' }]);
  h.pump.handleData('s1', 'x'.repeat(32_000));
  assert.equal(h.published.length, 2);
});

test('without an isWatched dependency every session is treated as watched', (t) => {
  const h = makeHarness(t, { isWatched: undefined });
  h.pump.handleData('s1', 'a');
  h.tick(16);
  assert.deepStrictEqual(h.published, [{ sessionId: 's1', data: 'a' }]);
});

test('the first watcher gets pending output before its snapshot, then the fast cadence', (t) => {
  const h = makeHarness(t);
  h.pump.handleData('s1', 'one ');
  h.pump.handleData('s1', 'two ');
  h.tick(100);
  attachWatcher(h, 's1');
  assert.deepStrictEqual(h.wire, ['data:one two ', 'snapshot:one two ']);

  // The 250 ms timer of the old window must not deliver anything again.
  h.tick(250);
  assert.deepStrictEqual(h.wire, ['data:one two ', 'snapshot:one two ']);

  h.pump.handleData('s1', 'three');
  h.tick(16);
  assert.deepStrictEqual(h.wire, ['data:one two ', 'snapshot:one two ', 'data:three']);
  assert.equal(h.appended.map((a) => a.data).join(''), 'one two three');
});

test('a watcher that appears without an explicit flush is served by the next chunk', (t) => {
  const h = makeHarness(t);
  h.pump.handleData('s1', 'old ');
  h.tick(50);
  h.watched.add('s1');
  h.pump.handleData('s1', 'new');
  assert.deepStrictEqual(h.published, [{ sessionId: 's1', data: 'old new' }]);
});

test('when the last watcher leaves the session returns to the 250 ms window', (t) => {
  const h = makeHarness(t);
  h.watched.add('s1');
  h.pump.handleData('s1', 'a');
  h.tick(16);
  assert.equal(h.published.length, 1);

  h.watched.delete('s1');
  h.pump.handleData('s1', 'b');
  h.tick(16);
  assert.equal(h.published.length, 1);
  h.tick(233);
  assert.equal(h.published.length, 1);
  h.tick(1);
  assert.deepStrictEqual(h.published[1], { sessionId: 's1', data: 'b' });
});

test('output buffered while watched still flushes within 16 ms after the watcher leaves', (t) => {
  const h = makeHarness(t);
  h.watched.add('s1');
  h.pump.handleData('s1', 'a');
  h.watched.delete('s1');
  h.pump.handleData('s1', 'b');
  h.tick(16);
  assert.deepStrictEqual(h.published, [{ sessionId: 's1', data: 'ab' }]);
});

test('sessions coalesce independently', (t) => {
  const h = makeHarness(t);
  h.watched.add('s2');
  h.pump.handleData('s1', 'slow');
  h.pump.handleData('s2', 'fast');
  h.tick(16);
  assert.deepStrictEqual(h.published, [{ sessionId: 's2', data: 'fast' }]);
  h.tick(234);
  assert.deepStrictEqual(h.published[1], { sessionId: 's1', data: 'slow' });
});

test('session exit and error flush an unwatched buffer without waiting', (t) => {
  const h = makeHarness(t);
  const runner = new EventEmitter();
  h.pump.attach(runner as unknown as Pick<ProcessRunner, 'on'>);
  h.pump.handleData('s1', 'last words');
  runner.emit('complete', 's1');
  assert.deepStrictEqual(h.appended, [{ sessionId: 's1', data: 'last words' }]);

  h.pump.handleData('s2', 'stack trace');
  runner.emit('error', 's2', new Error('boom'));
  assert.deepStrictEqual(h.appended[1], { sessionId: 's2', data: 'stack trace' });
});

test('drain flushes every session and waits for the store before resolving', async (t) => {
  const releases: Array<() => void> = [];
  const stored: string[] = [];
  const h = makeHarness(t, {
    store: {
      appendTerminalData: (sessionId, data) => new Promise<void>((resolve) => {
        releases.push(() => { stored.push(`${sessionId}:${data}`); resolve(); });
      }),
      loadSession: async () => null,
      saveSession: async () => undefined,
      loadTerminalLog: async () => '',
    },
  });
  h.pump.handleData('s1', 'one');
  h.pump.handleData('s2', 'two');
  h.watched.add('s3');
  h.pump.handleData('s3', 'three');

  let drained = false;
  const draining = h.pump.drain().then(() => { drained = true; });
  assert.equal(releases.length, 3, 'every pending buffer was handed to the store');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(drained, false, 'not resolved while appends are in flight');
  for (const release of releases) release();
  await draining;
  assert.deepStrictEqual(stored, ['s1:one', 's2:two', 's3:three']);
  h.tick(1000);
  assert.equal(releases.length, 3, 'no timer flushes anything a second time');
});

test('drain also waits for appends started by an earlier flush', async (t) => {
  let release: () => void = () => undefined;
  const h = makeHarness(t, {
    store: {
      appendTerminalData: () => new Promise<void>((resolve) => { release = resolve; }),
      loadSession: async () => null,
      saveSession: async () => undefined,
      loadTerminalLog: async () => '',
    },
  });
  h.pump.handleData('s1', 'one');
  h.pump.flush('s1');
  let drained = false;
  const draining = h.pump.drain().then(() => { drained = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(drained, false);
  release();
  await draining;
});

test('a failed append does not block drain', async (t) => {
  const h = makeHarness(t, {
    store: {
      appendTerminalData: async () => { throw new Error('disk full'); },
      loadSession: async () => null,
      saveSession: async () => undefined,
      loadTerminalLog: async () => '',
    },
  });
  t.mock.method(console, 'error', () => undefined);
  h.pump.handleData('s1', 'one');
  await h.pump.drain();
  assert.equal(h.pump.isIdle(), true);
});

test('terminal.log readers see output that is still inside the coalescing window', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'ftown-pump-log-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new SessionStore(dir);
  const h = makeHarness(t, { store });
  store.setPendingTerminalFlush((sessionId) => h.pump.flush(sessionId));

  h.pump.handleData('s1', 'first ');
  h.tick(250);
  h.pump.handleData('s1', 'second ');
  h.pump.handleData('s1', 'third');
  assert.equal(await store.loadTerminalLog('s1'), 'first second third');
  assert.equal(await readFile(join(dir, 'sessions', 's1', 'terminal.log'), 'utf-8'), 'first second third');
  assert.deepStrictEqual(h.published.map((p) => p.data), ['first ', 'second third']);

  h.pump.handleData('s1', 'gone');
  await store.clearTerminalLog('s1');
  h.tick(250);
  await h.pump.drain();
  assert.equal(await store.loadTerminalLog('s1'), '');
});

test('coalesced output reaches terminal.log byte-for-byte in order', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'ftown-pump-order-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new SessionStore(dir);
  const h = makeHarness(t, { store });
  let expected = '';
  for (let i = 0; i < 400; i++) {
    const chunk = `chunk ${i} \x1b[3${i % 8}m€\r\n`;
    expected += chunk;
    h.pump.handleData('s1', chunk);
    if (i === 150) attachWatcher(h, 's1');
    if (i === 300) h.watched.delete('s1');
    h.tick(7);
  }
  await h.pump.drain();
  assert.equal(await readFile(join(dir, 'sessions', 's1', 'terminal.log'), 'utf-8'), expected);
  assert.equal(h.published.map((p) => p.data).join(''), expected);
  assert.equal(h.screen, expected);
  assert.ok(h.published.length < 200, `${h.published.length} flushes for 400 chunks`);
});

import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SessionStore } from './session-store.js';
import { TerminalManager } from './terminal-manager.js';
import { createTerminalOutput, type TerminalOutput, type TerminalOutputDeps } from './terminal-output.js';

type Frame = ['data' | 'screen', string];

interface Harness {
  output: TerminalOutput;
  runner: EventEmitter & { stopAll(): void };
  /** Frames published to the session's channel (remote watchers, attached peers). */
  channel: Frame[];
  /** Frames a direct peer receives: nothing until its attach screen is delivered. */
  peer: Frame[];
  attachedPeers: Set<string>;
  remoteWatchers: Set<string>;
  stopAllCalls: number;
  appended: string[];
  emit(data: string, sessionId?: string): void;
  attachPeer(sessionId?: string): void;
}

function makeHarness(overrides: Partial<Pick<TerminalOutputDeps, 'store' | 'terminalManager'>> = {}): Harness {
  const runner = Object.assign(new EventEmitter(), { stopAll: () => { h.stopAllCalls++; } });
  const h: Harness = {
    output: undefined as unknown as TerminalOutput,
    runner,
    channel: [],
    peer: [],
    attachedPeers: new Set(),
    remoteWatchers: new Set(),
    stopAllCalls: 0,
    appended: [],
    emit: (data, sessionId = 's1') => { runner.emit('data', sessionId, data); },
    attachPeer: (sessionId = 's1') => {
      h.output.attachScreen(sessionId, (screen) => {
        h.attachedPeers.add(sessionId);
        h.peer.push(['screen', screen]);
      });
    },
  };
  h.output = createTerminalOutput({
    store: overrides.store ?? {
      appendTerminalData: async (_sessionId, data) => { h.appended.push(data); },
      loadSession: async () => null,
      saveSession: async () => undefined,
      loadTerminalLog: async () => h.appended.join(''),
      setPendingTerminalFlush: () => undefined,
    },
    terminalManager: overrides.terminalManager ?? new TerminalManager(),
    runner: runner as unknown as TerminalOutputDeps['runner'],
    router: {
      hasAttachedPeers: (sessionId) => h.attachedPeers.has(sessionId),
      publishTerminalData: (sessionId, data) => {
        h.channel.push(['data', data]);
        if (h.attachedPeers.has(sessionId)) h.peer.push(['data', data]);
      },
      publishTerminalScreen: (sessionId, screen) => {
        h.channel.push(['screen', screen]);
        if (h.attachedPeers.has(sessionId)) h.peer.push(['screen', screen]);
      },
    },
    watchRegistry: { hasWatchers: (sessionId) => h.remoteWatchers.has(sessionId) },
    lifecycle: {
      publishSessionUpdate: async () => undefined,
      publishHookEvent: async () => undefined,
      unregisterSession: () => undefined,
    },
  });
  return h;
}

/** An emulator whose state is current as soon as it is written (no async parse). */
function instantEmulator(): TerminalOutputDeps['terminalManager'] {
  const screens = new Map<string, string>();
  return {
    write: (sessionId, data) => { screens.set(sessionId, (screens.get(sessionId) ?? '') + data); },
    destroy: (sessionId) => { screens.delete(sessionId); },
    serialize: (sessionId) => screens.get(sessionId) ?? '',
    whenParsed: (_sessionId, done) => done(),
  };
}

function parsed(h: Harness, sessionId = 's1'): Promise<void> {
  const manager = h.output.pump as unknown as { deps: { terminalManager: TerminalManager } };
  return new Promise((resolve) => manager.deps.terminalManager.whenParsed(sessionId, resolve));
}

async function until(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('condition not reached');
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

/** What a viewer shows after applying frames: a screen replaces, output appends. */
function lastScreenAndAfter(frames: Frame[]): { screen: string; after: string; before: string } {
  const last = frames.map(([kind]) => kind).lastIndexOf('screen');
  assert.notEqual(last, -1, 'no screen frame was delivered');
  const firstScreen = frames.findIndex(([kind]) => kind === 'screen');
  return {
    screen: frames[last][1],
    after: frames.slice(last + 1).map(([, data]) => data).join(''),
    before: frames.slice(0, firstScreen).map(([, data]) => data).join(''),
  };
}

test('a screen dump requested in the same turn as a PTY chunk contains that chunk', async (t) => {
  const h = makeHarness();
  t.after(() => h.output.pump.drain());
  h.emit('OLD ');
  await parsed(h);

  // One loop turn: a chunk arrives and a remote watcher asks for the screen.
  h.emit('SAMETICK');
  h.remoteWatchers.add('s1');
  h.output.publishScreenDump('s1');

  await until(() => h.channel.some(([kind]) => kind === 'screen'));
  h.emit(' LATER');
  await until(() => h.channel.at(-1)?.[1] === ' LATER');

  const view = lastScreenAndAfter(h.channel);
  assert.equal(view.before, 'OLD SAMETICK');
  assert.ok(view.screen.includes('OLD SAMETICK'), `screen lost output: ${JSON.stringify(view.screen)}`);
  assert.equal(view.after, ' LATER');
});

test('a direct peer attaching in the same turn as a PTY chunk gets it in its screen, exactly once', async (t) => {
  const h = makeHarness();
  t.after(() => h.output.pump.drain());
  h.emit('OLD ');
  await parsed(h);

  h.emit('SAMETICK');
  h.attachPeer();
  // Still the same turn: this chunk is past the snapshot's cut.
  h.emit(' NEXT');

  await until(() => h.peer.length > 0);
  h.emit(' LATER');
  await until(() => h.peer.at(-1)?.[1].endsWith(' LATER') === true);

  assert.equal(h.peer[0][0], 'screen', 'the peer receives nothing before its own snapshot');
  assert.ok(h.peer[0][1].includes('OLD SAMETICK'), `screen lost output: ${JSON.stringify(h.peer[0][1])}`);
  assert.equal(h.peer[0][1].includes('NEXT'), false);
  assert.equal(h.peer.slice(1).map(([, data]) => data).join(''), ' NEXT LATER');
  // Everyone else got every byte exactly once as output.
  assert.equal(h.channel.filter(([kind]) => kind === 'data').map(([, data]) => data).join(''), 'OLD SAMETICK NEXT LATER');
});

test('a screen dump sends coalescing output before the screen and never again', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = makeHarness({ terminalManager: instantEmulator() });
  h.emit('pending');
  h.remoteWatchers.add('s1');
  h.output.publishScreenDump('s1');
  assert.deepStrictEqual(h.channel, [['data', 'pending'], ['screen', 'pending']]);
  t.mock.timers.tick(250);
  assert.equal(h.channel.length, 2, 'the old coalescing window delivers nothing a second time');
});

test('a peer attach does not replay coalescing output after the attach screen', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = makeHarness({ terminalManager: instantEmulator() });
  h.emit('pending');
  h.attachPeer();
  t.mock.timers.tick(250);
  assert.deepStrictEqual(h.peer, [['screen', 'pending']]);
  h.emit('next');
  t.mock.timers.tick(16);
  assert.deepStrictEqual(h.peer, [['screen', 'pending'], ['data', 'next']]);
});

test('a session nobody watches coalesces for 250 ms; a direct peer or a remote watcher restores 16 ms', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = makeHarness({ terminalManager: instantEmulator() });
  h.emit('a');
  t.mock.timers.tick(16);
  assert.deepStrictEqual(h.channel, []);
  t.mock.timers.tick(234);
  assert.deepStrictEqual(h.channel, [['data', 'a']]);

  h.attachedPeers.add('s1');
  h.emit('b');
  t.mock.timers.tick(16);
  assert.deepStrictEqual(h.channel.at(-1), ['data', 'b']);

  h.attachedPeers.clear();
  h.remoteWatchers.add('s1');
  h.emit('c');
  t.mock.timers.tick(16);
  assert.deepStrictEqual(h.channel.at(-1), ['data', 'c']);

  h.remoteWatchers.clear();
  h.emit('d');
  t.mock.timers.tick(16);
  assert.equal(h.channel.length, 3);
});

test('terminal.log readers see output that is still coalescing', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'ftown-terminal-output-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const store = new SessionStore(dir);
  const h = makeHarness({ store, terminalManager: instantEmulator() });
  h.emit('not flushed yet');
  assert.equal(await store.loadTerminalLog('s1'), 'not flushed yet');
});

test('stop detaches the runner and persists every pending buffer before resolving', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const releases: Array<() => void> = [];
  const stored: string[] = [];
  const h = makeHarness({
    terminalManager: instantEmulator(),
    store: {
      appendTerminalData: (sessionId, data) => new Promise<void>((resolve) => {
        releases.push(() => { stored.push(`${sessionId}:${data}`); resolve(); });
      }),
      loadSession: async () => null,
      saveSession: async () => undefined,
      loadTerminalLog: async () => '',
      setPendingTerminalFlush: () => undefined,
    },
  });
  h.emit('one', 's1');
  h.emit('two', 's2');

  let stopped = false;
  const stopping = h.output.stop().then(() => { stopped = true; });
  assert.equal(h.stopAllCalls, 1);
  assert.equal(releases.length, 2, 'pending output was handed to the store without waiting for a timer');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(stopped, false);
  for (const release of releases) release();
  await stopping;
  assert.deepStrictEqual(stored, ['s1:one', 's2:two']);
});

test('the runner lifecycle is wired: exit flushes the session', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = makeHarness({ terminalManager: instantEmulator() });
  t.mock.method(console, 'log', () => undefined);
  h.emit('last words');
  h.runner.emit('complete', 's1');
  assert.deepStrictEqual(h.appended, ['last words']);
});

test('a chunk that arrives while a peer waits for its attach screen is not delayed by the unwatched window', async (t) => {
  const h = makeHarness();
  t.after(() => h.output.pump.drain());
  h.emit('OLD ');
  await parsed(h);
  await h.output.pump.drain();

  const started = performance.now();
  h.attachPeer();
  h.emit('DURING');
  await until(() => h.peer.some(([kind, data]) => kind === 'data' && data === 'DURING'));
  const elapsed = performance.now() - started;
  assert.deepStrictEqual(h.peer.map(([kind]) => kind), ['screen', 'data']);
  assert.ok(elapsed < 150, `chunk delivered after ${elapsed.toFixed(0)} ms`);
});

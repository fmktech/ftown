/**
 * Contract-level tests for PublishRouter (docs/plans/direct-transport-contract.md, R2/R5).
 * Written against contract.ts and PublishRouter's own exported `PublishRouterOptions` /
 * `CentrifugoPublisher` types: constructor takes a single options object
 * `{ registry, peerManager, centrifugo, userId }`; `publishTerminalData` /
 * `publishTerminalScreen` are synchronous (fire-and-forget the Centrifugo publish
 * internally with `.catch`).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { PublishRouter } from './publish-router.js';
import type { CentrifugoPublisher } from './publish-router.js';
import { WatchRegistry } from './watch-registry.js';
import type { DirectPeerManager } from './peer-manager.js';
import type { SignalType } from './contract.js';

const USER_ID = 'user-1';

class FakeWatchRegistry {
  private watched = new Set<string>();
  private firstWatcherCbs: Array<(sessionId: string) => void> = [];
  public watchCalls: Array<[string, string]> = [];
  public unwatchCalls: Array<[string, string]> = [];

  hasWatchers(sessionId: string): boolean {
    return this.watched.has(sessionId);
  }

  watch(sessionId: string, clientId: string): void {
    this.watchCalls.push([sessionId, clientId]);
    this.watched.add(sessionId);
  }

  unwatch(sessionId: string, clientId: string): void {
    this.unwatchCalls.push([sessionId, clientId]);
    this.watched.delete(sessionId);
  }

  onFirstWatcher(cb: (sessionId: string) => void): void {
    this.firstWatcherCbs.push(cb);
  }

  dispose(): void {}

  /** Test helper: flips a session into "watched" state and fires onFirstWatcher. */
  simulateFirstWatcher(sessionId: string): void {
    this.watched.add(sessionId);
    for (const cb of this.firstWatcherCbs) cb(sessionId);
  }
}

class FakePeerManager {
  public sendOutputCalls: Array<[string, string]> = [];
  public sendScreenCalls: Array<[string, string]> = [];
  public handleSignalCalls: unknown[] = [];

  sendOutput(sessionId: string, data: string): void {
    this.sendOutputCalls.push([sessionId, data]);
  }

  sendScreen(sessionId: string, data: string): void {
    this.sendScreenCalls.push([sessionId, data]);
  }

  hasAttachedPeers(): boolean {
    return false;
  }

  handleSignal(msg: unknown): void {
    this.handleSignalCalls.push(msg);
  }
}

interface CentrifugoCall {
  kind: 'data' | 'screen';
  sessionId: string;
  payload: string;
}

class FakeCentrifugoClient implements CentrifugoPublisher {
  public calls: CentrifugoCall[] = [];

  async publishTerminalData(userId: string, sessionId: string, data: string): Promise<void> {
    assert.strictEqual(userId, USER_ID);
    this.calls.push({ kind: 'data', sessionId, payload: data });
  }

  async publishTerminalScreen(userId: string, sessionId: string, raw: string): Promise<void> {
    assert.strictEqual(userId, USER_ID);
    this.calls.push({ kind: 'screen', sessionId, payload: raw });
  }
}

function makeRouter(isKnownSession?: (sessionId: string) => boolean) {
  const watchRegistry = new FakeWatchRegistry();
  const peerManager = new FakePeerManager();
  const centrifugo = new FakeCentrifugoClient();
  const warnings: string[] = [];
  const router = new PublishRouter({
    registry: watchRegistry as unknown as WatchRegistry,
    peerManager: peerManager as unknown as DirectPeerManager,
    centrifugo,
    userId: USER_ID,
    isKnownSession,
    warn: (message) => { warnings.push(message); },
  });
  return { router, watchRegistry, peerManager, centrifugo, warnings };
}

describe('PublishRouter.publishTerminalData', () => {
  it('always forwards output to direct peers, regardless of watcher state', async () => {
    const { router, peerManager } = makeRouter();
    await router.publishTerminalData('sess-1', 'hello');
    assert.deepStrictEqual(peerManager.sendOutputCalls, [['sess-1', 'hello']]);
  });

  it('R2: does NOT publish to Centrifugo when the session has no watchers', async () => {
    const { router, centrifugo } = makeRouter();
    await router.publishTerminalData('sess-1', 'hello');
    assert.deepStrictEqual(centrifugo.calls, []);
  });

  it('R2: publishes to Centrifugo once the session has an unexpired watcher', async () => {
    const { router, watchRegistry, centrifugo } = makeRouter();
    watchRegistry.simulateFirstWatcher('sess-1');
    await router.publishTerminalData('sess-1', 'hello');
    assert.ok(
      centrifugo.calls.some((c) => c.kind === 'data' && c.sessionId === 'sess-1' && c.payload === 'hello'),
    );
  });
});

describe('PublishRouter.publishTerminalScreen', () => {
  it('always forwards the screen to direct peers, regardless of watcher state', async () => {
    const { router, peerManager } = makeRouter();
    await router.publishTerminalScreen('sess-1', 'SCREEN');
    assert.deepStrictEqual(peerManager.sendScreenCalls, [['sess-1', 'SCREEN']]);
  });

  it('R2: gates the Centrifugo screen dump on watcher presence, same as output', async () => {
    const { router, watchRegistry, centrifugo } = makeRouter();

    await router.publishTerminalScreen('sess-1', 'SCREEN-1');
    assert.strictEqual(centrifugo.calls.length, 0);

    watchRegistry.simulateFirstWatcher('sess-1');
    await router.publishTerminalScreen('sess-1', 'SCREEN-2');
    assert.ok(centrifugo.calls.some((c) => c.kind === 'screen' && c.payload === 'SCREEN-2'));
  });

  it('R1: a screen published once a watcher attaches precedes subsequently published output on Centrifugo, in call order', async () => {
    const { router, watchRegistry, centrifugo } = makeRouter();

    // No watcher yet: this output must not appear on the Centrifugo call log at all.
    await router.publishTerminalData('sess-1', 'pre-watch-output');

    watchRegistry.simulateFirstWatcher('sess-1');
    await router.publishTerminalScreen('sess-1', 'FULL-SCREEN');
    await router.publishTerminalData('sess-1', 'post-watch-output');

    assert.deepStrictEqual(
      centrifugo.calls.map((c) => [c.kind, c.payload]),
      [
        ['screen', 'FULL-SCREEN'],
        ['data', 'post-watch-output'],
      ],
    );
  });
});

describe('PublishRouter.handleCommand', () => {
  const signalTypes: SignalType[] = ['webrtc_offer', 'webrtc_answer', 'webrtc_ice', 'webrtc_close'];

  for (const type of signalTypes) {
    it(`routes ${type} signaling commands to the peer manager`, () => {
      const { router, peerManager } = makeRouter();
      const msg = { type, pairId: 'pair-1', bridgeId: 'bridge-1', clientId: 'client-1', payload: '' };
      router.handleCommand(msg);
      assert.deepStrictEqual(peerManager.handleSignalCalls, [msg]);
    });
  }

  it('routes terminal_watch to WatchRegistry.watch(sessionId, clientId)', () => {
    const { router, watchRegistry } = makeRouter();
    router.handleCommand({ type: 'terminal_watch', sessionId: 'sess-1', clientId: 'client-1' });
    assert.deepStrictEqual(watchRegistry.watchCalls, [['sess-1', 'client-1']]);
  });

  it('routes terminal_unwatch to WatchRegistry.unwatch(sessionId, clientId)', () => {
    const { router, watchRegistry } = makeRouter();
    router.handleCommand({ type: 'terminal_unwatch', sessionId: 'sess-1', clientId: 'client-1' });
    assert.deepStrictEqual(watchRegistry.unwatchCalls, [['sess-1', 'client-1']]);
  });

  it('ignores unknown command types without throwing or dispatching anywhere', () => {
    const { router, peerManager, watchRegistry } = makeRouter();
    assert.doesNotThrow(() => router.handleCommand({ type: 'bogus_command' } as never));
    assert.deepStrictEqual(peerManager.handleSignalCalls, []);
    assert.deepStrictEqual(watchRegistry.watchCalls, []);
    assert.deepStrictEqual(watchRegistry.unwatchCalls, []);
  });

  // Hardening: malformed watch messages must never reach the registry.
  const malformedWatchCases: Array<{ name: string; sessionId?: unknown; clientId?: unknown }> = [
    { name: 'missing sessionId', clientId: 'client-1' },
    { name: 'empty sessionId', sessionId: '', clientId: 'client-1' },
    { name: 'non-string sessionId', sessionId: 42, clientId: 'client-1' },
    { name: 'missing clientId', sessionId: 'sess-1' },
    { name: 'empty clientId', sessionId: 'sess-1', clientId: '' },
    { name: 'non-string clientId', sessionId: 'sess-1', clientId: { id: 'x' } },
  ];

  for (const watchType of ['terminal_watch', 'terminal_unwatch'] as const) {
    for (const { name, sessionId, clientId } of malformedWatchCases) {
      it(`${watchType} with ${name} is ignored without throwing`, () => {
        const { router, watchRegistry } = makeRouter();
        assert.doesNotThrow(() =>
          router.handleCommand({ type: watchType, sessionId, clientId } as never),
        );
        assert.deepStrictEqual(watchRegistry.watchCalls, []);
        assert.deepStrictEqual(watchRegistry.unwatchCalls, []);
      });
    }
  }
});

describe('PublishRouter isKnownSession gating', () => {
  it('terminal_watch for an unknown session does not register and hasWatchers stays false', () => {
    const { router, watchRegistry } = makeRouter(() => false);

    router.handleCommand({ type: 'terminal_watch', sessionId: 'foreign-sess', clientId: 'client-1' });

    assert.deepStrictEqual(watchRegistry.watchCalls, []);
    assert.strictEqual(watchRegistry.hasWatchers('foreign-sess'), false);
  });

  it('terminal_unwatch is NOT gated by isKnownSession', () => {
    const { router, watchRegistry } = makeRouter(() => false);

    router.handleCommand({ type: 'terminal_unwatch', sessionId: 'foreign-sess', clientId: 'client-1' });

    assert.deepStrictEqual(watchRegistry.unwatchCalls, [['foreign-sess', 'client-1']]);
  });

  it('terminal_watch for a known session registers normally and is gated per-session', () => {
    const { router, watchRegistry } = makeRouter((sessionId) => sessionId === 'mine');

    router.handleCommand({ type: 'terminal_watch', sessionId: 'mine', clientId: 'client-1' });
    router.handleCommand({ type: 'terminal_watch', sessionId: 'not-mine', clientId: 'client-1' });

    assert.deepStrictEqual(watchRegistry.watchCalls, [['mine', 'client-1']]);
    assert.strictEqual(watchRegistry.hasWatchers('mine'), true);
    assert.strictEqual(watchRegistry.hasWatchers('not-mine'), false);
  });
});

/**
 * Loopback fan-out (docs/plans/loopback-transport-addendum.md): PublishRouter gains an
 * OPTIONAL `loopback` option (additive, `LoopbackPeerServerLike`); output/screen fan out
 * to BOTH the WebRTC peer manager and the loopback server, and `hasAttachedPeers` is the
 * OR of both. These tests exercise `makeRouterWithLoopback` below, which is this test
 * file's interpretation of the addition — the frozen surface names the option `loopback`
 * and its shape (`sendOutput`/`sendScreen`/`hasAttachedPeers`) but does not itself name a
 * `PublishRouter.hasAttachedPeers` method; we assume one is added per "hasAttachedPeers =
 * either" in the addendum text.
 */
class FakeLoopbackServer {
  public sendOutputCalls: Array<[string, string]> = [];
  public sendScreenCalls: Array<[string, string]> = [];
  private attached = new Set<string>();

  sendOutput(sessionId: string, data: string): void {
    this.sendOutputCalls.push([sessionId, data]);
  }

  sendScreen(sessionId: string, data: string): void {
    this.sendScreenCalls.push([sessionId, data]);
  }

  hasAttachedPeers(sessionId: string): boolean {
    return this.attached.has(sessionId);
  }

  /** Test helper: flips a session into "attached" state on the loopback fake. */
  simulateAttach(sessionId: string): void {
    this.attached.add(sessionId);
  }
}

function makeRouterWithLoopback(isKnownSession?: (sessionId: string) => boolean) {
  const watchRegistry = new FakeWatchRegistry();
  const peerManager = new FakePeerManager();
  const loopback = new FakeLoopbackServer();
  const centrifugo = new FakeCentrifugoClient();
  const router = new PublishRouter({
    registry: watchRegistry as unknown as WatchRegistry,
    peerManager: peerManager as unknown as DirectPeerManager,
    centrifugo,
    userId: USER_ID,
    isKnownSession,
    loopback,
  } as never);
  return { router, watchRegistry, peerManager, loopback, centrifugo };
}

describe('PublishRouter loopback fan-out (addendum)', () => {
  it('publishTerminalData reaches both the WebRTC peer manager and the loopback server', async () => {
    const { router, peerManager, loopback } = makeRouterWithLoopback();
    await router.publishTerminalData('sess-1', 'hello');
    assert.deepStrictEqual(peerManager.sendOutputCalls, [['sess-1', 'hello']]);
    assert.deepStrictEqual(loopback.sendOutputCalls, [['sess-1', 'hello']]);
  });

  it('publishTerminalScreen reaches both the WebRTC peer manager and the loopback server', async () => {
    const { router, peerManager, loopback } = makeRouterWithLoopback();
    await router.publishTerminalScreen('sess-1', 'SCREEN');
    assert.deepStrictEqual(peerManager.sendScreenCalls, [['sess-1', 'SCREEN']]);
    assert.deepStrictEqual(loopback.sendScreenCalls, [['sess-1', 'SCREEN']]);
  });

  it('R2 Centrifugo watch-gating is unchanged when a loopback server is registered', async () => {
    const { router, watchRegistry, centrifugo } = makeRouterWithLoopback();

    await router.publishTerminalData('sess-1', 'pre-watch');
    assert.deepStrictEqual(centrifugo.calls, []);

    watchRegistry.simulateFirstWatcher('sess-1');
    await router.publishTerminalData('sess-1', 'post-watch');
    assert.ok(centrifugo.calls.some((c) => c.kind === 'data' && c.payload === 'post-watch'));
  });

  it('hasAttachedPeers is true when only the WebRTC peer manager has an attached peer', () => {
    const { router, peerManager } = makeRouterWithLoopback();
    peerManager.hasAttachedPeers = () => true;
    assert.strictEqual((router as unknown as { hasAttachedPeers(id: string): boolean }).hasAttachedPeers('sess-1'), true);
  });

  it('hasAttachedPeers is true when only the loopback server has an attached peer', () => {
    const { router, loopback } = makeRouterWithLoopback();
    loopback.simulateAttach('sess-1');
    assert.strictEqual((router as unknown as { hasAttachedPeers(id: string): boolean }).hasAttachedPeers('sess-1'), true);
  });

  it('hasAttachedPeers is false when neither transport has an attached peer', () => {
    const { router } = makeRouterWithLoopback();
    assert.strictEqual((router as unknown as { hasAttachedPeers(id: string): boolean }).hasAttachedPeers('sess-1'), false);
  });

  it('without a loopback option, PublishRouter behaves exactly as before (no loopback fan-out)', async () => {
    const { router, peerManager } = makeRouter();
    await router.publishTerminalData('sess-1', 'hello');
    await router.publishTerminalScreen('sess-1', 'SCREEN');
    assert.deepStrictEqual(peerManager.sendOutputCalls, [['sess-1', 'hello']]);
    assert.deepStrictEqual(peerManager.sendScreenCalls, [['sess-1', 'SCREEN']]);
  });
});

/**
 * Sessions alive in tmux but with no PTY client in this bridge process (agent
 * spawned via the local API, a re-run, or a session adopted after a restart).
 * `isKnownSession` is wired in index.ts as
 * `runner.isRunning(sid) || terminalManager.has(sid) || runner.hasTmuxSession(sid)`;
 * these tests pin the router half of that contract — the third arm must be able
 * to admit a watch on its own, and a genuinely unknown session must still be
 * dropped, now with exactly one log line naming it.
 */
describe('PublishRouter tmux-only sessions and unknown-watch logging', () => {
  /** Stand-in for the index.ts predicate: nothing in-process, alive in tmux. */
  const tmuxOnly = (alive: string) => (sessionId: string) => sessionId === alive;

  it('accepts terminal_watch for a session known only through the tmux arm of the predicate', () => {
    const { router, watchRegistry, warnings } = makeRouter(tmuxOnly('tmux-sess'));

    router.handleCommand({ type: 'terminal_watch', sessionId: 'tmux-sess', clientId: 'client-1' });

    assert.deepStrictEqual(watchRegistry.watchCalls, [['tmux-sess', 'client-1']]);
    assert.strictEqual(watchRegistry.hasWatchers('tmux-sess'), true);
    assert.deepStrictEqual(warnings, []);
  });

  it('a tmux-only watch fires onNewWatcher on the real WatchRegistry (the screen-dump trigger)', () => {
    const registry = new WatchRegistry({ sweepIntervalMs: 0 });
    const newWatchers: string[] = [];
    registry.onNewWatcher((sessionId) => { newWatchers.push(sessionId); });
    const router = new PublishRouter({
      registry,
      peerManager: new FakePeerManager() as unknown as DirectPeerManager,
      centrifugo: new FakeCentrifugoClient(),
      userId: USER_ID,
      isKnownSession: tmuxOnly('tmux-sess'),
    });

    router.handleCommand({ type: 'terminal_watch', sessionId: 'tmux-sess', clientId: 'client-1' });

    assert.deepStrictEqual(newWatchers, ['tmux-sess']);
    assert.strictEqual(registry.hasWatchers('tmux-sess'), true);
    registry.dispose();
  });

  it('R2 output for a tmux-only session reaches Centrifugo once its watch is accepted', async () => {
    const { router, centrifugo } = makeRouter(tmuxOnly('tmux-sess'));

    await router.publishTerminalData('tmux-sess', 'pre-watch');
    assert.deepStrictEqual(centrifugo.calls, []);

    router.handleCommand({ type: 'terminal_watch', sessionId: 'tmux-sess', clientId: 'client-1' });
    await router.publishTerminalData('tmux-sess', 'post-watch');

    assert.deepStrictEqual(
      centrifugo.calls.map((c) => [c.kind, c.payload]),
      [['data', 'post-watch']],
    );
  });

  it('still drops terminal_watch for an unknown session, and logs it once with the sessionId', () => {
    const { router, watchRegistry, warnings } = makeRouter(() => false);

    // Watchers re-send terminal_watch every WATCH_HEARTBEAT_MS; only the first logs.
    router.handleCommand({ type: 'terminal_watch', sessionId: 'foreign-sess', clientId: 'client-1' });
    router.handleCommand({ type: 'terminal_watch', sessionId: 'foreign-sess', clientId: 'client-1' });
    router.handleCommand({ type: 'terminal_watch', sessionId: 'foreign-sess', clientId: 'client-2' });

    assert.deepStrictEqual(watchRegistry.watchCalls, []);
    assert.strictEqual(warnings.length, 1);
    assert.match(warnings[0], /terminal_watch/);
    assert.match(warnings[0], /foreign-sess/);
  });

  it('logs each distinct unknown session once, so one noisy session cannot mask another', () => {
    const { router, warnings } = makeRouter(() => false);

    router.handleCommand({ type: 'terminal_watch', sessionId: 'foreign-a', clientId: 'client-1' });
    router.handleCommand({ type: 'terminal_watch', sessionId: 'foreign-b', clientId: 'client-1' });
    router.handleCommand({ type: 'terminal_watch', sessionId: 'foreign-a', clientId: 'client-1' });

    assert.strictEqual(warnings.length, 2);
    assert.ok(warnings.some((w) => w.includes('foreign-a')));
    assert.ok(warnings.some((w) => w.includes('foreign-b')));
  });

  it('does not log for accepted watches or for terminal_unwatch of an unknown session', () => {
    const { router, warnings } = makeRouter((sessionId) => sessionId === 'mine');

    router.handleCommand({ type: 'terminal_watch', sessionId: 'mine', clientId: 'client-1' });
    router.handleCommand({ type: 'terminal_unwatch', sessionId: 'foreign-sess', clientId: 'client-1' });

    assert.deepStrictEqual(warnings, []);
  });
});

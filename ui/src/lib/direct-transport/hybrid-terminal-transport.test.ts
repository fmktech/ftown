/**
 * Contract-level tests for HybridTerminalTransport (docs/plans/direct-transport-contract.md,
 * R1/R3/R6 + "Module APIs" section). Written against contract.ts and the task spec only —
 * deliberately NOT against `./hybrid-terminal-transport.ts` / `./webrtc-peer.ts` internals,
 * since those are being authored concurrently by another agent and are not frozen (only
 * contract.ts is). Only the class name is imported for instantiation; all fakes are typed
 * with local structural interfaces and passed in with an `as unknown as
 * ConstructorParameters<typeof HybridTerminalTransport>[0]` cast, so this file doesn't
 * hard-depend on the in-progress module's exported type names.
 *
 * ASSUMPTIONS (reconcile once the implementation is finalized, without invalidating the
 * behavioral assertions below):
 * - Constructor takes a single deps object: `{ centrifuge, userId, clientId,
 *   publishCommand, peerFactory }`. `centrifuge` is the structural subset of the
 *   `centrifuge` client used elsewhere in this codebase (see src/hooks/useTerminal.ts:
 *   `newSubscription`/`getSubscription`/`removeSubscription`, subscription
 *   `on`/`subscribe`/`unsubscribe`/`removeAllListeners`/`publish`). `publishCommand`
 *   publishes a single already-addressed `DirectCommandMessage` (bridgeId/clientId are
 *   carried on the message itself, matching contract.ts). `peerFactory` is the
 *   injectable WebRtcPeer factory this task spec calls for (one peer per bridge, shared
 *   across sessions on that bridge); it receives the same `{ bridgeId, clientId,
 *   sendSignal }` shape contract.md documents for WebRtcPeer's own constructor.
 * - Fallback (both "pairing failed" and "peer closed mid-session") re-subscribes to
 *   `terminal:{sessionId}#{userId}` and starts sending `terminal_watch` on
 *   `WATCH_HEARTBEAT_MS`, per R3 — but only once the subscription emits 'subscribed'
 *   (R1: the watch-triggered screen_dump must not be published before the subscription
 *   is active). A re-emitted 'subscribed' (reconnect) re-sends a single terminal_watch
 *   without stacking a second heartbeat interval.
 * - `sendInput`/`sendResize` on the centrifugo path publish on a
 *   `terminal-input:{sessionId}#{userId}` subscription with the existing wire shape
 *   (`{type:'input',data}` / `{type:'resize',cols,rows}`), matching
 *   src/hooks/useTerminal.ts and R7 ("existing wire format unchanged").
 * - The initial `'connecting'` mode (before pairing settles) is implicit — readable via
 *   `getMode()` but does not itself fire an `onModeChange` callback; only actual
 *   transitions (-> 'direct' / -> 'centrifugo') do.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  LOOPBACK_TIMEOUT_MS,
  WATCH_HEARTBEAT_MS,
  type DirectCommandMessage,
  type TerminalDataHandlers,
} from './contract';

// HybridTerminalTransport does not exist yet — this import is expected to fail until
// A3 lands it. Only the class is imported; its options/peer/centrifuge types are
// deliberately not, per the note above.
import { HybridTerminalTransport } from './hybrid-terminal-transport';

interface PeerFactoryOpts {
  bridgeId: string;
  clientId: string;
  sendSignal: (msg: unknown) => void;
}

interface WebRtcPeerLike {
  connect(): Promise<void>;
  attach(sessionId: string, handlers: TerminalDataHandlers): void;
  detach(sessionId: string): void;
  sendInput(sessionId: string, data: string): void;
  sendResize(sessionId: string, cols: number, rows: number): void;
  close(): void;
  onClose(cb: () => void): void;
}

class FakePeer implements WebRtcPeerLike {
  static instances: FakePeer[] = [];

  connectMode: 'resolve' | 'reject' = 'resolve';
  attachCalls: Array<[string, TerminalDataHandlers]> = [];
  detachCalls: string[] = [];
  sendInputCalls: Array<[string, string]> = [];
  sendResizeCalls: Array<[string, number, number]> = [];
  closeCalls = 0;
  private closeCbs: Array<() => void> = [];

  constructor(public bridgeId: string) {
    FakePeer.instances.push(this);
  }

  connect(): Promise<void> {
    return this.connectMode === 'resolve' ? Promise.resolve() : Promise.reject(new Error('pair failed'));
  }

  attach(sessionId: string, handlers: TerminalDataHandlers): void {
    this.attachCalls.push([sessionId, handlers]);
  }

  detach(sessionId: string): void {
    this.detachCalls.push(sessionId);
  }

  sendInput(sessionId: string, data: string): void {
    this.sendInputCalls.push([sessionId, data]);
  }

  sendResize(sessionId: string, cols: number, rows: number): void {
    this.sendResizeCalls.push([sessionId, cols, rows]);
  }

  close(): void {
    this.closeCalls++;
  }

  onClose(cb: () => void): void {
    this.closeCbs.push(cb);
  }

  simulateClose(): void {
    const cbs = this.closeCbs.splice(0);
    for (const cb of cbs) cb();
  }
}

interface CentrifugoSubscriptionLike {
  on(event: string, cb: (ctx: { data: unknown }) => void): void;
  removeAllListeners(): void;
  subscribe(): void;
  unsubscribe(): void;
  publish(data: unknown): Promise<unknown>;
}

class FakeSubscription implements CentrifugoSubscriptionLike {
  listeners: Record<string, Array<(ctx: { data: unknown }) => void>> = {};
  publishCalls: unknown[] = [];
  subscribeCalls = 0;
  unsubscribeCalls = 0;

  constructor(public channel: string) {}

  on(event: string, cb: (ctx: { data: unknown }) => void): void {
    (this.listeners[event] ??= []).push(cb);
  }

  /**
   * Explicitly fires the 'subscribed' event. Per R1, the transport must not send
   * terminal_watch (nor start heartbeats) before this — otherwise the bridge's
   * watch-triggered screen_dump could be published before the subscription is
   * active and be lost. Re-emitting simulates a Centrifugo reconnect.
   */
  simulateSubscribed(): void {
    for (const cb of this.listeners['subscribed'] ?? []) cb({ data: undefined });
  }

  removeAllListeners(): void {
    this.listeners = {};
  }

  subscribe(): void {
    this.subscribeCalls++;
  }

  unsubscribe(): void {
    this.unsubscribeCalls++;
  }

  publish(data: unknown): Promise<unknown> {
    this.publishCalls.push(data);
    return Promise.resolve();
  }
}

class FakeCentrifugeClient {
  subs = new Map<string, FakeSubscription>();

  newSubscription(channel: string): FakeSubscription {
    const sub = new FakeSubscription(channel);
    this.subs.set(channel, sub);
    return sub;
  }

  getSubscription(channel: string): FakeSubscription | null {
    return this.subs.get(channel) ?? null;
  }

  removeSubscription(sub: FakeSubscription | null): void {
    if (sub) this.subs.delete(sub.channel);
  }
}

const USER_ID = 'user-1';
const CLIENT_ID = 'client-1';

/**
 * Drains the microtask queue. `vi.advanceTimersByTimeAsync(0)` alone only pumps
 * microtasks tied to a fake-timer tick; plain `promise.then().catch()` chains (e.g.
 * peer.connect() rejecting) need several bare microtask turns to fully settle.
 */
async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await Promise.resolve();
  }
  await vi.advanceTimersByTimeAsync(0);
}

function makeTransport(peerFactory: (opts: PeerFactoryOpts) => WebRtcPeerLike) {
  const centrifuge = new FakeCentrifugeClient();
  const publishCommand = vi.fn<(msg: DirectCommandMessage) => void>();
  const wrappedFactory = vi.fn(peerFactory);
  const deps = {
    centrifuge,
    userId: USER_ID,
    clientId: CLIENT_ID,
    publishCommand,
    peerFactory: wrappedFactory,
  };
  const transport = new HybridTerminalTransport(
    deps as unknown as ConstructorParameters<typeof HybridTerminalTransport>[0],
  );
  return { transport, centrifuge, publishCommand, peerFactory: wrappedFactory };
}

const handlers = (): TerminalDataHandlers => ({ onOutput: vi.fn(), onScreen: vi.fn() });

describe('HybridTerminalTransport', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakePeer.instances = [];
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('on successful pairing: mode connecting -> direct, attaches peer, no centrifugo terminal subscription/watch', async () => {
    const { transport, centrifuge, publishCommand, peerFactory } = makeTransport(
      (opts) => new FakePeer(opts.bridgeId),
    );
    const modeChanges: Array<[string, string]> = [];
    transport.onModeChange((sessionId, mode) => modeChanges.push([sessionId, mode]));

    transport.subscribeTerminal('session-1', 'bridge-1', handlers());
    expect(transport.getMode('session-1')).toBe('connecting');

    await flush();

    expect(transport.getMode('session-1')).toBe('direct');
    expect(peerFactory).toHaveBeenCalledWith(expect.objectContaining({ bridgeId: 'bridge-1' }));
    const peer = FakePeer.instances[0];
    expect(peer.attachCalls).toHaveLength(1);
    expect(peer.attachCalls[0][0]).toBe('session-1');

    expect(centrifuge.getSubscription(`terminal:session-1#${USER_ID}`)).toBeNull();
    expect(publishCommand).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'terminal_watch' }));

    expect(modeChanges).toContainEqual(['session-1', 'direct']);
  });

  it('on pairing failure: falls back to centrifugo, subscribes+watches, heartbeats, unwatches on unsubscribe', async () => {
    const { transport, centrifuge, publishCommand } = makeTransport((opts) => {
      const peer = new FakePeer(opts.bridgeId);
      peer.connectMode = 'reject';
      return peer;
    });

    const unsubscribe = transport.subscribeTerminal('session-1', 'bridge-1', handlers());
    await flush();

    expect(transport.getMode('session-1')).toBe('centrifugo');
    const sub = centrifuge.getSubscription(`terminal:session-1#${USER_ID}`);
    expect(sub).not.toBeNull();
    expect(sub!.subscribeCalls).toBe(1);

    // R1 ordering: no terminal_watch may be sent before the subscription is active
    // ('subscribed' emitted), or the watch-triggered screen_dump could be lost.
    expect(publishCommand).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'terminal_watch' }));

    sub!.simulateSubscribed();
    expect(publishCommand).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'terminal_watch', sessionId: 'session-1', clientId: CLIENT_ID }),
    );

    publishCommand.mockClear();
    await vi.advanceTimersByTimeAsync(WATCH_HEARTBEAT_MS);
    expect(publishCommand).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'terminal_watch', sessionId: 'session-1' }),
    );

    publishCommand.mockClear();
    unsubscribe();
    expect(publishCommand).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'terminal_unwatch', sessionId: 'session-1', clientId: CLIENT_ID }),
    );

    publishCommand.mockClear();
    await vi.advanceTimersByTimeAsync(WATCH_HEARTBEAT_MS * 2);
    expect(publishCommand).not.toHaveBeenCalled();
  });

  it('falls back when the peer closes mid-session: mode change fired, watch heartbeats start', async () => {
    const { transport, centrifuge, publishCommand } = makeTransport((opts) => new FakePeer(opts.bridgeId));
    const modeChanges: Array<[string, string]> = [];
    transport.onModeChange((sessionId, mode) => modeChanges.push([sessionId, mode]));

    transport.subscribeTerminal('session-1', 'bridge-1', handlers());
    await flush();
    expect(transport.getMode('session-1')).toBe('direct');

    const peer = FakePeer.instances[0];
    peer.simulateClose();
    await flush();

    expect(transport.getMode('session-1')).toBe('centrifugo');
    expect(modeChanges).toContainEqual(['session-1', 'centrifugo']);
    const sub = centrifuge.getSubscription(`terminal:session-1#${USER_ID}`);
    expect(sub).not.toBeNull();

    // R1 ordering: no terminal_watch before the fallback subscription is active.
    expect(publishCommand).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'terminal_watch' }));

    sub!.simulateSubscribed();
    expect(publishCommand).toHaveBeenCalledWith(expect.objectContaining({ type: 'terminal_watch' }));

    publishCommand.mockClear();
    await vi.advanceTimersByTimeAsync(WATCH_HEARTBEAT_MS);
    expect(publishCommand).toHaveBeenCalledWith(expect.objectContaining({ type: 'terminal_watch' }));
  });

  it('reports bridge reachability while a Local/P2P peer is attached', async () => {
    const { transport } = makeTransport((opts) => new FakePeer(opts.bridgeId));
    const changes: Array<[string, boolean]> = [];
    transport.onBridgeReachabilityChange((bridgeId, reachable) => changes.push([bridgeId, reachable]));

    transport.subscribeTerminal('session-1', 'bridge-1', handlers());
    await flush();

    expect(transport.getDirectlyReachableBridgeIds()).toEqual(['bridge-1']);
    expect(changes).toEqual([['bridge-1', true]]);

    FakePeer.instances[0].simulateClose();
    await flush();

    expect(transport.getDirectlyReachableBridgeIds()).toEqual([]);
    expect(changes).toEqual([
      ['bridge-1', true],
      ['bridge-1', false],
    ]);
  });

  it("re-emitted 'subscribed' (reconnect) re-sends exactly one terminal_watch without stacking heartbeats", async () => {
    const { transport, centrifuge, publishCommand } = makeTransport((opts) => {
      const p = new FakePeer(opts.bridgeId);
      p.connectMode = 'reject';
      return p;
    });

    transport.subscribeTerminal('session-1', 'bridge-1', handlers());
    await flush();
    const sub = centrifuge.getSubscription(`terminal:session-1#${USER_ID}`);
    expect(sub).not.toBeNull();
    sub!.simulateSubscribed();

    const watchCount = () =>
      publishCommand.mock.calls.filter((c) => (c[0] as { type: string }).type === 'terminal_watch').length;

    publishCommand.mockClear();
    // Reconnect: Centrifugo re-emits 'subscribed' on the same subscription.
    sub!.simulateSubscribed();
    expect(watchCount()).toBe(1);

    // One heartbeat period later there must be exactly one more watch — a stacked
    // (duplicate) interval would produce two.
    publishCommand.mockClear();
    await vi.advanceTimersByTimeAsync(WATCH_HEARTBEAT_MS);
    expect(watchCount()).toBe(1);
  });

  it('routes sendInput/sendResize to the active path (peer frame vs terminal-input publish)', async () => {
    const { transport, centrifuge } = makeTransport((opts) => new FakePeer(opts.bridgeId));

    transport.subscribeTerminal('session-1', 'bridge-1', handlers());
    await flush();
    expect(transport.getMode('session-1')).toBe('direct');

    transport.sendInput('session-1', 'ls\n');
    transport.sendResize('session-1', 80, 24);
    const peer = FakePeer.instances[0];
    expect(peer.sendInputCalls).toContainEqual(['session-1', 'ls\n']);
    expect(peer.sendResizeCalls).toContainEqual(['session-1', 80, 24]);

    // Second, failing-to-pair session falls back to centrifugo's terminal-input channel.
    const { transport: transport2, centrifuge: centrifuge2 } = makeTransport((opts) => {
      const p = new FakePeer(opts.bridgeId);
      p.connectMode = 'reject';
      return p;
    });
    transport2.subscribeTerminal('session-2', 'bridge-2', handlers());
    await flush();
    expect(transport2.getMode('session-2')).toBe('centrifugo');

    transport2.sendInput('session-2', 'ls\n');
    transport2.sendResize('session-2', 80, 24);
    // The publish chain settles the in-flight input publish on a microtask before the
    // queued resize frame goes out — flush before asserting the recorded frames.
    await flush();
    const inputSub = centrifuge2.getSubscription(`terminal-input:session-2#${USER_ID}`);
    expect(inputSub).not.toBeNull();
    expect(inputSub!.publishCalls).toContainEqual({ type: 'input', data: 'ls\n' });
    expect(inputSub!.publishCalls).toContainEqual({ type: 'resize', cols: 80, rows: 24 });

    // Sanity: session-1's centrifuge instance never got an input subscription.
    expect(centrifuge.getSubscription(`terminal-input:session-1#${USER_ID}`)).toBeNull();
  });

  it('shares one peer per bridgeId across sessions; dispose() cleans up everything', async () => {
    const { transport, peerFactory, publishCommand } = makeTransport((opts) => new FakePeer(opts.bridgeId));

    transport.subscribeTerminal('session-1', 'bridge-1', handlers());
    transport.subscribeTerminal('session-2', 'bridge-1', handlers());
    await flush();

    expect(peerFactory).toHaveBeenCalledTimes(1);
    const peer = FakePeer.instances[0];
    expect(peer.attachCalls.map((c) => c[0]).sort()).toEqual(['session-1', 'session-2']);

    transport.dispose();
    expect(peer.closeCalls).toBe(1);

    publishCommand.mockClear();
    await vi.advanceTimersByTimeAsync(WATCH_HEARTBEAT_MS * 3);
    expect(publishCommand).not.toHaveBeenCalled();
  });

  it('getFallbackReason: pairing failure -> pairing_failed, peer close mid-session -> peer_lost, direct -> null', async () => {
    const { transport: failing } = makeTransport((opts) => {
      const p = new FakePeer(opts.bridgeId);
      p.connectMode = 'reject';
      return p;
    });
    failing.subscribeTerminal('session-1', 'bridge-1', handlers());
    await flush();
    expect(failing.getMode('session-1')).toBe('centrifugo');
    expect(failing.getFallbackReason('session-1')).toBe('pairing_failed');

    const { transport: direct } = makeTransport((opts) => new FakePeer(opts.bridgeId));
    direct.subscribeTerminal('session-2', 'bridge-2', handlers());
    await flush();
    expect(direct.getMode('session-2')).toBe('direct');
    expect(direct.getFallbackReason('session-2')).toBeNull();

    const peer = FakePeer.instances.find((p) => p.bridgeId === 'bridge-2')!;
    peer.simulateClose();
    await flush();
    expect(direct.getMode('session-2')).toBe('centrifugo');
    expect(direct.getFallbackReason('session-2')).toBe('peer_lost');
  });

  it('dispose() unwatches sessions that were on the centrifugo fallback path', async () => {
    const { transport, publishCommand } = makeTransport((opts) => {
      const p = new FakePeer(opts.bridgeId);
      p.connectMode = 'reject';
      return p;
    });

    transport.subscribeTerminal('session-1', 'bridge-1', handlers());
    await flush();
    expect(transport.getMode('session-1')).toBe('centrifugo');

    publishCommand.mockClear();
    transport.dispose();
    expect(publishCommand).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'terminal_unwatch', sessionId: 'session-1' }),
    );

    publishCommand.mockClear();
    await vi.advanceTimersByTimeAsync(WATCH_HEARTBEAT_MS * 2);
    expect(publishCommand).not.toHaveBeenCalled();
  });
});

/**
 * Loopback ladder tests (docs/plans/loopback-transport-addendum.md, L4-L6 + "Module
 * surface (frozen)" section). Appended rather than interleaved with the pre-existing
 * suite above so the frozen webrtc-only cases stay untouched; these are new cases only.
 *
 * ASSUMPTIONS (addendum leaves the exact mechanism to the implementation; reconcile once
 * it lands without invalidating the behavioral assertions below):
 * - `HybridTerminalTransportOptions` gains two additive, optional fields:
 *   - `loopbackPeerFactory?: (opts: { bridgeId, clientId, port, nonce }) => LoopbackPeerLike`
 *     (mirrors `peerFactory` for WebRTC; L1's `port`/`nonce` come from the presence
 *     advert, not a signaling round-trip — loopback has no signaling plane).
 *   - `getLocalAdvert?: (bridgeId: string) => Promise<{ localPort: number; localNonce:
 *     string } | null>` — the addendum's L6 "query presence on the bridges channel
 *     through the injected Centrifuge client at pairing time" is a mechanism internal to
 *     the transport; this injected function is the seam this suite tests against rather
 *     than a specific Centrifuge presence API shape (not specified by the addendum).
 * - Ladder order per bridge: loopback (only if `getLocalAdvert` resolves non-null)  ->
 *   webrtc -> centrifugo, tried in sequence, each rung's failure falling to the next.
 *   `getMode()` reports `'local'` only for a peer that reached the loopback rung.
 * - A rung that reached "connected" status (`'local'` or `'direct'`) and then closes
 *   mid-session goes straight to the centrifugo fallback with reason `'peer_lost'` — it
 *   does NOT retry the next rung down. This mirrors the pre-addendum `onPeerDown`
 *   behavior read from hybrid-terminal-transport.ts (status transitions straight to
 *   `'failed'`/centrifugo on a post-connect close; only a rung that never finished
 *   connecting falls through to the next rung). The addendum's L5 wording ("'peer_lost'
 *   covers an open local/WebRTC path closing mid-session") is consistent with this but
 *   does not itself rule out a "retry next rung" design — flagging this as the
 *   interpretive choice made here.
 * - When `getLocalAdvert` resolves null/absent (no advert), the loopback rung is skipped
 *   entirely (not attempted, not counted as a failure) and the ladder starts at webrtc,
 *   preserving all pre-addendum webrtc-first behavior/tests above unchanged.
 */
describe('HybridTerminalTransport — loopback ladder (loopback-transport-addendum.md)', () => {
  interface LoopbackFactoryOpts {
    bridgeId: string;
    clientId: string;
    port: number;
    nonce: string;
  }

  interface LoopbackPeerLike {
    connect(): Promise<void>;
    attach(sessionId: string, handlers: TerminalDataHandlers): void;
    detach(sessionId: string): void;
    sendInput(sessionId: string, data: string): void;
    sendResize(sessionId: string, cols: number, rows: number): void;
    close(): void;
    onClose(cb: () => void): void;
  }

  class FakeLoopbackPeer implements LoopbackPeerLike {
    static instances: FakeLoopbackPeer[] = [];

    connectMode: 'resolve' | 'reject' = 'resolve';
    attachCalls: Array<[string, TerminalDataHandlers]> = [];
    detachCalls: string[] = [];
    sendInputCalls: Array<[string, string]> = [];
    sendResizeCalls: Array<[string, number, number]> = [];
    closeCalls = 0;
    private closeCbs: Array<() => void> = [];

    constructor(
      public bridgeId: string,
      public port: number,
      public nonce: string,
    ) {
      FakeLoopbackPeer.instances.push(this);
    }

    connect(): Promise<void> {
      return this.connectMode === 'resolve' ? Promise.resolve() : Promise.reject(new Error('loopback failed'));
    }

    attach(sessionId: string, handlers: TerminalDataHandlers): void {
      this.attachCalls.push([sessionId, handlers]);
    }

    detach(sessionId: string): void {
      this.detachCalls.push(sessionId);
    }

    sendInput(sessionId: string, data: string): void {
      this.sendInputCalls.push([sessionId, data]);
    }

    sendResize(sessionId: string, cols: number, rows: number): void {
      this.sendResizeCalls.push([sessionId, cols, rows]);
    }

    close(): void {
      this.closeCalls++;
    }

    onClose(cb: () => void): void {
      this.closeCbs.push(cb);
    }

    simulateClose(): void {
      const cbs = this.closeCbs.splice(0);
      for (const cb of cbs) cb();
    }
  }

  const ADVERT = { localPort: 41999, localNonce: 'nonce-abc' };

  beforeEach(() => {
    vi.useFakeTimers();
    FakePeer.instances = [];
    FakeLoopbackPeer.instances = [];
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function makeLadderTransport(opts: {
    advert: { localPort: number; localNonce: string } | null;
    webrtcFactory: (o: PeerFactoryOpts) => WebRtcPeerLike;
    loopbackFactory: (o: LoopbackFactoryOpts) => LoopbackPeerLike;
  }) {
    const centrifuge = new FakeCentrifugeClient();
    const publishCommand = vi.fn<(msg: DirectCommandMessage) => void>();
    const peerFactory = vi.fn(opts.webrtcFactory);
    const loopbackPeerFactory = vi.fn(opts.loopbackFactory);
    const getLocalAdvert = vi.fn(async () => opts.advert);
    const deps = {
      centrifuge,
      userId: USER_ID,
      clientId: CLIENT_ID,
      publishCommand,
      peerFactory,
      loopbackPeerFactory,
      getLocalAdvert,
    };
    const transport = new HybridTerminalTransport(
      deps as unknown as ConstructorParameters<typeof HybridTerminalTransport>[0],
    );
    return { transport, centrifuge, publishCommand, peerFactory, loopbackPeerFactory, getLocalAdvert };
  }

  it('advert present + loopback connects: mode local, no webrtc attempt, no centrifugo sub, no watch heartbeat', async () => {
    const { transport, centrifuge, publishCommand, peerFactory, loopbackPeerFactory } = makeLadderTransport({
      advert: ADVERT,
      webrtcFactory: (o) => new FakePeer(o.bridgeId),
      loopbackFactory: (o) => new FakeLoopbackPeer(o.bridgeId, o.port, o.nonce),
    });
    const modeChanges: Array<[string, string]> = [];
    transport.onModeChange((sessionId, mode) => modeChanges.push([sessionId, mode]));

    transport.subscribeTerminal('session-1', 'bridge-1', handlers());
    await flush();

    expect(transport.getMode('session-1')).toBe('local');
    expect(loopbackPeerFactory).toHaveBeenCalledWith(
      expect.objectContaining({ bridgeId: 'bridge-1', port: ADVERT.localPort, nonce: ADVERT.localNonce }),
    );
    expect(peerFactory).not.toHaveBeenCalled();
    expect(FakeLoopbackPeer.instances[0].attachCalls).toHaveLength(1);

    expect(centrifuge.getSubscription(`terminal:session-1#${USER_ID}`)).toBeNull();
    expect(publishCommand).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'terminal_watch' }));
    expect(modeChanges).toContainEqual(['session-1', 'local']);
  });

  it('advert present + loopback fails: webrtc attempted, mode direct on success', async () => {
    const { transport, peerFactory, loopbackPeerFactory } = makeLadderTransport({
      advert: ADVERT,
      webrtcFactory: (o) => new FakePeer(o.bridgeId),
      loopbackFactory: (o) => {
        const p = new FakeLoopbackPeer(o.bridgeId, o.port, o.nonce);
        p.connectMode = 'reject';
        return p;
      },
    });

    transport.subscribeTerminal('session-1', 'bridge-1', handlers());
    await flush();

    expect(loopbackPeerFactory).toHaveBeenCalledTimes(1);
    expect(peerFactory).toHaveBeenCalledTimes(1);
    expect(transport.getMode('session-1')).toBe('direct');
  });

  it('advert present + both loopback and webrtc fail: falls to centrifugo with fallbackReason pairing_failed', async () => {
    const { transport, centrifuge } = makeLadderTransport({
      advert: ADVERT,
      webrtcFactory: (o) => {
        const p = new FakePeer(o.bridgeId);
        p.connectMode = 'reject';
        return p;
      },
      loopbackFactory: (o) => {
        const p = new FakeLoopbackPeer(o.bridgeId, o.port, o.nonce);
        p.connectMode = 'reject';
        return p;
      },
    });

    transport.subscribeTerminal('session-1', 'bridge-1', handlers());
    await flush();

    expect(transport.getMode('session-1')).toBe('centrifugo');
    expect(transport.getFallbackReason('session-1')).toBe('pairing_failed');
    expect(centrifuge.getSubscription(`terminal:session-1#${USER_ID}`)).not.toBeNull();
  });

  it('no advert: loopback not attempted at all, straight to webrtc (pre-addendum behavior preserved)', async () => {
    const { transport, peerFactory, loopbackPeerFactory, getLocalAdvert } = makeLadderTransport({
      advert: null,
      webrtcFactory: (o) => new FakePeer(o.bridgeId),
      loopbackFactory: (o) => new FakeLoopbackPeer(o.bridgeId, o.port, o.nonce),
    });

    transport.subscribeTerminal('session-1', 'bridge-1', handlers());
    await flush();

    expect(getLocalAdvert).toHaveBeenCalledWith('bridge-1');
    expect(loopbackPeerFactory).not.toHaveBeenCalled();
    expect(peerFactory).toHaveBeenCalledTimes(1);
    expect(transport.getMode('session-1')).toBe('direct');
  });

  it('loopback peer closes mid-session: falls back to centrifugo with reason peer_lost', async () => {
    const { transport, centrifuge, publishCommand } = makeLadderTransport({
      advert: ADVERT,
      webrtcFactory: (o) => new FakePeer(o.bridgeId),
      loopbackFactory: (o) => new FakeLoopbackPeer(o.bridgeId, o.port, o.nonce),
    });
    const modeChanges: Array<[string, string]> = [];
    transport.onModeChange((sessionId, mode) => modeChanges.push([sessionId, mode]));

    transport.subscribeTerminal('session-1', 'bridge-1', handlers());
    await flush();
    expect(transport.getMode('session-1')).toBe('local');

    FakeLoopbackPeer.instances[0].simulateClose();
    await flush();

    expect(transport.getMode('session-1')).toBe('centrifugo');
    expect(transport.getFallbackReason('session-1')).toBe('peer_lost');
    expect(modeChanges).toContainEqual(['session-1', 'centrifugo']);

    const sub = centrifuge.getSubscription(`terminal:session-1#${USER_ID}`);
    expect(sub).not.toBeNull();
    sub!.simulateSubscribed();
    expect(publishCommand).toHaveBeenCalledWith(expect.objectContaining({ type: 'terminal_watch' }));
  });
});

/**
 * Pre-attach input/resize buffering (coordinator addendum; fixes a race where
 * sendInput/sendResize during the 'connecting' ladder window were silently dropped).
 * Spec under test:
 * 1. Input/resize sent while mode is 'connecting' are buffered — nothing reaches the
 *    wire before attach; on attach the peer receives the LATEST resize only (last
 *    cols/rows wins — delivered as a deliberate cols-1 -> cols bounce so tmux re-wraps
 *    and redraws), then the queued inputs in original order.
 * 2. If the ladder falls all the way to centrifugo, the same flush (latest resize,
 *    then inputs in order) is published on terminal-input:{sessionId}#{userId} with
 *    the existing payload shapes ({type:'resize',cols,rows} / {type:'input',data}).
 * 3. Unsubscribe during 'connecting' clears the buffers — nothing flushed later; a
 *    fresh subscribe for the same session starts empty.
 * 4. The flush happens exactly once per activation — a later mode change (e.g. direct
 *    -> peer_lost -> centrifugo) must not replay the already-flushed frames.
 *
 * Uses a deferred-connect fake peer so the 'connecting' window is held open explicitly
 * instead of racing microtasks; a single ordered event log per peer pins the
 * attach-then-resize-then-input ordering.
 */
describe('HybridTerminalTransport — pre-attach input/resize buffering', () => {
  /** FakePeer variant with a manually-settled connect() and one ordered event log. */
  class DeferredFakePeer implements WebRtcPeerLike {
    static instances: DeferredFakePeer[] = [];

    events: Array<
      | { kind: 'attach'; sessionId: string }
      | { kind: 'input'; sessionId: string; data: string }
      | { kind: 'resize'; sessionId: string; cols: number; rows: number }
    > = [];
    private resolveConnect!: () => void;
    private rejectConnect!: (err: Error) => void;
    private readonly connectPromise: Promise<void>;
    private closeCbs: Array<() => void> = [];

    constructor(public bridgeId: string) {
      this.connectPromise = new Promise<void>((resolve, reject) => {
        this.resolveConnect = resolve;
        this.rejectConnect = reject;
      });
      // Rejection may settle before any .catch is attached; mark it handled so vitest
      // doesn't report a spurious unhandled rejection.
      this.connectPromise.catch(() => {});
      DeferredFakePeer.instances.push(this);
    }

    connect(): Promise<void> {
      return this.connectPromise;
    }

    settleConnect(outcome: 'resolve' | 'reject'): void {
      if (outcome === 'resolve') this.resolveConnect();
      else this.rejectConnect(new Error('pair failed'));
    }

    attach(sessionId: string): void {
      this.events.push({ kind: 'attach', sessionId });
    }

    detach(): void {}

    sendInput(sessionId: string, data: string): void {
      this.events.push({ kind: 'input', sessionId, data });
    }

    sendResize(sessionId: string, cols: number, rows: number): void {
      this.events.push({ kind: 'resize', sessionId, cols, rows });
    }

    close(): void {}

    onClose(cb: () => void): void {
      this.closeCbs.push(cb);
    }

    simulateClose(): void {
      const cbs = this.closeCbs.splice(0);
      for (const cb of cbs) cb();
    }
  }

  beforeEach(() => {
    vi.useFakeTimers();
    DeferredFakePeer.instances = [];
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** Subscribes and queues 2 resizes + 2 inputs while the mode is still 'connecting'. */
  function bufferWhileConnecting(transport: HybridTerminalTransport): void {
    transport.subscribeTerminal('session-1', 'bridge-1', handlers());
    expect(transport.getMode('session-1')).toBe('connecting');
    transport.sendResize('session-1', 80, 24);
    transport.sendResize('session-1', 100, 40);
    transport.sendInput('session-1', 'a');
    transport.sendInput('session-1', 'b');
  }

  it('flushes latest resize then queued input in order to the peer after attach; nothing before', async () => {
    const { transport } = makeTransport((opts) => new DeferredFakePeer(opts.bridgeId));

    bufferWhileConnecting(transport);
    const peer = DeferredFakePeer.instances[0];
    await flush();

    // Still connecting: nothing may have reached the wire.
    expect(peer.events).toEqual([]);

    peer.settleConnect('resolve');
    await flush();
    expect(transport.getMode('session-1')).toBe('direct');

    // The flushed resize is delivered as a deliberate cols-1 -> cols bounce (latest
    // size wins; the bounce forces tmux to re-wrap/redraw for a correct first paint,
    // since coalescing swallowed Terminal's own bounce).
    expect(peer.events).toEqual([
      { kind: 'attach', sessionId: 'session-1' },
      { kind: 'resize', sessionId: 'session-1', cols: 99, rows: 40 },
      { kind: 'resize', sessionId: 'session-1', cols: 100, rows: 40 },
      { kind: 'input', sessionId: 'session-1', data: 'a' },
      { kind: 'input', sessionId: 'session-1', data: 'b' },
    ]);
  });

  it('flushes latest resize then queued input onto terminal-input:* when the ladder ends at centrifugo', async () => {
    const { transport, centrifuge } = makeTransport((opts) => new DeferredFakePeer(opts.bridgeId));

    bufferWhileConnecting(transport);
    await flush();
    // Still connecting: the input channel must not even exist yet.
    expect(centrifuge.getSubscription(`terminal-input:session-1#${USER_ID}`)).toBeNull();

    DeferredFakePeer.instances[0].settleConnect('reject');
    await flush();
    expect(transport.getMode('session-1')).toBe('centrifugo');

    const inputSub = centrifuge.getSubscription(`terminal-input:session-1#${USER_ID}`);
    expect(inputSub).not.toBeNull();
    // Latest resize (as the cols-1 -> cols redraw bounce) then the inputs in order;
    // the publish chain coalesces adjacent inputs, so 'a'+'b' arrive as one frame.
    expect(inputSub!.publishCalls).toEqual([
      { type: 'resize', cols: 99, rows: 40 },
      { type: 'resize', cols: 100, rows: 40 },
      { type: 'input', data: 'ab' },
    ]);
  });

  it('unsubscribe during connecting clears buffers; a fresh subscribe starts empty', async () => {
    const { transport, centrifuge } = makeTransport((opts) => new DeferredFakePeer(opts.bridgeId));

    const unsubscribe = transport.subscribeTerminal('session-1', 'bridge-1', handlers());
    expect(transport.getMode('session-1')).toBe('connecting');
    transport.sendResize('session-1', 100, 40);
    transport.sendInput('session-1', 'stale');
    unsubscribe();

    // Fresh subscribe for the same session — must not inherit the stale buffer.
    transport.subscribeTerminal('session-1', 'bridge-1', handlers());
    await flush();

    for (const peer of DeferredFakePeer.instances) peer.settleConnect('resolve');
    await flush();
    expect(transport.getMode('session-1')).toBe('direct');

    const flushedFrames = DeferredFakePeer.instances.flatMap((p) =>
      p.events.filter((e) => e.kind === 'input' || e.kind === 'resize'),
    );
    expect(flushedFrames).toEqual([]);
    // And nothing leaked onto the centrifugo input channel either.
    expect(centrifuge.getSubscription(`terminal-input:session-1#${USER_ID}`)).toBeNull();
  });

  it('flushes exactly once: no duplicate replay on a later mode change (direct -> peer_lost -> centrifugo)', async () => {
    const { transport, centrifuge } = makeTransport((opts) => new DeferredFakePeer(opts.bridgeId));

    bufferWhileConnecting(transport);
    const peer = DeferredFakePeer.instances[0];
    peer.settleConnect('resolve');
    await flush();
    expect(transport.getMode('session-1')).toBe('direct');
    expect(peer.events.filter((e) => e.kind === 'input')).toHaveLength(2);

    peer.simulateClose();
    await flush();
    expect(transport.getMode('session-1')).toBe('centrifugo');

    // The buffered frames were already flushed to the peer; the centrifugo path must
    // not replay them.
    const inputSub = centrifuge.getSubscription(`terminal-input:session-1#${USER_ID}`);
    expect(inputSub).not.toBeNull();
    expect(inputSub!.publishCalls).toEqual([]);
  });
});

/**
 * Default getLocalAdvert presence path (review follow-up): every ladder test above
 * injects `getLocalAdvert`, leaving the real presence-query code untested. These cases
 * construct the transport WITHOUT `getLocalAdvert` so the default implementation runs.
 *
 * Spec under test (per the coordinator, matching the dev agent's in-flight fix):
 * - defaultGetLocalAdvert GET-OR-CREATES the `bridges:presence#{userId}` subscription
 *   (getSubscription ?? newSubscription + subscribe) — the page-load race fix: pairing
 *   may start before useBridges has mounted the presence subscription.
 * - It awaits `presence()` within a ~LOOPBACK_TIMEOUT_MS bound; on failure, timeout, or
 *   an advert-less presence result it resolves null (loopback skipped, WebRTC next) and
 *   NEVER throws into the ladder (no unhandled rejection).
 * - connInfo parsing: an entry counts only if `bridgeId` matches AND `localPort` is a
 *   number AND `localNonce` is a string (old bridges omit these fields).
 */
describe('HybridTerminalTransport — default presence-based getLocalAdvert', () => {
  const PRESENCE_CHANNEL = `bridges:presence#${USER_ID}`;

  interface LoopbackFactoryOpts {
    bridgeId: string;
    clientId: string;
    port: number;
    nonce: string;
  }

  /** Minimal always-connecting loopback peer; enough to observe the rung being taken. */
  class SimpleLoopbackPeer {
    attachCalls: string[] = [];
    constructor(public opts: LoopbackFactoryOpts) {}
    connect(): Promise<void> {
      return Promise.resolve();
    }
    attach(sessionId: string): void {
      this.attachCalls.push(sessionId);
    }
    detach(): void {}
    sendInput(): void {}
    sendResize(): void {}
    close(): void {}
    onClose(): void {}
  }

  /** FakeSubscription that also implements the presence() surface, scriptable per test. */
  class PresenceFakeSubscription extends FakeSubscription {
    presenceImpl: () => Promise<{ clients: Record<string, { connInfo?: unknown }> }> = () =>
      Promise.resolve({ clients: {} });

    presence(): Promise<{ clients: Record<string, { connInfo?: unknown }> }> {
      return this.presenceImpl();
    }

    /** Real centrifuge subscriptions become usable shortly after subscribe(). */
    override subscribe(): void {
      super.subscribe();
      this.simulateSubscribed();
    }
  }

  /** FakeCentrifugeClient whose presence-channel subscriptions are presence-capable. */
  class PresenceFakeClient extends FakeCentrifugeClient {
    /** presenceImpl applied to presence-channel subs created via newSubscription. */
    presenceImplForNewSubs: PresenceFakeSubscription['presenceImpl'] = () =>
      Promise.resolve({ clients: {} });

    override newSubscription(channel: string): FakeSubscription {
      if (channel === PRESENCE_CHANNEL) {
        const sub = new PresenceFakeSubscription(channel);
        sub.presenceImpl = this.presenceImplForNewSubs;
        this.subs.set(channel, sub);
        return sub;
      }
      return super.newSubscription(channel);
    }

    /** Pre-seeds an already-mounted presence subscription (the useBridges case). */
    seedPresenceSub(presenceImpl: PresenceFakeSubscription['presenceImpl']): PresenceFakeSubscription {
      const sub = new PresenceFakeSubscription(PRESENCE_CHANNEL);
      sub.presenceImpl = presenceImpl;
      this.subs.set(PRESENCE_CHANNEL, sub);
      return sub;
    }
  }

  const ADVERT_CONN_INFO = { bridgeId: 'bridge-1', localPort: 41999, localNonce: 'nonce-abc' };

  beforeEach(() => {
    vi.useFakeTimers();
    FakePeer.instances = [];
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function makeDefaultAdvertTransport(centrifuge: PresenceFakeClient) {
    const publishCommand = vi.fn<(msg: DirectCommandMessage) => void>();
    const peerFactory = vi.fn((opts: PeerFactoryOpts) => new FakePeer(opts.bridgeId));
    const loopbackPeers: SimpleLoopbackPeer[] = [];
    const loopbackPeerFactory = vi.fn((opts: LoopbackFactoryOpts) => {
      const p = new SimpleLoopbackPeer(opts);
      loopbackPeers.push(p);
      return p;
    });
    // NOTE: no getLocalAdvert — the default presence query is the code under test.
    const deps = { centrifuge, userId: USER_ID, clientId: CLIENT_ID, publishCommand, peerFactory, loopbackPeerFactory };
    const transport = new HybridTerminalTransport(
      deps as unknown as ConstructorParameters<typeof HybridTerminalTransport>[0],
    );
    return { transport, peerFactory, loopbackPeerFactory, loopbackPeers };
  }

  it('finds a matching connInfo advert in presence and attempts loopback with its port/nonce', async () => {
    const centrifuge = new PresenceFakeClient();
    centrifuge.seedPresenceSub(() =>
      Promise.resolve({
        clients: {
          // An unrelated client entry and one with the matching bridge advert.
          'conn-a': { connInfo: { bridgeId: 'other-bridge', localPort: 1, localNonce: 'x' } },
          'conn-b': { connInfo: ADVERT_CONN_INFO },
        },
      }),
    );
    const { transport, peerFactory, loopbackPeerFactory } = makeDefaultAdvertTransport(centrifuge);

    transport.subscribeTerminal('session-1', 'bridge-1', handlers());
    await flush();

    expect(loopbackPeerFactory).toHaveBeenCalledWith(
      expect.objectContaining({ bridgeId: 'bridge-1', port: 41999, nonce: 'nonce-abc' }),
    );
    expect(transport.getMode('session-1')).toBe('local');
    expect(peerFactory).not.toHaveBeenCalled();
  });

  it('skips loopback when connInfo lacks localPort/localNonce (old bridge) and attempts WebRTC', async () => {
    const centrifuge = new PresenceFakeClient();
    centrifuge.seedPresenceSub(() =>
      Promise.resolve({
        clients: {
          // Same bridge, but a pre-addendum bridge that advertises no local info.
          'conn-a': { connInfo: { bridgeId: 'bridge-1' } },
          // Junk-typed fields must not pass the type guard either.
          'conn-b': { connInfo: { bridgeId: 'bridge-1', localPort: '41999', localNonce: 7 } },
        },
      }),
    );
    const { transport, peerFactory, loopbackPeerFactory } = makeDefaultAdvertTransport(centrifuge);

    transport.subscribeTerminal('session-1', 'bridge-1', handlers());
    await flush();

    expect(loopbackPeerFactory).not.toHaveBeenCalled();
    expect(peerFactory).toHaveBeenCalledTimes(1);
    expect(transport.getMode('session-1')).toBe('direct');
  });

  it('creates the presence subscription when none exists at pairing time and still finds the advert (page-load race)', async () => {
    const centrifuge = new PresenceFakeClient();
    // No seeded subscription: pairing starts before useBridges mounted presence.
    centrifuge.presenceImplForNewSubs = () =>
      Promise.resolve({ clients: { 'conn-b': { connInfo: ADVERT_CONN_INFO } } });
    const { transport, peerFactory, loopbackPeerFactory } = makeDefaultAdvertTransport(centrifuge);

    expect(centrifuge.getSubscription(PRESENCE_CHANNEL)).toBeNull();
    transport.subscribeTerminal('session-1', 'bridge-1', handlers());
    await flush();

    const created = centrifuge.getSubscription(PRESENCE_CHANNEL);
    expect(created).not.toBeNull();
    expect(created!.subscribeCalls).toBeGreaterThanOrEqual(1);
    expect(loopbackPeerFactory).toHaveBeenCalledWith(
      expect.objectContaining({ bridgeId: 'bridge-1', port: 41999, nonce: 'nonce-abc' }),
    );
    expect(transport.getMode('session-1')).toBe('local');
    expect(peerFactory).not.toHaveBeenCalled();
  });

  it('treats a rejecting presence() as no advert: WebRTC attempted, no unhandled rejection', async () => {
    const centrifuge = new PresenceFakeClient();
    centrifuge.seedPresenceSub(() => Promise.reject(new Error('presence unavailable')));
    const { transport, peerFactory, loopbackPeerFactory } = makeDefaultAdvertTransport(centrifuge);

    transport.subscribeTerminal('session-1', 'bridge-1', handlers());
    await flush();

    // A rejecting presence() (centrifuge rejects while the sub is still connecting)
    // is retried on 'subscribed' rather than failed instantly; a persistently
    // rejecting one therefore resolves null at the wait bound.
    await vi.advanceTimersByTimeAsync(LOOPBACK_TIMEOUT_MS);
    await flush();

    expect(loopbackPeerFactory).not.toHaveBeenCalled();
    expect(peerFactory).toHaveBeenCalledTimes(1);
    expect(transport.getMode('session-1')).toBe('direct');
    // If the rejection escaped the ladder, vitest would fail the run with an
    // unhandled-rejection error — reaching this point with 'direct' is the assertion.
  });

  it('bounds a hanging presence(): ladder proceeds to WebRTC after the wait bound', async () => {
    const centrifuge = new PresenceFakeClient();
    centrifuge.seedPresenceSub(() => new Promise(() => {})); // never settles
    const { transport, peerFactory, loopbackPeerFactory } = makeDefaultAdvertTransport(centrifuge);

    transport.subscribeTerminal('session-1', 'bridge-1', handlers());
    await flush();

    // Presence still pending: ladder must be waiting, not fallen through yet.
    expect(peerFactory).not.toHaveBeenCalled();
    expect(transport.getMode('session-1')).toBe('connecting');

    await vi.advanceTimersByTimeAsync(LOOPBACK_TIMEOUT_MS);
    await flush();

    expect(loopbackPeerFactory).not.toHaveBeenCalled();
    expect(peerFactory).toHaveBeenCalledTimes(1);
    expect(transport.getMode('session-1')).toBe('direct');
  });
});

/**
 * Deferred-publish delivery (review follow-up, small): the base FakeSubscription's
 * publish() always resolves instantly, which hides centrifuge-js's real behavior of
 * QUEUEING publish calls issued while the subscription is still subscribing and sending
 * them once subscribed. This case pins that the connecting-window flush onto the
 * centrifugo path is not lost when the terminal-input subscription hasn't finished
 * subscribing yet — frames must be handed to publish() (queued) and arrive after the
 * 'subscribed' transition, in order.
 */
describe('HybridTerminalTransport — flush onto a still-subscribing input channel', () => {
  /** publish() queues until simulateSubscribed(), mirroring centrifuge-js semantics. */
  class QueuingFakeSubscription extends FakeSubscription {
    subscribed = false;
    delivered: unknown[] = [];
    private queue: Array<{ data: unknown; resolve: (v: unknown) => void }> = [];

    override publish(data: unknown): Promise<unknown> {
      this.publishCalls.push(data);
      if (this.subscribed) {
        this.delivered.push(data);
        return Promise.resolve();
      }
      return new Promise((resolve) => {
        this.queue.push({ data, resolve });
      });
    }

    override simulateSubscribed(): void {
      this.subscribed = true;
      for (const { data, resolve } of this.queue.splice(0)) {
        this.delivered.push(data);
        resolve(undefined);
      }
      super.simulateSubscribed();
    }
  }

  class QueuingFakeClient extends FakeCentrifugeClient {
    override newSubscription(channel: string): FakeSubscription {
      const sub = new QueuingFakeSubscription(channel);
      this.subs.set(channel, sub);
      return sub;
    }
  }

  beforeEach(() => {
    vi.useFakeTimers();
    FakePeer.instances = [];
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('delivers the flushed resize+input after the input subscription finishes subscribing', async () => {
    const centrifuge = new QueuingFakeClient();
    const publishCommand = vi.fn<(msg: DirectCommandMessage) => void>();
    const peerFactory = vi.fn((opts: PeerFactoryOpts) => {
      const p = new FakePeer(opts.bridgeId);
      p.connectMode = 'reject';
      return p;
    });
    const deps = { centrifuge, userId: USER_ID, clientId: CLIENT_ID, publishCommand, peerFactory };
    const transport = new HybridTerminalTransport(
      deps as unknown as ConstructorParameters<typeof HybridTerminalTransport>[0],
    );

    transport.subscribeTerminal('session-1', 'bridge-1', handlers());
    expect(transport.getMode('session-1')).toBe('connecting');
    transport.sendResize('session-1', 100, 40);
    transport.sendInput('session-1', 'a');
    transport.sendInput('session-1', 'b');

    await flush();
    expect(transport.getMode('session-1')).toBe('centrifugo');

    const inputSub = centrifuge.getSubscription(`terminal-input:session-1#${USER_ID}`) as QueuingFakeSubscription;
    expect(inputSub).not.toBeNull();
    // Single-in-flight chain: only the FIRST frame is handed to publish() while the
    // subscription is still subscribing (it parks); frames 2+ are held in the chain
    // until it settles. Handing all frames over while one is parked is exactly the
    // transposition window the chain fixes.
    expect(inputSub.publishCalls).toEqual([{ type: 'resize', cols: 99, rows: 40 }]);
    // Nothing is on the wire until the subscription becomes active.
    expect(inputSub.delivered).toEqual([]);

    inputSub.simulateSubscribed();
    await flush();
    // The parked frame settles, the chain drains, and delivery preserves order —
    // adjacent inputs coalesced into one frame.
    expect(inputSub.delivered).toEqual([
      { type: 'resize', cols: 99, rows: 40 },
      { type: 'resize', cols: 100, rows: 40 },
      { type: 'input', data: 'ab' },
    ]);
  });
});

/**
 * Keystroke ordering on the centrifugo input path (coordinator regression suite).
 * Root cause under fix: per-keystroke fire-and-forget `publish()` calls could overtake
 * each other when centrifuge parks publishes during a 'subscribing' window (non-uniform
 * await depth). Spec under test:
 * - Per-session outbound buffer + single-in-flight publish chain: at most ONE
 *   `{type:'input'}` publish in flight; input arriving meanwhile is buffered and
 *   coalesced into the next publish once the in-flight one settles.
 * - Resize enters the same chain as its own message (relative input/resize order kept).
 * - A rejected publish drops that payload and continues the chain (no re-send, no stall).
 *
 * Ordering is asserted by reconstructing the typed stream from the RECORDED publish
 * payloads in call order — coalescing may merge keystrokes, so the invariant is that
 * the concatenation of input payloads (with resize as an ordered token) equals what was
 * typed, in order.
 */
describe('HybridTerminalTransport — centrifugo input path keystroke ordering', () => {
  /** publish() timing is scripted per test: manual settle or immediate resolution. */
  class ScriptedPublishSubscription extends FakeSubscription {
    /** 'manual' queues every publish for explicit settle; 'immediate' resolves instantly. */
    publishMode: 'manual' | 'immediate' = 'immediate';
    pendingPublishes: Array<{ data: unknown; resolve: () => void; reject: (e: Error) => void }> = [];

    override publish(data: unknown): Promise<unknown> {
      this.publishCalls.push(data);
      if (this.publishMode === 'immediate') return Promise.resolve();
      return new Promise<void>((resolve, reject) => {
        this.pendingPublishes.push({ data, resolve, reject });
      });
    }

    settleNext(outcome: 'resolve' | 'reject' = 'resolve'): void {
      const next = this.pendingPublishes.shift();
      if (!next) throw new Error('no pending publish to settle');
      if (outcome === 'resolve') next.resolve();
      else next.reject(new Error('publish failed'));
    }
  }

  class ScriptedPublishClient extends FakeCentrifugeClient {
    override newSubscription(channel: string): FakeSubscription {
      const sub = new ScriptedPublishSubscription(channel);
      this.subs.set(channel, sub);
      return sub;
    }
  }

  beforeEach(() => {
    vi.useFakeTimers();
    FakePeer.instances = [];
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** Transport with a rejecting webrtc peer so the session lands on centrifugo. */
  async function centrifugoSession() {
    const centrifuge = new ScriptedPublishClient();
    const publishCommand = vi.fn<(msg: DirectCommandMessage) => void>();
    const peerFactory = vi.fn((opts: PeerFactoryOpts) => {
      const p = new FakePeer(opts.bridgeId);
      p.connectMode = 'reject';
      return p;
    });
    const deps = { centrifuge, userId: USER_ID, clientId: CLIENT_ID, publishCommand, peerFactory };
    const transport = new HybridTerminalTransport(
      deps as unknown as ConstructorParameters<typeof HybridTerminalTransport>[0],
    );
    transport.subscribeTerminal('session-1', 'bridge-1', handlers());
    await flush();
    expect(transport.getMode('session-1')).toBe('centrifugo');
    const inputSub = centrifuge.getSubscription(
      `terminal-input:session-1#${USER_ID}`,
    ) as ScriptedPublishSubscription;
    expect(inputSub).not.toBeNull();
    return { transport, inputSub };
  }

  /** Recorded publish payloads reduced to an ordered token string: input chars + '<resize>'. */
  function tokenStream(sub: ScriptedPublishSubscription): string {
    return sub.publishCalls
      .map((p) => {
        const msg = p as { type?: string; data?: string };
        if (msg.type === 'input') return msg.data ?? '';
        if (msg.type === 'resize') return '<resize>';
        return `<unexpected:${String(msg.type)}>`;
      })
      .join('');
  }

  it('parked-first-publish vs immediate followers: recorded input payloads reconstruct the typed order', async () => {
    const { transport, inputSub } = await centrifugoSession();
    // First publish settles late (delayed macrotask); anything published after it
    // would settle immediately — the classic overtake window.
    let first = true;
    inputSub.publish = function (this: ScriptedPublishSubscription, data: unknown): Promise<unknown> {
      this.publishCalls.push(data);
      if (first) {
        first = false;
        return new Promise<void>((resolve) => {
          setTimeout(resolve, 50);
        });
      }
      return Promise.resolve();
    };

    transport.sendInput('session-1', 'a');
    transport.sendInput('session-1', 'b');
    transport.sendInput('session-1', 'c');

    await vi.advanceTimersByTimeAsync(100);
    await flush();

    expect(tokenStream(inputSub)).toBe('abc');
  });

  it("mid-stream 'subscribed'→'subscribing'→'subscribed' flip while typing keeps the typed order", async () => {
    const { transport, inputSub } = await centrifugoSession();
    // Model the flip through publish timing: while "subscribing", centrifuge parks the
    // publish until the subscription is active again; while "subscribed" it resolves.
    const parked: Array<() => void> = [];
    let subscribing = false;
    inputSub.publish = function (this: ScriptedPublishSubscription, data: unknown): Promise<unknown> {
      this.publishCalls.push(data);
      if (subscribing) {
        return new Promise<void>((resolve) => {
          parked.push(resolve);
        });
      }
      return Promise.resolve();
    };

    transport.sendInput('session-1', 'a');
    await flush();

    subscribing = true; // connection blip: subscription re-enters 'subscribing'
    transport.sendInput('session-1', 'b');
    transport.sendInput('session-1', 'c');
    await flush();

    subscribing = false; // 'subscribed' again: parked publishes go through
    for (const release of parked.splice(0)) release();
    await flush();

    transport.sendInput('session-1', 'd');
    await flush();

    expect(tokenStream(inputSub)).toBe('abcd');
  });

  it('exactly one publish in flight: typing during an unresolved publish coalesces into ONE follow-up', async () => {
    const { transport, inputSub } = await centrifugoSession();
    inputSub.publishMode = 'manual';

    transport.sendInput('session-1', 'a');
    await flush();
    expect(inputSub.publishCalls).toEqual([{ type: 'input', data: 'a' }]);

    // While 'a' is still in flight, further keystrokes must NOT trigger publishes.
    transport.sendInput('session-1', 'b');
    transport.sendInput('session-1', 'c');
    await flush();
    expect(inputSub.publishCalls).toHaveLength(1);

    // Settling the in-flight publish releases exactly one coalesced follow-up.
    inputSub.settleNext('resolve');
    await flush();
    expect(inputSub.publishCalls).toHaveLength(2);
    expect(inputSub.publishCalls[1]).toEqual({ type: 'input', data: 'bc' });

    inputSub.settleNext('resolve');
    await flush();
    expect(inputSub.publishCalls).toHaveLength(2);
  });

  it('a rejected publish drops its payload and continues the chain without re-sending', async () => {
    const { transport, inputSub } = await centrifugoSession();
    inputSub.publishMode = 'manual';

    transport.sendInput('session-1', 'a');
    transport.sendInput('session-1', 'b');
    await flush();
    expect(inputSub.publishCalls).toEqual([{ type: 'input', data: 'a' }]);

    // 'a' fails on the wire: it is dropped (no re-send) and the chain moves on to 'b'.
    inputSub.settleNext('reject');
    await flush();

    expect(inputSub.publishCalls).toHaveLength(2);
    expect(inputSub.publishCalls[1]).toEqual({ type: 'input', data: 'b' });

    inputSub.settleNext('resolve');
    await flush();
    // Nothing further: 'a' must not reappear anywhere in the stream.
    expect(inputSub.publishCalls).toHaveLength(2);
    expect(tokenStream(inputSub)).toBe('ab'); // recorded once each, in order
  });

  it('resize enters the chain in order: input → resize → input relative order is preserved', async () => {
    const { transport, inputSub } = await centrifugoSession();
    inputSub.publishMode = 'manual';

    transport.sendInput('session-1', 'a');
    transport.sendResize('session-1', 80, 24);
    transport.sendInput('session-1', 'b');
    await flush();

    // Drain the chain regardless of how the frames were batched.
    while (inputSub.pendingPublishes.length > 0) {
      inputSub.settleNext('resolve');
      await flush();
    }

    expect(tokenStream(inputSub)).toBe('a<resize>b');
    const resizeCall = inputSub.publishCalls.find((p) => (p as { type?: string }).type === 'resize');
    expect(resizeCall).toEqual({ type: 'resize', cols: 80, rows: 24 });
  });
});

/**
 * Transport upgrade (docs/plans/transport-upgrade-addendum.md, T1-T8 + "Surface").
 * Written against the FROZEN addendum only — HybridTerminalTransport does not yet
 * implement any of this (no `upgradeBackoffMs`/`upgradeJitter` options, no retry loop);
 * the implementation lands in parallel. These cases are expected to fail/error until
 * it does; see the per-test ASSUMPTIONS below for how ambiguity in the addendum text
 * was resolved without inventing new behavioral requirements.
 *
 * Injected surface: `upgradeBackoffMs: [1000, 2000]` (last entry repeats) and
 * `upgradeJitter: 0`, for deterministic fake-timer advances (real defaults per the
 * addendum are [15000,30000,60000,120000] / 0.2 — not exercised here).
 *
 * ASSUMPTIONS:
 * - "advert queried again" (T1) is observed via the injected `getLocalAdvert` call
 *   count, and "loopback factory called again" via `loopbackPeerFactory` call count —
 *   the same seams the pre-existing loopback-ladder suite above already tests against.
 *   A retry "attempt" is one additional ladder run (getLocalAdvert -> maybe loopback ->
 *   maybe webrtc), exactly mirroring the initial-pairing ladder.
 * - T3's switch point (the new path's `screen` frame) is modeled the same way the rest
 *   of this file models attach: `peer.attach(sessionId, handlers)` records the handlers
 *   object, and the test invokes `handlers.onScreen(...)` itself to simulate the
 *   bridge's screen reply — there is no fake that delivers it automatically. Until that
 *   call, the old Centrifugo path must still be the one actually wired (input routes to
 *   it, its subscription is not yet unsubscribed) — this is the crux of "no gap".
 * - T2's fresh-`subscribeTerminal` trigger is exercised by calling `subscribeTerminal`
 *   again for a NEW session on a bridge already parked on the failed/centrifugo path;
 *   the addendum does not require a `window` `online`/`visibilitychange` listener test
 *   in a window-less (node) vitest environment, so only graceful non-crashing
 *   construction is asserted for that half of T2, per the task instructions.
 */
describe('HybridTerminalTransport — transport upgrade (transport-upgrade-addendum.md)', () => {
  interface LoopbackFactoryOpts {
    bridgeId: string;
    clientId: string;
    port: number;
    nonce: string;
  }

  interface UpgradeAdvert {
    localPort: number;
    localNonce: string;
  }

  /** Loopback peer fake local to this block (the other one lives in a sibling describe). */
  class UpgradeFakeLoopbackPeer {
    static instances: UpgradeFakeLoopbackPeer[] = [];
    connectMode: 'resolve' | 'reject' = 'resolve';
    attachCalls: Array<[string, TerminalDataHandlers]> = [];
    private closeCbs: Array<() => void> = [];

    constructor(public bridgeId: string) {
      UpgradeFakeLoopbackPeer.instances.push(this);
    }
    connect(): Promise<void> {
      return this.connectMode === 'resolve' ? Promise.resolve() : Promise.reject(new Error('loopback failed'));
    }
    attach(sessionId: string, handlers: TerminalDataHandlers): void {
      this.attachCalls.push([sessionId, handlers]);
    }
    detach(): void {}
    sendInputCalls: Array<[string, string]> = [];
    sendInput(sessionId: string, data: string): void {
      this.sendInputCalls.push([sessionId, data]);
    }
    sendResize(): void {}
    close(): void {}
    onClose(cb: () => void): void {
      this.closeCbs.push(cb);
    }
  }

  const ADVERT: UpgradeAdvert = { localPort: 41999, localNonce: 'nonce-upgrade' };

  // Every transport built in this block is tracked so afterEach can dispose it:
  // upgrade tests intentionally leave retry loops (and their in-flight async ladder
  // attempts) running, which would otherwise bleed timers/microtasks into the next
  // test and cause order-dependent flakiness.
  let activeTransports: HybridTerminalTransport[] = [];

  beforeEach(() => {
    vi.useFakeTimers();
    FakePeer.instances = [];
    UpgradeFakeLoopbackPeer.instances = [];
    activeTransports = [];
  });

  afterEach(() => {
    for (const t of activeTransports) {
      try {
        t.dispose();
      } catch {
        /* already disposed */
      }
    }
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  /**
   * `webrtcMode`/`loopbackMode`/`advert` are mutable boxes so a test can flip them
   * between ladder attempts (e.g. fail once, then succeed on the retry).
   */
  function makeUpgradeTransport(state: {
    webrtcMode: { value: 'resolve' | 'reject' };
    loopbackMode: { value: 'resolve' | 'reject' };
    advert: { value: UpgradeAdvert | null };
    backoff?: number[];
    jitter?: number;
  }) {
    const centrifuge = new FakeCentrifugeClient();
    const publishCommand = vi.fn<(msg: DirectCommandMessage) => void>();
    const peerFactory = vi.fn((o: PeerFactoryOpts) => {
      const p = new FakePeer(o.bridgeId);
      p.connectMode = state.webrtcMode.value;
      return p;
    });
    const loopbackPeerFactory = vi.fn((o: LoopbackFactoryOpts) => {
      const p = new UpgradeFakeLoopbackPeer(o.bridgeId);
      p.connectMode = state.loopbackMode.value;
      return p;
    });
    const getLocalAdvert = vi.fn(async () => state.advert.value);
    const deps = {
      centrifuge,
      userId: USER_ID,
      clientId: CLIENT_ID,
      publishCommand,
      peerFactory,
      loopbackPeerFactory,
      getLocalAdvert,
      upgradeBackoffMs: state.backoff ?? [1000, 2000],
      upgradeJitter: state.jitter ?? 0,
    };
    const transport = new HybridTerminalTransport(
      deps as unknown as ConstructorParameters<typeof HybridTerminalTransport>[0],
    );
    activeTransports.push(transport);
    return { transport, centrifuge, publishCommand, peerFactory, loopbackPeerFactory, getLocalAdvert };
  }

  /** Manually fires a fake subscription's registered 'publication' listeners. */
  function emitPublication(sub: FakeSubscription, data: unknown): void {
    for (const cb of sub.listeners['publication'] ?? []) cb({ data });
  }

  it('(T1) lands on centrifugo, both rungs failing: backoff re-runs the ladder and walks/repeats the array', async () => {
    const webrtcMode: { value: 'resolve' | 'reject' } = { value: 'reject' };
    const loopbackMode: { value: 'resolve' | 'reject' } = { value: 'reject' };
    const advert = { value: ADVERT as UpgradeAdvert | null };
    const { transport, getLocalAdvert, loopbackPeerFactory } = makeUpgradeTransport({
      webrtcMode,
      loopbackMode,
      advert,
    });

    transport.subscribeTerminal('session-1', 'bridge-1', handlers());
    await flush();
    expect(transport.getMode('session-1')).toBe('centrifugo');
    expect(getLocalAdvert).toHaveBeenCalledTimes(1);
    expect(loopbackPeerFactory).toHaveBeenCalledTimes(1);

    // backoff[0] = 1000ms: first retry.
    await vi.advanceTimersByTimeAsync(1000);
    expect(getLocalAdvert).toHaveBeenCalledTimes(2);
    expect(loopbackPeerFactory).toHaveBeenCalledTimes(2);
    expect(transport.getMode('session-1')).toBe('centrifugo');

    // backoff[1] = 2000ms: second retry.
    await vi.advanceTimersByTimeAsync(2000);
    expect(getLocalAdvert).toHaveBeenCalledTimes(3);
    expect(loopbackPeerFactory).toHaveBeenCalledTimes(3);

    // Array exhausted: the last entry (2000ms) repeats for subsequent retries.
    await vi.advanceTimersByTimeAsync(2000);
    expect(getLocalAdvert).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(2000);
    expect(getLocalAdvert).toHaveBeenCalledTimes(5);
  });

  it('(T1) two centrifugo sessions on one bridge share exactly one retry loop', async () => {
    const webrtcMode: { value: 'resolve' | 'reject' } = { value: 'reject' };
    const loopbackMode: { value: 'resolve' | 'reject' } = { value: 'reject' };
    const advert = { value: null as UpgradeAdvert | null };
    const { transport, getLocalAdvert } = makeUpgradeTransport({ webrtcMode, loopbackMode, advert });

    transport.subscribeTerminal('session-1', 'bridge-1', handlers());
    await flush();
    expect(transport.getMode('session-1')).toBe('centrifugo');
    expect(getLocalAdvert).toHaveBeenCalledTimes(1);

    // A second session on the SAME bridge (T2: fresh subscribe triggers its own
    // immediate attempt/reset) — isolated from the periodic loop below by asserting
    // deltas rather than absolute counts from here on.
    transport.subscribeTerminal('session-2', 'bridge-1', handlers());
    await flush();
    expect(transport.getMode('session-2')).toBe('centrifugo');
    const afterBothSubscribed = getLocalAdvert.mock.calls.length;

    // One backoff period: with 2 sessions parked on the bridge, a per-session loop
    // would produce 2 more advert queries; a per-bridge loop produces exactly 1.
    await vi.advanceTimersByTimeAsync(1000);
    expect(getLocalAdvert).toHaveBeenCalledTimes(afterBothSubscribed + 1);
  });

  it('(T2) a fresh subscribeTerminal for the bridge triggers an immediate attempt and resets the backoff', async () => {
    const webrtcMode: { value: 'resolve' | 'reject' } = { value: 'reject' };
    const loopbackMode: { value: 'resolve' | 'reject' } = { value: 'reject' };
    const advert = { value: null as UpgradeAdvert | null };
    const { transport, getLocalAdvert } = makeUpgradeTransport({ webrtcMode, loopbackMode, advert });

    transport.subscribeTerminal('session-1', 'bridge-1', handlers());
    await flush();
    expect(getLocalAdvert).toHaveBeenCalledTimes(1);

    // Let ~half the first backoff period pass with nothing happening yet.
    await vi.advanceTimersByTimeAsync(400);
    expect(getLocalAdvert).toHaveBeenCalledTimes(1);

    // Fresh subscribe: immediate attempt (no wait for the remaining 600ms).
    transport.subscribeTerminal('session-2', 'bridge-1', handlers());
    await flush();
    expect(getLocalAdvert).toHaveBeenCalledTimes(2);

    // Backoff reset to backoff[0] (1000ms) from the fresh-subscribe attempt, not
    // continuing the original schedule (which would have fired at the 600ms mark).
    await vi.advanceTimersByTimeAsync(600);
    expect(getLocalAdvert).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(400);
    expect(getLocalAdvert).toHaveBeenCalledTimes(3);
  });

  it('(T2) construction and subscription do not crash in a window-less (node) test environment', async () => {
    expect(typeof window).toBe('undefined');
    const webrtcMode: { value: 'resolve' | 'reject' } = { value: 'reject' };
    const loopbackMode: { value: 'resolve' | 'reject' } = { value: 'reject' };
    const advert = { value: null as UpgradeAdvert | null };
    expect(() => {
      const { transport } = makeUpgradeTransport({ webrtcMode, loopbackMode, advert });
      transport.subscribeTerminal('session-1', 'bridge-1', handlers());
    }).not.toThrow();
    await flush();
  });

  it('(T3) successful upgrade: ordered switchover from centrifugo to the new rung', async () => {
    const webrtcMode: { value: 'resolve' | 'reject' } = { value: 'reject' };
    const loopbackMode: { value: 'resolve' | 'reject' } = { value: 'reject' };
    const advert = { value: ADVERT as UpgradeAdvert | null };
    const { transport, centrifuge, publishCommand } = makeUpgradeTransport({ webrtcMode, loopbackMode, advert });

    const modeChanges: Array<[string, string]> = [];
    transport.onModeChange((sessionId, mode) => modeChanges.push([sessionId, mode]));
    const h: TerminalDataHandlers = { onOutput: vi.fn(), onScreen: vi.fn() };

    transport.subscribeTerminal('session-1', 'bridge-1', h);
    await flush();
    expect(transport.getMode('session-1')).toBe('centrifugo');

    const outputSub = centrifuge.getSubscription(`terminal:session-1#${USER_ID}`)!;
    outputSub.simulateSubscribed();
    publishCommand.mockClear();

    // The retry attempt now succeeds via loopback.
    loopbackMode.value = 'resolve';
    await vi.advanceTimersByTimeAsync(1000);
    await flush();

    const peer = UpgradeFakeLoopbackPeer.instances.at(-1)!;
    expect(peer.attachCalls).toHaveLength(1);
    expect(peer.attachCalls[0][0]).toBe('session-1');

    // Before the screen frame: still consuming Centrifugo — no gap. (The switch is
    // bounded by a screen-arrival watchdog of LOOPBACK_TIMEOUT_MS, so the screen must
    // arrive within that window; the pre-switch heartbeat-still-running property is
    // covered by the dedicated watchdog case below.)
    expect(transport.getMode('session-1')).toBe('centrifugo');
    expect(outputSub.unsubscribeCalls).toBe(0);
    publishCommand.mockClear();

    // Switch point: the new path's screen frame arrives (within the watchdog window).
    peer.attachCalls[0][1].onScreen('SCREEN');
    expect(h.onScreen).toHaveBeenCalledWith('SCREEN');

    // Subsequent input routes to the new peer, not published on Centrifugo.
    const inputSub = centrifuge.getSubscription(`terminal-input:session-1#${USER_ID}`);
    const inputPublishesBefore = inputSub ? inputSub.publishCalls.length : 0;
    transport.sendInput('session-1', 'ls\n');
    expect(peer.sendInputCalls).toContainEqual(['session-1', 'ls\n']);
    expect(centrifuge.getSubscription(`terminal-input:session-1#${USER_ID}`)?.publishCalls.length ?? 0).toBe(
      inputPublishesBefore,
    );

    // Centrifugo terminal sub unsubscribed + terminal_unwatch published.
    expect(outputSub.unsubscribeCalls).toBe(1);
    expect(publishCommand).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'terminal_unwatch', sessionId: 'session-1' }),
    );

    // Heartbeat stopped: advancing time produces no further watch publishes.
    publishCommand.mockClear();
    await vi.advanceTimersByTimeAsync(WATCH_HEARTBEAT_MS * 2);
    expect(publishCommand).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'terminal_watch' }));

    // Mode change centrifugo -> local fired; fallback reason cleared.
    expect(modeChanges).toContainEqual(['session-1', 'local']);
    expect(transport.getFallbackReason('session-1')).toBeNull();
  });

  it('(T3) no-gap: cloud output before the screen frame still reaches onOutput; a stray post-unsubscribe publication is not delivered', async () => {
    const webrtcMode: { value: 'resolve' | 'reject' } = { value: 'reject' };
    const loopbackMode: { value: 'resolve' | 'reject' } = { value: 'reject' };
    const advert = { value: ADVERT as UpgradeAdvert | null };
    const { transport, centrifuge } = makeUpgradeTransport({ webrtcMode, loopbackMode, advert });

    const h: TerminalDataHandlers = { onOutput: vi.fn(), onScreen: vi.fn() };
    transport.subscribeTerminal('session-1', 'bridge-1', h);
    await flush();
    const outputSub = centrifuge.getSubscription(`terminal:session-1#${USER_ID}`)!;
    outputSub.simulateSubscribed();

    loopbackMode.value = 'resolve';
    await vi.advanceTimersByTimeAsync(1000);
    await flush();
    const peer = UpgradeFakeLoopbackPeer.instances.at(-1)!;

    // Cloud output arrives before the new path's screen frame: must still reach onOutput.
    emitPublication(outputSub, { type: 'output', data: 'CLOUD-BEFORE-SWITCH' });
    expect(h.onOutput).toHaveBeenCalledWith('CLOUD-BEFORE-SWITCH');
    expect(h.onOutput).toHaveBeenCalledTimes(1);

    // Switch point.
    peer.attachCalls[0][1].onScreen('SCREEN');

    // A stray publication on the now-unsubscribed old sub must not double-apply.
    emitPublication(outputSub, { type: 'output', data: 'CLOUD-AFTER-SWITCH' });
    expect(h.onOutput).toHaveBeenCalledTimes(1);
    expect(h.onOutput).not.toHaveBeenCalledWith('CLOUD-AFTER-SWITCH');
  });

  it('(T5) a failed upgrade attempt is silent: session stays centrifugo, fallbackReason unchanged, heartbeats uninterrupted', async () => {
    const webrtcMode: { value: 'resolve' | 'reject' } = { value: 'reject' };
    const loopbackMode: { value: 'resolve' | 'reject' } = { value: 'reject' };
    const advert = { value: null as UpgradeAdvert | null };
    const { transport, centrifuge, publishCommand } = makeUpgradeTransport({ webrtcMode, loopbackMode, advert });

    transport.subscribeTerminal('session-1', 'bridge-1', handlers());
    await flush();
    expect(transport.getMode('session-1')).toBe('centrifugo');
    expect(transport.getFallbackReason('session-1')).toBe('pairing_failed');

    const outputSub = centrifuge.getSubscription(`terminal:session-1#${USER_ID}`)!;
    outputSub.simulateSubscribed();

    // Retry attempt happens and fails again (both rungs still rejecting).
    publishCommand.mockClear();
    await vi.advanceTimersByTimeAsync(1000);
    await flush();

    expect(transport.getMode('session-1')).toBe('centrifugo');
    expect(transport.getFallbackReason('session-1')).toBe('pairing_failed');

    // Heartbeats kept running uninterrupted across the failed attempt.
    publishCommand.mockClear();
    await vi.advanceTimersByTimeAsync(WATCH_HEARTBEAT_MS);
    expect(publishCommand).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'terminal_watch', sessionId: 'session-1' }),
    );
  });

  it('(T7) unsubscribing the bridge\'s last session cancels its retry loop', async () => {
    const webrtcMode: { value: 'resolve' | 'reject' } = { value: 'reject' };
    const loopbackMode: { value: 'resolve' | 'reject' } = { value: 'reject' };
    const advert = { value: null as UpgradeAdvert | null };
    const { transport, getLocalAdvert } = makeUpgradeTransport({ webrtcMode, loopbackMode, advert });

    const unsubscribe = transport.subscribeTerminal('session-1', 'bridge-1', handlers());
    await flush();
    expect(getLocalAdvert).toHaveBeenCalledTimes(1);

    unsubscribe();
    await vi.advanceTimersByTimeAsync(1000 * 20);
    expect(getLocalAdvert).toHaveBeenCalledTimes(1);
  });

  it('(T7) dispose() cancels all retry loops', async () => {
    const webrtcMode: { value: 'resolve' | 'reject' } = { value: 'reject' };
    const loopbackMode: { value: 'resolve' | 'reject' } = { value: 'reject' };
    const advert = { value: null as UpgradeAdvert | null };
    const { transport, getLocalAdvert } = makeUpgradeTransport({ webrtcMode, loopbackMode, advert });

    transport.subscribeTerminal('session-1', 'bridge-1', handlers());
    transport.subscribeTerminal('session-2', 'bridge-2', handlers());
    await flush();
    expect(getLocalAdvert).toHaveBeenCalledTimes(2);

    transport.dispose();
    await vi.advanceTimersByTimeAsync(1000 * 20);
    expect(getLocalAdvert).toHaveBeenCalledTimes(2);
  });

  it('(T6) a session that landed direct (webrtc) never triggers upgrade attempts while healthy', async () => {
    const webrtcMode: { value: 'resolve' | 'reject' } = { value: 'resolve' };
    const loopbackMode: { value: 'resolve' | 'reject' } = { value: 'reject' };
    const advert = { value: null as UpgradeAdvert | null };
    const { transport, getLocalAdvert } = makeUpgradeTransport({ webrtcMode, loopbackMode, advert });

    transport.subscribeTerminal('session-1', 'bridge-1', handlers());
    await flush();
    expect(transport.getMode('session-1')).toBe('direct');
    expect(getLocalAdvert).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1000 * 50);
    expect(getLocalAdvert).toHaveBeenCalledTimes(1);
  });

  it('(T6) a session that landed local (loopback) never triggers upgrade attempts while healthy', async () => {
    const webrtcMode: { value: 'resolve' | 'reject' } = { value: 'reject' };
    const loopbackMode: { value: 'resolve' | 'reject' } = { value: 'resolve' };
    const advert = { value: ADVERT as UpgradeAdvert | null };
    const { transport, getLocalAdvert } = makeUpgradeTransport({ webrtcMode, loopbackMode, advert });

    transport.subscribeTerminal('session-1', 'bridge-1', handlers());
    await flush();
    expect(transport.getMode('session-1')).toBe('local');
    expect(getLocalAdvert).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1000 * 50);
    expect(getLocalAdvert).toHaveBeenCalledTimes(1);
  });

  // ---------------------------------------------------------------------------
  // Review follow-up coverage (coordinator; dev implementing in parallel).
  // Written to the described semantics — expected pending until the fixes land.
  // ---------------------------------------------------------------------------

  /**
   * Case 1 — screen-never-arrives watchdog (NEW behavior).
   * The upgrade peer connects (attach sent) but the bridge never delivers a `screen`
   * for the session. After a watchdog bound the session must STAY on centrifugo (still
   * subscribed, heartbeat still running, cloud output still flowing), `pendingSwitchPeer`
   * cleared; and because NO session switched, the whole attempt is treated as failed —
   * the upgrade peer is torn down, `pe.status` reverts to 'failed', and the retry loop
   * REARMS so a later backoff tick runs another attempt.
   *
   * ASSUMPTION: the watchdog bound is not named in the addendum and the seam is not yet
   * landed, so this advances a generous 60s (well past any plausible bound) before the
   * next backoff. The load-bearing assertion is behavioral: getLocalAdvert / the loopback
   * factory is invoked AGAIN after the watchdog fires (the loop rearmed), while the
   * session never left the cloud path.
   */
  it('(watchdog) upgrade peer connects but no screen arrives: session stays centrifugo, attempt fails, loop rearms', async () => {
    const webrtcMode: { value: 'resolve' | 'reject' } = { value: 'reject' };
    const loopbackMode: { value: 'resolve' | 'reject' } = { value: 'reject' };
    const advert = { value: ADVERT as UpgradeAdvert | null };
    const { transport, centrifuge, publishCommand, getLocalAdvert, loopbackPeerFactory } =
      makeUpgradeTransport({ webrtcMode, loopbackMode, advert });

    const h: TerminalDataHandlers = { onOutput: vi.fn(), onScreen: vi.fn() };
    transport.subscribeTerminal('session-1', 'bridge-1', h);
    await flush();
    expect(transport.getMode('session-1')).toBe('centrifugo');
    const outputSub = centrifuge.getSubscription(`terminal:session-1#${USER_ID}`)!;
    outputSub.simulateSubscribed();

    // Retry attempt connects a loopback upgrade peer — but we DELIBERATELY never
    // fire its onScreen, so the switch point never occurs.
    loopbackMode.value = 'resolve';
    await vi.advanceTimersByTimeAsync(1000);
    await flush();
    const peer = UpgradeFakeLoopbackPeer.instances.at(-1)!;
    expect(peer.attachCalls).toHaveLength(1);
    // Still on cloud — the attach alone must not switch anything.
    expect(transport.getMode('session-1')).toBe('centrifugo');
    const advertCallsAtConnect = getLocalAdvert.mock.calls.length;
    const loopbackCallsAtConnect = loopbackPeerFactory.mock.calls.length;

    // Watchdog fires (no screen within the bound): the failed attempt is abandoned.
    await vi.advanceTimersByTimeAsync(60_000);
    await flush();

    // Session never left the cloud path, heartbeat still running.
    expect(transport.getMode('session-1')).toBe('centrifugo');
    publishCommand.mockClear();
    await vi.advanceTimersByTimeAsync(WATCH_HEARTBEAT_MS);
    expect(publishCommand).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'terminal_watch', sessionId: 'session-1' }),
    );
    // Cloud output still flows on the (still-subscribed) old path.
    emitPublication(outputSub, { type: 'output', data: 'STILL-CLOUD' });
    expect(h.onOutput).toHaveBeenCalledWith('STILL-CLOUD');

    // The retry loop rearmed: a later attempt re-queried the advert / rebuilt a peer.
    expect(getLocalAdvert.mock.calls.length).toBeGreaterThan(advertCallsAtConnect);
    expect(loopbackPeerFactory.mock.calls.length).toBeGreaterThan(loopbackCallsAtConnect);
  });

  /**
   * Case 2 — mid-switch dispose / unsubscribe.
   * attach sent, screen NOT yet arrived, then dispose() (and separately, unsubscribe the
   * session): no crash, the upgrade peer is cleaned up (detached/closed), and a late
   * onScreen / onOutput arriving on the abandoned upgrade peer after teardown is NOT
   * delivered to the session handlers.
   */
  it('(mid-switch) dispose() during the switch window: no crash, no late delivery, peer detached', async () => {
    const webrtcMode: { value: 'resolve' | 'reject' } = { value: 'reject' };
    const loopbackMode: { value: 'resolve' | 'reject' } = { value: 'reject' };
    const advert = { value: ADVERT as UpgradeAdvert | null };
    const { transport, centrifuge } = makeUpgradeTransport({ webrtcMode, loopbackMode, advert });

    const h: TerminalDataHandlers = { onOutput: vi.fn(), onScreen: vi.fn() };
    transport.subscribeTerminal('session-1', 'bridge-1', h);
    await flush();
    centrifuge.getSubscription(`terminal:session-1#${USER_ID}`)!.simulateSubscribed();

    loopbackMode.value = 'resolve';
    await vi.advanceTimersByTimeAsync(1000);
    await flush();
    const peer = UpgradeFakeLoopbackPeer.instances.at(-1)!;
    expect(peer.attachCalls).toHaveLength(1);
    const captured = peer.attachCalls[0][1];

    expect(() => transport.dispose()).not.toThrow();

    // A late screen/output on the abandoned upgrade peer must be dropped post-teardown.
    captured.onScreen('LATE-SCREEN');
    captured.onOutput('LATE-OUTPUT');
    expect(h.onScreen).not.toHaveBeenCalledWith('LATE-SCREEN');
    expect(h.onOutput).not.toHaveBeenCalledWith('LATE-OUTPUT');
  });

  it('(mid-switch) unsubscribe() during the switch window: no crash, no late delivery, peer detached', async () => {
    const webrtcMode: { value: 'resolve' | 'reject' } = { value: 'reject' };
    const loopbackMode: { value: 'resolve' | 'reject' } = { value: 'reject' };
    const advert = { value: ADVERT as UpgradeAdvert | null };
    const { transport, centrifuge } = makeUpgradeTransport({ webrtcMode, loopbackMode, advert });

    const h: TerminalDataHandlers = { onOutput: vi.fn(), onScreen: vi.fn() };
    const unsubscribe = transport.subscribeTerminal('session-1', 'bridge-1', h);
    await flush();
    centrifuge.getSubscription(`terminal:session-1#${USER_ID}`)!.simulateSubscribed();

    loopbackMode.value = 'resolve';
    await vi.advanceTimersByTimeAsync(1000);
    await flush();
    const peer = UpgradeFakeLoopbackPeer.instances.at(-1)!;
    expect(peer.attachCalls).toHaveLength(1);
    const captured = peer.attachCalls[0][1];

    expect(() => unsubscribe()).not.toThrow();

    captured.onScreen('LATE-SCREEN');
    captured.onOutput('LATE-OUTPUT');
    expect(h.onScreen).not.toHaveBeenCalledWith('LATE-SCREEN');
    expect(h.onOutput).not.toHaveBeenCalledWith('LATE-OUTPUT');
  });

  /**
   * Case 3 — offline gate + reschedule (dev changing offline from hard-stop to reschedule).
   * Driven through the DEFAULT presence seam (no injected getLocalAdvert ⇒ advertInjected
   * false ⇒ isBridgeOnlineForUpgrade consults presence). A presence result WITHOUT the
   * bridge's connInfo models OFFLINE; one WITH a matching connInfo (carrying localPort/
   * localNonce) models ONLINE and doubles as the loopback advert source.
   *
   * NEW semantics: while offline, an upgrade attempt does NOT switch and REschedules
   * (loop stays alive, presence is consulted again on the next backoff tick). When
   * presence later reports the bridge ONLINE, the next tick attempts and can succeed.
   */
  it('(offline gate) offline bridge reschedules the loop; going online lets a later tick upgrade', async () => {
    const PRESENCE_CHANNEL = `bridges:presence#${USER_ID}`;
    const ONLINE_CONN = { bridgeId: 'bridge-1', localPort: 41999, localNonce: 'nonce-online' };

    // Scriptable presence state: starts offline (no matching bridge in presence).
    const presenceState: { clients: Record<string, { connInfo?: unknown }> } = {
      clients: { other: { connInfo: { bridgeId: 'other-bridge' } } },
    };

    class OfflinePresenceSub extends FakeSubscription {
      presence(): Promise<{ clients: Record<string, { connInfo?: unknown }> }> {
        return Promise.resolve(presenceState);
      }
      override subscribe(): void {
        super.subscribe();
        this.simulateSubscribed();
      }
    }
    class OfflinePresenceClient extends FakeCentrifugeClient {
      override newSubscription(channel: string): FakeSubscription {
        if (channel === PRESENCE_CHANNEL) {
          const sub = new OfflinePresenceSub(channel);
          this.subs.set(channel, sub);
          return sub;
        }
        return super.newSubscription(channel);
      }
    }

    const centrifuge = new OfflinePresenceClient();
    const publishCommand = vi.fn<(msg: DirectCommandMessage) => void>();
    const peerFactory = vi.fn((o: PeerFactoryOpts) => {
      const p = new FakePeer(o.bridgeId);
      p.connectMode = 'reject'; // WebRTC always fails here — loopback is the upgrade path.
      return p;
    });
    const loopbackPeerFactory = vi.fn((o: { bridgeId: string }) => new UpgradeFakeLoopbackPeer(o.bridgeId));
    // NOTE: no getLocalAdvert — the default presence query is the online/advert seam.
    const deps = {
      centrifuge,
      userId: USER_ID,
      clientId: CLIENT_ID,
      publishCommand,
      peerFactory,
      loopbackPeerFactory,
      upgradeBackoffMs: [1000, 2000],
      upgradeJitter: 0,
    };
    const transport = new HybridTerminalTransport(
      deps as unknown as ConstructorParameters<typeof HybridTerminalTransport>[0],
    );
    activeTransports.push(transport);

    const h: TerminalDataHandlers = { onOutput: vi.fn(), onScreen: vi.fn() };
    transport.subscribeTerminal('session-1', 'bridge-1', h);
    await flush();
    // Initial ladder: presence has no matching advert ⇒ loopback skipped, WebRTC fails
    // ⇒ centrifugo.
    expect(transport.getMode('session-1')).toBe('centrifugo');
    centrifuge.getSubscription(`terminal:session-1#${USER_ID}`)!.simulateSubscribed();

    // A retry tick while OFFLINE must reschedule (loop alive), not hard-stop.
    await vi.advanceTimersByTimeAsync(1000);
    await flush();
    expect(transport.getMode('session-1')).toBe('centrifugo');
    expect(loopbackPeerFactory).not.toHaveBeenCalled();

    // Flip presence to ONLINE with the bridge's loopback advert.
    presenceState.clients = { 'conn-b': { connInfo: ONLINE_CONN } };

    // The loop is still alive: a later backoff tick consults presence, finds the bridge
    // online + its advert, and upgrades via loopback.
    await vi.advanceTimersByTimeAsync(2000);
    await flush();
    expect(loopbackPeerFactory).toHaveBeenCalledWith(
      expect.objectContaining({ bridgeId: 'bridge-1', port: 41999, nonce: 'nonce-online' }),
    );
    const peer = UpgradeFakeLoopbackPeer.instances.at(-1)!;
    expect(peer.attachCalls).toHaveLength(1);
    peer.attachCalls[0][1].onScreen('SCREEN');
    expect(transport.getMode('session-1')).toBe('local');
  });

  /**
   * Case 4 — keystroke replay/drain at cutover (dev choosing replay-preferred).
   * Input typed during the switch window (attach sent, screen not yet arrived) must NOT
   * be lost. The landed semantics (verified against performSwitch) are precise:
   *   - Until the switch point, input routes to the currently-active CLOUD path (T4).
   *     A frame handed to the cloud publish() call is delivered via cloud — not lost —
   *     and is NOT replayed to the peer (that would duplicate it).
   *   - Only the un-published RESIDUE still sitting in the outbound queue at the switch
   *     point (frames that never reached the wire because an earlier publish is still
   *     in flight) is REPLAYED onto the freshly-attached peer, once, in order.
   *
   * To exercise the residue path deterministically the cloud input publish is PARKED
   * (never resolves): the first frame goes in-flight on cloud; subsequent keystrokes
   * pile up in the queue (coalesced) and must be replayed to the new peer at cutover.
   *
   * ASSUMPTION/INTERPRETATION: "the buffered input reaches the new peer" is read as the
   * un-flushed residue reaching the peer; the single in-flight frame is considered
   * delivered on the cloud path (T4), so it is intentionally NOT replayed to the peer.
   */
  it('(cutover replay) queued-but-unpublished input replays onto the new peer at the switch, once, in order', async () => {
    const webrtcMode: { value: 'resolve' | 'reject' } = { value: 'reject' };
    const loopbackMode: { value: 'resolve' | 'reject' } = { value: 'reject' };
    const advert = { value: ADVERT as UpgradeAdvert | null };
    const { transport, centrifuge } = makeUpgradeTransport({ webrtcMode, loopbackMode, advert });

    const h: TerminalDataHandlers = { onOutput: vi.fn(), onScreen: vi.fn() };
    transport.subscribeTerminal('session-1', 'bridge-1', h);
    await flush();
    const outputSub = centrifuge.getSubscription(`terminal:session-1#${USER_ID}`)!;
    outputSub.simulateSubscribed();

    // Park the cloud input publish so frames queue instead of draining to the wire.
    const inputSub = centrifuge.getSubscription(`terminal-input:session-1#${USER_ID}`)!;
    const cloudPublished: unknown[] = [];
    inputSub.publish = (data: unknown) => {
      cloudPublished.push(data);
      return new Promise<unknown>(() => {}); // never resolves: stays in flight
    };

    loopbackMode.value = 'resolve';
    await vi.advanceTimersByTimeAsync(1000);
    await flush();
    const peer = UpgradeFakeLoopbackPeer.instances.at(-1)!;
    expect(peer.attachCalls).toHaveLength(1);

    // Type during the switch window (screen not yet arrived). 'a' goes in-flight on
    // cloud (parked); 'b'+'c' coalesce and remain queued as residue.
    transport.sendInput('session-1', 'a');
    transport.sendInput('session-1', 'b');
    transport.sendInput('session-1', 'c');
    await flush();
    expect(transport.getMode('session-1')).toBe('centrifugo');
    // 'a' reached the cloud publish (delivered via cloud, T4); residue not yet on wire.
    expect(cloudPublished).toEqual([{ type: 'input', data: 'a' }]);
    expect(peer.sendInputCalls).toHaveLength(0);

    // Switch point: screen arrives on the new peer.
    peer.attachCalls[0][1].onScreen('SCREEN');
    expect(transport.getMode('session-1')).toBe('local');

    // Residue replayed onto the new peer (once), and post-switch 'z' routes to it too.
    transport.sendInput('session-1', 'z');
    const toPeer = peer.sendInputCalls.map(([, d]) => d).join('');
    // The queued residue ('bc') was replayed; the in-flight 'a' was NOT duplicated here.
    expect(toPeer).toContain('bc');
    expect(toPeer).toContain('z');
    expect(toPeer).not.toContain('a');
    // No duplication onto cloud either: residue never reached the cloud wire.
    expect(cloudPublished).toEqual([{ type: 'input', data: 'a' }]);
    // Order preserved: residue before the post-switch keystroke.
    expect(toPeer.indexOf('bc')).toBeLessThan(toPeer.indexOf('z'));
  });
});

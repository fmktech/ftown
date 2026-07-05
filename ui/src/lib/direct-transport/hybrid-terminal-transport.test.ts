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
    // Latest resize (as the cols-1 -> cols redraw bounce) then inputs in order.
    expect(inputSub!.publishCalls).toEqual([
      { type: 'resize', cols: 99, rows: 40 },
      { type: 'resize', cols: 100, rows: 40 },
      { type: 'input', data: 'a' },
      { type: 'input', data: 'b' },
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
    // The flush must have been handed to publish() (queued), not dropped or deferred
    // past the subscribing window... (resize arrives as the cols-1 -> cols bounce)
    expect(inputSub.publishCalls).toEqual([
      { type: 'resize', cols: 99, rows: 40 },
      { type: 'resize', cols: 100, rows: 40 },
      { type: 'input', data: 'a' },
      { type: 'input', data: 'b' },
    ]);
    // ...but nothing is on the wire until the subscription becomes active.
    expect(inputSub.delivered).toEqual([]);

    inputSub.simulateSubscribed();
    await flush();
    expect(inputSub.delivered).toEqual([
      { type: 'resize', cols: 99, rows: 40 },
      { type: 'resize', cols: 100, rows: 40 },
      { type: 'input', data: 'a' },
      { type: 'input', data: 'b' },
    ]);
  });
});

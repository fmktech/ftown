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
import { WATCH_HEARTBEAT_MS, type DirectCommandMessage, type TerminalDataHandlers } from './contract';

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

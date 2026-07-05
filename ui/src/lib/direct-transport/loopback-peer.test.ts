/**
 * Contract-level tests for LoopbackPeer (docs/plans/loopback-transport-addendum.md,
 * rules L1/L3/L4/L5 + "Module surface (frozen)" section). Written against the addendum
 * and direct-transport-contract.md before loopback-peer.ts lands — module-not-found
 * failures are expected until then.
 *
 * ASSUMPTIONS (not fully pinned down by the addendum, reconciled once the real
 * implementation lands without invalidating the behavioral assertions below):
 * - Constructor takes `{ bridgeId, clientId, port, nonce, wsFactory? }`. `wsFactory`
 *   defaults to the real `WebSocket` constructor and is the addendum's "injectable
 *   WebSocket factory for tests" (module surface section); it is invoked with the full
 *   `ws://127.0.0.1:{port}/ws?nonce=<nonce>` URL (L1) synchronously inside `connect()`.
 * - Public surface mirrors WebRtcPeer exactly (module surface section): `connect():
 *   Promise<void>`, `attach(sessionId, handlers)`, `detach(sessionId)`,
 *   `sendInput(sessionId, data)`, `sendResize(sessionId, cols, rows)`, `close()`,
 *   `onClose(cb)`. No `handleSignal` — loopback has no signaling plane (L1: it's a plain
 *   WS upgrade, not WebRTC).
 * - `LOOPBACK_TIMEOUT_MS` is the addendum's L4 constant (1_500). It is not yet exported
 *   from `./contract` (contract.ts pre-dates the addendum landing) so it is redefined
 *   locally here with the frozen value; once the addendum lands and contract.ts exports
 *   it, this local const should be replaced with the real import.
 * - `connect()` resolves only after the hello/hello_ack handshake completes over the
 *   open WebSocket (L3: same hello_ack gating as WebRTC), mirroring WebRtcPeer.
 * - Ping/pong reuses the existing `PING_INTERVAL_MS` / 2-missed-pongs-is-dead semantics
 *   from direct-transport-contract.md (L3: "same wire protocol ... same semantics"),
 *   symmetric with WebRtcPeer's client-side keepalive.
 * - A synchronous throw from `wsFactory(url)` (e.g. a browser blocking mixed-content
 *   `ws://` from an `https://` page) is caught inside `connect()` and surfaces as a
 *   rejected `connect()` promise, not a thrown exception — mirroring how
 *   HybridTerminalTransport already treats a synchronously-throwing `peerFactory` as a
 *   connect-time failure rather than a construction-time one.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DIRECT_PROTOCOL_VERSION, PING_INTERVAL_MS } from './contract';

// LoopbackPeer does not exist yet — this import is expected to fail until the loopback
// UI dev agent lands it.
import { LoopbackPeer } from './loopback-peer';

/** Frozen by docs/plans/loopback-transport-addendum.md L4; see header assumption. */
const LOOPBACK_TIMEOUT_MS = 1_500;

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];

  readyState: 0 | 1 | 2 | 3 = 0; // CONNECTING
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  sent: unknown[] = [];

  constructor(public url: string) {
    FakeWebSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }

  close(): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.onclose?.();
  }

  simulateOpen(): void {
    this.readyState = 1;
    this.onopen?.();
  }

  simulateMessage(msg: unknown): void {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
}

async function flush(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

describe('LoopbackPeer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeWebSocket.instances = [];
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function makePeer(wsFactory?: (url: string) => FakeWebSocket) {
    const factory = wsFactory ?? ((url: string) => new FakeWebSocket(url));
    const peer = new LoopbackPeer({
      bridgeId: 'bridge-1',
      clientId: 'client-1',
      port: 41999,
      nonce: 'nonce-abc',
      wsFactory: factory,
    });
    return { peer, factory };
  }

  it('opens ws://127.0.0.1:{port}/ws?nonce=… and resolves connect() after open + hello_ack', async () => {
    const { peer } = makePeer();
    let resolved = false;
    const connectPromise = peer.connect().then(() => {
      resolved = true;
    });
    await flush();

    expect(FakeWebSocket.instances).toHaveLength(1);
    const ws = FakeWebSocket.instances[0];
    expect(ws.url).toBe('ws://127.0.0.1:41999/ws?nonce=nonce-abc');

    ws.simulateOpen();
    await flush();

    expect(
      ws.sent.some(
        (m) =>
          (m as { kind: string }).kind === 'hello' &&
          (m as { clientId: string }).clientId === 'client-1' &&
          (m as { protocolVersion: number }).protocolVersion === DIRECT_PROTOCOL_VERSION,
      ),
    ).toBe(true);
    expect(resolved).toBe(false);

    ws.simulateMessage({ kind: 'hello_ack', bridgeId: 'bridge-1', protocolVersion: DIRECT_PROTOCOL_VERSION });
    await flush();
    expect(resolved).toBe(true);
    await connectPromise;
  });

  it('rejects connect() after LOOPBACK_TIMEOUT_MS with no successful handshake', async () => {
    const { peer } = makePeer();
    const connectPromise = peer.connect();
    connectPromise.catch(() => {});

    await vi.advanceTimersByTimeAsync(LOOPBACK_TIMEOUT_MS);

    await expect(connectPromise).rejects.toBeTruthy();
  });

  it('closes the connection on protocol version mismatch', async () => {
    const { peer } = makePeer();
    const onCloseSpy = vi.fn();
    peer.onClose(onCloseSpy);

    const connectPromise = peer.connect();
    connectPromise.catch(() => {});
    await flush();

    const ws = FakeWebSocket.instances[0];
    ws.simulateOpen();
    await flush();

    ws.simulateMessage({
      kind: 'hello_ack',
      bridgeId: 'bridge-1',
      protocolVersion: DIRECT_PROTOCOL_VERSION + 1,
    });
    await flush();

    expect(ws.readyState).toBe(3);
    expect(onCloseSpy).toHaveBeenCalled();
    await expect(connectPromise).rejects.toBeTruthy();
  });

  async function connectedPeer() {
    const { peer } = makePeer();
    const connectPromise = peer.connect();
    await flush();
    const ws = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
    ws.simulateOpen();
    await flush();
    ws.simulateMessage({ kind: 'hello_ack', bridgeId: 'bridge-1', protocolVersion: DIRECT_PROTOCOL_VERSION });
    await flush();
    await connectPromise;
    ws.sent = [];
    return { peer, ws };
  }

  it('attaches a session and calls onScreen before onOutput for that session', async () => {
    const { peer, ws } = await connectedPeer();
    const order: string[] = [];
    const onScreen = vi.fn((data: string) => order.push(`screen:${data}`));
    const onOutput = vi.fn((data: string) => order.push(`output:${data}`));

    peer.attach('session-1', { onScreen, onOutput });
    await flush();

    expect(
      ws.sent.some(
        (m) => (m as { kind: string }).kind === 'attach' && (m as { sessionId: string }).sessionId === 'session-1',
      ),
    ).toBe(true);

    ws.simulateMessage({ kind: 'screen', sessionId: 'session-1', data: 'full-screen', seq: 0 });
    ws.simulateMessage({ kind: 'output', sessionId: 'session-1', data: 'chunk-1', seq: 1 });
    await flush();

    expect(order).toEqual(['screen:full-screen', 'output:chunk-1']);

    // Messages for a non-attached session are ignored.
    ws.simulateMessage({ kind: 'output', sessionId: 'session-2', data: 'ignored', seq: 1 });
    await flush();
    expect(onOutput).toHaveBeenCalledTimes(1);

    peer.detach('session-1');
    await flush();
    ws.simulateMessage({ kind: 'output', sessionId: 'session-1', data: 'after-detach', seq: 2 });
    await flush();
    expect(onOutput).toHaveBeenCalledTimes(1);
  });

  it('routes sendInput/sendResize as WS frames', async () => {
    const { peer, ws } = await connectedPeer();
    peer.sendInput('session-1', 'ls\n');
    peer.sendResize('session-1', 80, 24);

    expect(ws.sent).toContainEqual({ kind: 'input', sessionId: 'session-1', data: 'ls\n' });
    expect(ws.sent).toContainEqual({ kind: 'resize', sessionId: 'session-1', cols: 80, rows: 24 });
  });

  it('sends periodic pings and closes after 2 consecutive missed pongs', async () => {
    const { ws: healthyWs } = await connectedPeer();
    const onCloseSpy = vi.fn();
    const { peer, ws } = await connectedPeer();
    peer.onClose(onCloseSpy);

    const pingCount = () => ws.sent.filter((m) => (m as { kind: string }).kind === 'ping').length;

    await vi.advanceTimersByTimeAsync(PING_INTERVAL_MS);
    healthyWs.simulateMessage({ kind: 'pong' });
    expect(pingCount()).toBe(1);
    expect(ws.readyState).not.toBe(3);

    await vi.advanceTimersByTimeAsync(PING_INTERVAL_MS);
    healthyWs.simulateMessage({ kind: 'pong' });
    expect(pingCount()).toBe(2);
    expect(ws.readyState).not.toBe(3);

    await vi.advanceTimersByTimeAsync(PING_INTERVAL_MS);
    expect(ws.readyState).toBe(3);
    expect(onCloseSpy).toHaveBeenCalled();

    expect(healthyWs.readyState).not.toBe(3);
  });

  it('resets the missed-pong counter when a pong is received', async () => {
    const { peer, ws } = await connectedPeer();
    const onCloseSpy = vi.fn();
    peer.onClose(onCloseSpy);

    await vi.advanceTimersByTimeAsync(PING_INTERVAL_MS);
    ws.simulateMessage({ kind: 'pong' });

    await vi.advanceTimersByTimeAsync(PING_INTERVAL_MS);
    expect(ws.readyState).not.toBe(3);
    expect(onCloseSpy).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(PING_INTERVAL_MS);
    expect(ws.readyState).not.toBe(3);
    expect(onCloseSpy).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(PING_INTERVAL_MS);
    expect(ws.readyState).toBe(3);
    expect(onCloseSpy).toHaveBeenCalled();
  });

  it('propagates a synchronous wsFactory throw as a connect() failure, not a thrown exception', async () => {
    const throwingFactory = vi.fn(() => {
      throw new Error('mixed content blocked');
    });
    const { peer } = makePeer(throwingFactory as unknown as (url: string) => FakeWebSocket);

    let rejected: unknown;
    await expect(
      peer.connect().catch((err) => {
        rejected = err;
        throw err;
      }),
    ).rejects.toBeTruthy();
    expect(rejected).toBeInstanceOf(Error);
    expect(throwingFactory).toHaveBeenCalledTimes(1);
  });
});

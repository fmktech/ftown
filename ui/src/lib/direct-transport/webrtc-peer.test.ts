/**
 * Contract-level tests for WebRtcPeer (docs/plans/direct-transport-contract.md, R6 +
 * "DataChannel protocol" + "Module APIs" sections). Written against contract.ts before
 * webrtc-peer.ts lands — module-not-found failures are expected until then.
 *
 * ASSUMPTIONS (not fully pinned down by the contract doc, reconciled once the real
 * implementation lands without invalidating the behavioral assertions below):
 * - `handleSignal(msg: SignalMessage)` exists on WebRtcPeer (symmetric with the bridge's
 *   `DirectPeerManager.handleSignal`), per the task spec for this test suite.
 * - The client is the RTCPeerConnection offerer: it creates the `ftown` DataChannel
 *   itself and calls `RTCPeerConnection#createDataChannel` synchronously inside
 *   `connect()`.
 * - `connect()` resolves only after the hello/hello_ack handshake completes over the
 *   open DataChannel (not merely on ICE/channel "open").
 * - The client also pings the bridge every `PING_INTERVAL_MS` and treats 2 consecutive
 *   missed pongs as dead (symmetric keepalive; the contract only states the bridge's
 *   side of this rule explicitly).
 * - ICE candidates are relayed as `webrtc_ice` with `payload` = `JSON.stringify(candidate)`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  DATA_CHANNEL_LABEL,
  DIRECT_PROTOCOL_VERSION,
  PAIR_TIMEOUT_MS,
  PING_INTERVAL_MS,
  type SignalMessage,
} from './contract';

// WebRtcPeer does not exist yet — this import is expected to fail until A3 lands it.
import { WebRtcPeer } from './webrtc-peer';

class FakeDataChannel {
  readyState: 'connecting' | 'open' | 'closed' = 'connecting';
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  sent: unknown[] = [];

  constructor(public label: string) {}

  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }

  close(): void {
    if (this.readyState === 'closed') return;
    this.readyState = 'closed';
    this.onclose?.();
  }

  simulateOpen(): void {
    this.readyState = 'open';
    this.onopen?.();
  }

  simulateMessage(msg: unknown): void {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
}

class FakeRTCPeerConnection {
  static instances: FakeRTCPeerConnection[] = [];

  channel: FakeDataChannel | null = null;
  onicecandidate: ((ev: { candidate: unknown }) => void) | null = null;
  localDescription: { type: string; sdp: string } | null = null;
  remoteDescription: { type: string; sdp: string } | null = null;
  closed = false;
  addIceCandidateCalls: unknown[] = [];

  constructor(public config: unknown) {
    FakeRTCPeerConnection.instances.push(this);
  }

  createDataChannel(label: string): FakeDataChannel {
    this.channel = new FakeDataChannel(label);
    return this.channel;
  }

  async createOffer(): Promise<{ type: string; sdp: string }> {
    return { type: 'offer', sdp: 'fake-offer-sdp' };
  }

  async setLocalDescription(desc: { type: string; sdp: string }): Promise<void> {
    this.localDescription = desc;
  }

  async setRemoteDescription(desc: { type: string; sdp: string }): Promise<void> {
    this.remoteDescription = desc;
  }

  async addIceCandidate(candidate: unknown): Promise<void> {
    this.addIceCandidateCalls.push(candidate);
  }

  close(): void {
    this.closed = true;
    this.channel?.close();
  }

  emitIceCandidate(candidate: unknown): void {
    this.onicecandidate?.({ candidate });
  }
}

/** Real RTCIceCandidate exposes `.toJSON()`; WebRtcPeer calls it before relaying. */
function fakeIceCandidate(data: { candidate: string; sdpMid: string; sdpMLineIndex: number }) {
  return { ...data, toJSON: () => data };
}

async function flush(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

describe('WebRtcPeer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeRTCPeerConnection.instances = [];
    (globalThis as unknown as { RTCPeerConnection: unknown }).RTCPeerConnection =
      FakeRTCPeerConnection;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function makePeer() {
    const sendSignal = vi.fn<(msg: SignalMessage) => void>();
    const peer = new WebRtcPeer({ bridgeId: 'bridge-1', clientId: 'client-1', sendSignal });
    return { peer, sendSignal };
  }

  it('produces an offer via sendSignal and relays ICE candidates', async () => {
    const { peer, sendSignal } = makePeer();

    void peer.connect();
    await flush();

    expect(FakeRTCPeerConnection.instances).toHaveLength(1);
    const pc = FakeRTCPeerConnection.instances[0];
    expect(pc.channel?.label).toBe(DATA_CHANNEL_LABEL);
    expect(pc.localDescription).toEqual({ type: 'offer', sdp: 'fake-offer-sdp' });

    expect(sendSignal).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'webrtc_offer',
        bridgeId: 'bridge-1',
        clientId: 'client-1',
        payload: 'fake-offer-sdp',
        pairId: expect.any(String),
      }),
    );

    pc.emitIceCandidate(fakeIceCandidate({ candidate: 'fake-candidate', sdpMid: '0', sdpMLineIndex: 0 }));
    await flush();

    const iceCall = sendSignal.mock.calls.find((c) => c[0].type === 'webrtc_ice');
    expect(iceCall).toBeDefined();
    expect(JSON.parse(iceCall![0].payload)).toEqual({
      candidate: 'fake-candidate',
      sdpMid: '0',
      sdpMLineIndex: 0,
    });
  });

  it('applies answer and ICE candidates via handleSignal', async () => {
    const { peer, sendSignal } = makePeer();
    void peer.connect();
    await flush();

    const pc = FakeRTCPeerConnection.instances[0];
    const pairId = sendSignal.mock.calls[0][0].pairId;

    peer.handleSignal({
      type: 'webrtc_answer',
      pairId,
      bridgeId: 'bridge-1',
      clientId: 'client-1',
      payload: 'fake-answer-sdp',
    });
    await flush();
    expect(pc.remoteDescription).toEqual({ type: 'answer', sdp: 'fake-answer-sdp' });

    const candidate = { candidate: 'remote-cand', sdpMid: '0', sdpMLineIndex: 0 };
    peer.handleSignal({
      type: 'webrtc_ice',
      pairId,
      bridgeId: 'bridge-1',
      clientId: 'client-1',
      payload: JSON.stringify(candidate),
    });
    await flush();
    expect(pc.addIceCandidateCalls).toContainEqual(candidate);
  });

  it('gates connect() resolution on the hello/hello_ack handshake', async () => {
    const { peer } = makePeer();
    let resolved = false;
    const connectPromise = peer.connect().then(() => {
      resolved = true;
    });
    await flush();

    const pc = FakeRTCPeerConnection.instances[0];
    pc.channel!.simulateOpen();
    await flush();

    expect(
      pc.channel!.sent.some(
        (m) =>
          (m as { kind: string }).kind === 'hello' &&
          (m as { clientId: string }).clientId === 'client-1' &&
          (m as { protocolVersion: number }).protocolVersion === DIRECT_PROTOCOL_VERSION,
      ),
    ).toBe(true);
    expect(resolved).toBe(false);

    pc.channel!.simulateMessage({
      kind: 'hello_ack',
      bridgeId: 'bridge-1',
      protocolVersion: DIRECT_PROTOCOL_VERSION,
    });
    await flush();
    expect(resolved).toBe(true);
    await connectPromise;
  });

  it('closes the connection on protocol version mismatch', async () => {
    const { peer } = makePeer();
    const onCloseSpy = vi.fn();
    peer.onClose(onCloseSpy);

    const connectPromise = peer.connect();
    // Swallow the expected rejection so vitest doesn't flag it as unhandled while we
    // inspect state before awaiting it below.
    connectPromise.catch(() => {});
    await flush();

    const pc = FakeRTCPeerConnection.instances[0];
    pc.channel!.simulateOpen();
    await flush();

    pc.channel!.simulateMessage({
      kind: 'hello_ack',
      bridgeId: 'bridge-1',
      protocolVersion: DIRECT_PROTOCOL_VERSION + 1,
    });
    await flush();

    expect(pc.closed).toBe(true);
    expect(onCloseSpy).toHaveBeenCalled();
    await expect(connectPromise).rejects.toBeTruthy();
  });

  it('rejects connect() after PAIR_TIMEOUT_MS with no successful handshake', async () => {
    const { peer } = makePeer();
    const connectPromise = peer.connect();
    connectPromise.catch(() => {});

    await vi.advanceTimersByTimeAsync(PAIR_TIMEOUT_MS);

    await expect(connectPromise).rejects.toBeTruthy();
  });

  async function connectedPeer() {
    const { peer, sendSignal } = makePeer();
    const connectPromise = peer.connect();
    await flush();
    const pc = FakeRTCPeerConnection.instances[FakeRTCPeerConnection.instances.length - 1];
    pc.channel!.simulateOpen();
    await flush();
    pc.channel!.simulateMessage({
      kind: 'hello_ack',
      bridgeId: 'bridge-1',
      protocolVersion: DIRECT_PROTOCOL_VERSION,
    });
    await flush();
    await connectPromise;
    pc.channel!.sent = [];
    return { peer, pc, sendSignal };
  }

  it('attaches a session and calls onScreen before onOutput for that session', async () => {
    const { peer, pc } = await connectedPeer();
    const order: string[] = [];
    const onScreen = vi.fn((data: string) => order.push(`screen:${data}`));
    const onOutput = vi.fn((data: string) => order.push(`output:${data}`));

    peer.attach('session-1', { onScreen, onOutput });
    await flush();

    expect(
      pc.channel!.sent.some(
        (m) => (m as { kind: string }).kind === 'attach' && (m as { sessionId: string }).sessionId === 'session-1',
      ),
    ).toBe(true);

    pc.channel!.simulateMessage({ kind: 'screen', sessionId: 'session-1', data: 'full-screen', seq: 0 });
    pc.channel!.simulateMessage({ kind: 'output', sessionId: 'session-1', data: 'chunk-1', seq: 1 });
    await flush();

    expect(order).toEqual(['screen:full-screen', 'output:chunk-1']);

    // Messages for a non-attached session are ignored.
    pc.channel!.simulateMessage({ kind: 'output', sessionId: 'session-2', data: 'ignored', seq: 1 });
    await flush();
    expect(onOutput).toHaveBeenCalledTimes(1);

    peer.detach('session-1');
    await flush();
    pc.channel!.simulateMessage({ kind: 'output', sessionId: 'session-1', data: 'after-detach', seq: 2 });
    await flush();
    expect(onOutput).toHaveBeenCalledTimes(1);
  });

  it('routes sendInput/sendResize as DataChannel frames', async () => {
    const { peer, pc } = await connectedPeer();
    peer.sendInput('session-1', 'ls\n');
    peer.sendResize('session-1', 80, 24);

    expect(pc.channel!.sent).toContainEqual({ kind: 'input', sessionId: 'session-1', data: 'ls\n' });
    expect(pc.channel!.sent).toContainEqual({ kind: 'resize', sessionId: 'session-1', cols: 80, rows: 24 });
  });

  it('sends periodic pings and closes after 2 consecutive missed pongs', async () => {
    // A sibling connection that keeps answering pongs, to prove teardown is scoped to
    // the one connection that stops answering (not a global timer side effect).
    const { pc: healthyPc } = await connectedPeer();
    const onCloseSpy = vi.fn();
    const { peer, pc } = await connectedPeer();
    peer.onClose(onCloseSpy);

    const pingCount = () => pc.channel!.sent.filter((m) => (m as { kind: string }).kind === 'ping').length;

    // Tick 1: 0 misses so far -> sends a ping, 1 miss now outstanding.
    await vi.advanceTimersByTimeAsync(PING_INTERVAL_MS);
    healthyPc.channel!.simulateMessage({ kind: 'pong' });
    expect(pingCount()).toBe(1);
    expect(pc.closed).toBe(false);

    // Tick 2: 1 miss so far -> sends a second ping, 2 misses now outstanding.
    await vi.advanceTimersByTimeAsync(PING_INTERVAL_MS);
    healthyPc.channel!.simulateMessage({ kind: 'pong' });
    expect(pingCount()).toBe(2);
    expect(pc.closed).toBe(false);

    // Tick 3: 2 consecutive missed pongs -> dead, closes without sending a 3rd ping.
    await vi.advanceTimersByTimeAsync(PING_INTERVAL_MS);
    expect(pc.closed).toBe(true);
    expect(onCloseSpy).toHaveBeenCalled();

    // The healthy sibling, which kept answering pongs, is unaffected.
    expect(healthyPc.closed).toBe(false);
  });

  it('resets the missed-pong counter when a pong is received', async () => {
    const { peer, pc } = await connectedPeer();
    const onCloseSpy = vi.fn();
    peer.onClose(onCloseSpy);

    // First ping goes unanswered, but a pong then arrives and resets the counter.
    await vi.advanceTimersByTimeAsync(PING_INTERVAL_MS);
    pc.channel!.simulateMessage({ kind: 'pong' });

    // From here it again takes 2 more unanswered ping ticks before a 3rd tick kills it.
    await vi.advanceTimersByTimeAsync(PING_INTERVAL_MS);
    expect(pc.closed).toBe(false);
    expect(onCloseSpy).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(PING_INTERVAL_MS);
    expect(pc.closed).toBe(false);
    expect(onCloseSpy).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(PING_INTERVAL_MS);
    expect(pc.closed).toBe(true);
    expect(onCloseSpy).toHaveBeenCalled();
  });
});

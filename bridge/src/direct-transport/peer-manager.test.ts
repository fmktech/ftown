/**
 * Contract-level tests for DirectPeerManager (docs/plans/direct-transport-contract.md,
 * R1/R6/R7 and the DataChannel protocol). Written against the frozen wire contract
 * (contract.ts) and the real DirectPeerManager module surface — `DirectPeerConnection`,
 * `DirectDataChannel`, `PeerConnectionFactory`, `DirectPeerManagerOptions` — exported
 * from peer-manager.ts itself, which lands the `node-datachannel` injection point as a
 * single options object: `{ bridgeId, sendSignal, onInput, onResize, onAttach,
 * peerConnectionFactory?, now? }`. Fakes below implement those structural interfaces
 * directly rather than the real `node-datachannel` classes.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { DirectPeerManager } from './peer-manager.js';
import type { DirectDataChannel, DirectPeerConnection, PeerConnectionFactory } from './peer-manager.js';
import { DIRECT_PROTOCOL_VERSION } from './contract.js';
import type { SignalMessage } from './contract.js';

const OUR_BRIDGE_ID = 'bridge-under-test';

interface DirectFrame {
  kind: string;
  [key: string]: unknown;
}

/** Private chunking constant in peer-manager.ts (MAX_FRAME_DATA_CHARS). */
const CHUNK_SIZE = 32_000;

class FakeDataChannel implements DirectDataChannel {
  public sent: DirectFrame[] = [];
  public closed = false;
  /** When true, sendMessage throws (simulates a native send failure). */
  public failSend = false;
  private open = true;
  private messageCb?: (msg: string | Buffer | ArrayBuffer) => void;
  private closedCb?: () => void;

  onMessage(cb: (msg: string | Buffer | ArrayBuffer) => void): void {
    this.messageCb = cb;
  }

  onOpen(_cb: () => void): void {}

  onClosed(cb: () => void): void {
    this.closedCb = cb;
  }

  onError(_cb: (err: string) => void): void {}

  isOpen(): boolean {
    return this.open;
  }

  sendMessage(payload: string): boolean {
    if (this.failSend) throw new Error('native send failure');
    this.sent.push(JSON.parse(payload));
    return true;
  }

  close(): void {
    this.closed = true;
    this.open = false;
    this.closedCb?.();
  }

  /** Test helper: simulate an inbound JSON text frame from the remote peer. */
  receive(frame: DirectFrame): void {
    this.messageCb?.(JSON.stringify(frame));
  }
}

class FakePeerConnection implements DirectPeerConnection {
  public setRemoteDescriptionCalls: Array<[string, string]> = [];
  public addRemoteCandidateCalls: Array<[string, string]> = [];
  public closed = false;
  /** When true, setRemoteDescription throws (simulates native SDP rejection). */
  public failSetRemoteDescription = false;
  /** When true, addRemoteCandidate throws (simulates a malformed candidate). */
  public failAddRemoteCandidate = false;
  public dataChannel = new FakeDataChannel();
  private localDescriptionCb?: (sdp: string, type: string) => void;
  private localCandidateCb?: (candidate: string, mid: string) => void;
  private dataChannelCb?: (dc: DirectDataChannel) => void;

  onLocalDescription(cb: (sdp: string, type: string) => void): void {
    this.localDescriptionCb = cb;
  }

  onLocalCandidate(cb: (candidate: string, mid: string) => void): void {
    this.localCandidateCb = cb;
  }

  onStateChange(_cb: (state: string) => void): void {}

  setRemoteDescription(sdp: string, type: string): void {
    if (this.failSetRemoteDescription) throw new Error('invalid SDP');
    this.setRemoteDescriptionCalls.push([sdp, type]);
  }

  addRemoteCandidate(candidate: string, mid: string): void {
    if (this.failAddRemoteCandidate) throw new Error('invalid candidate');
    this.addRemoteCandidateCalls.push([candidate, mid]);
  }

  onDataChannel(cb: (dc: DirectDataChannel) => void): void {
    this.dataChannelCb = cb;
  }

  close(): void {
    this.closed = true;
  }

  /** Test helper: simulate the library emitting the locally-generated SDP (the answer). */
  triggerLocalDescription(sdp: string, type: string): void {
    this.localDescriptionCb?.(sdp, type);
  }

  /** Test helper: simulate the library emitting a local ICE candidate. */
  triggerLocalCandidate(candidate: string, mid: string): void {
    this.localCandidateCb?.(candidate, mid);
  }

  /** Test helper: simulate the remote (client) side opening the DataChannel. */
  triggerDataChannel(): FakeDataChannel {
    this.dataChannelCb?.(this.dataChannel);
    return this.dataChannel;
  }
}

function makeManager(
  onAttach: (sessionId: string) => string = () => 'DEFAULT-SCREEN',
  configurePc?: (pc: FakePeerConnection, index: number) => void,
) {
  const peers: FakePeerConnection[] = [];
  const sendSignalCalls: SignalMessage[] = [];
  const inputCalls: Array<[string, string]> = [];
  const resizeCalls: Array<[string, number, number]> = [];

  const peerConnectionFactory: PeerConnectionFactory = (_peerName, _config) => {
    const pc = new FakePeerConnection();
    configurePc?.(pc, peers.length);
    peers.push(pc);
    return pc;
  };

  const manager = new DirectPeerManager({
    bridgeId: OUR_BRIDGE_ID,
    sendSignal: (msg) => sendSignalCalls.push(msg),
    onInput: (sessionId, data) => inputCalls.push([sessionId, data]),
    onResize: (sessionId, cols, rows) => resizeCalls.push([sessionId, cols, rows]),
    onAttach,
    peerConnectionFactory,
  });

  return { manager, peers, sendSignalCalls, inputCalls, resizeCalls };
}

function offerMsg(overrides: Partial<SignalMessage> = {}): SignalMessage {
  return {
    type: 'webrtc_offer',
    pairId: 'pair-1',
    bridgeId: OUR_BRIDGE_ID,
    clientId: 'client-1',
    payload: 'OFFER_SDP',
    ...overrides,
  };
}

/** Drives a peer all the way to an attached, open DataChannel. Returns the fakes. */
function attachPeer(
  manager: DirectPeerManager,
  peers: FakePeerConnection[],
  sessionId: string,
  ids: { pairId?: string; clientId?: string } = {},
) {
  const pairId = ids.pairId ?? 'pair-1';
  const clientId = ids.clientId ?? 'client-1';
  manager.handleSignal(offerMsg({ pairId, clientId }));
  const pc = peers[peers.length - 1];
  pc.triggerLocalDescription('ANSWER_SDP', 'answer');
  const dc = pc.triggerDataChannel();

  dc.receive({ kind: 'hello', clientId, protocolVersion: DIRECT_PROTOCOL_VERSION });
  dc.receive({ kind: 'attach', sessionId });

  return { pc, dc };
}

describe('DirectPeerManager.handleSignal', () => {
  it('webrtc_offer creates a peer connection, sets the remote description, and answers via sendSignal with matching pairId/clientId', () => {
    const { manager, peers, sendSignalCalls } = makeManager();
    manager.handleSignal(offerMsg());

    const pc = peers[0];
    assert.deepStrictEqual(pc.setRemoteDescriptionCalls, [['OFFER_SDP', 'offer']]);

    pc.triggerLocalDescription('ANSWER_SDP', 'answer');

    assert.strictEqual(sendSignalCalls.length, 1);
    assert.strictEqual(sendSignalCalls[0].type, 'webrtc_answer');
    assert.strictEqual(sendSignalCalls[0].pairId, 'pair-1');
    assert.strictEqual(sendSignalCalls[0].clientId, 'client-1');
    assert.strictEqual(sendSignalCalls[0].payload, 'ANSWER_SDP');
    assert.strictEqual(sendSignalCalls[0].bridgeId, OUR_BRIDGE_ID);
  });

  it('ignores signaling messages addressed to a different bridgeId', () => {
    const { manager, peers, sendSignalCalls } = makeManager();
    manager.handleSignal(offerMsg({ bridgeId: 'some-other-bridge' }));

    assert.strictEqual(peers.length, 0);
    assert.deepStrictEqual(sendSignalCalls, []);
  });

  it('webrtc_close tears down the corresponding peer connection', () => {
    const { manager, peers } = makeManager();
    manager.handleSignal(offerMsg());
    const pc = peers[0];
    assert.strictEqual(pc.closed, false);

    manager.handleSignal({
      type: 'webrtc_close',
      pairId: 'pair-1',
      bridgeId: OUR_BRIDGE_ID,
      clientId: 'client-1',
      payload: '',
    });

    assert.strictEqual(pc.closed, true);
    assert.strictEqual(manager.hasAttachedPeers('sess-1'), false);
  });
});

describe('DirectPeerManager DataChannel protocol', () => {
  it('hello with a mismatched protocol version closes the peer', () => {
    const { manager, peers } = makeManager();
    manager.handleSignal(offerMsg());
    const pc = peers[0];
    pc.triggerLocalDescription('ANSWER_SDP', 'answer');
    const dc = pc.triggerDataChannel();

    dc.receive({ kind: 'hello', clientId: 'client-1', protocolVersion: DIRECT_PROTOCOL_VERSION + 1 });

    assert.ok(pc.closed || dc.closed, 'expected the peer or channel to be closed on version mismatch');
  });

  it('attach triggers onAttach and sends a screen frame before any output frames, with seq starting at 0 and increasing monotonically', () => {
    const attachedSessions: string[] = [];
    const { manager, peers } = makeManager((sessionId) => {
      attachedSessions.push(sessionId);
      return 'CURRENT-SCREEN';
    });

    const { dc } = attachPeer(manager, peers, 'sess-1');
    assert.deepStrictEqual(attachedSessions, ['sess-1']);

    manager.sendOutput('sess-1', 'chunk-1');
    manager.sendOutput('sess-1', 'chunk-2');

    const framesForSession = dc.sent.filter((f) => f.sessionId === 'sess-1');
    assert.strictEqual(framesForSession[0].kind, 'screen');
    assert.strictEqual(framesForSession[0].data, 'CURRENT-SCREEN');
    assert.strictEqual(framesForSession[0].seq, 0);
    assert.strictEqual(framesForSession[1].kind, 'output');
    assert.strictEqual(framesForSession[1].seq, 1);
    assert.strictEqual(framesForSession[2].kind, 'output');
    assert.strictEqual(framesForSession[2].seq, 2);
  });

  it('re-attaching a session resets seq (screen resync per R1/R7)', () => {
    const { manager, peers } = makeManager(() => 'SCREEN');
    const { dc } = attachPeer(manager, peers, 'sess-1');
    manager.sendOutput('sess-1', 'chunk-1'); // seq 1

    dc.receive({ kind: 'attach', sessionId: 'sess-1' }); // re-attach

    const framesAfterReattach = dc.sent.filter((f) => f.sessionId === 'sess-1').slice(-1);
    assert.strictEqual(framesAfterReattach[0].kind, 'screen');
    assert.strictEqual(framesAfterReattach[0].seq, 0);
  });

  it('input and resize frames invoke the callbacks supplied at construction, with the sessionId', () => {
    const { manager, peers, inputCalls, resizeCalls } = makeManager();
    const { dc } = attachPeer(manager, peers, 'sess-1');

    dc.receive({ kind: 'input', sessionId: 'sess-1', data: 'ls\n' });
    dc.receive({ kind: 'resize', sessionId: 'sess-1', cols: 80, rows: 24 });

    assert.deepStrictEqual(inputCalls, [['sess-1', 'ls\n']]);
    assert.deepStrictEqual(resizeCalls, [['sess-1', 80, 24]]);
  });

  it('unknown frame kinds are ignored without throwing and without invoking any callback', () => {
    const { manager, peers, inputCalls } = makeManager();
    const { dc } = attachPeer(manager, peers, 'sess-1');

    assert.doesNotThrow(() => dc.receive({ kind: 'bogus_kind', sessionId: 'sess-1' }));
    assert.deepStrictEqual(inputCalls, []);
  });

  it('hasAttachedPeers reflects whether a session has an attached peer', () => {
    const { manager, peers } = makeManager();
    assert.strictEqual(manager.hasAttachedPeers('sess-1'), false);
    attachPeer(manager, peers, 'sess-1');
    assert.strictEqual(manager.hasAttachedPeers('sess-1'), true);
  });
});

describe('DirectPeerManager.closeAll', () => {
  it('closes every tracked peer connection', () => {
    const { manager, peers } = makeManager();
    manager.handleSignal(offerMsg({ pairId: 'pair-1', clientId: 'client-1' }));
    manager.handleSignal(offerMsg({ pairId: 'pair-2', clientId: 'client-2' }));

    assert.strictEqual(peers.length, 2);
    manager.closeAll();

    assert.ok(peers.every((pc) => pc.closed));
  });
});

describe('DirectPeerManager malformed signal hardening', () => {
  const badPayloadCases: Array<{ name: string; payload: unknown }> = [
    { name: 'empty string', payload: '' },
    { name: 'undefined', payload: undefined },
    { name: 'non-string (object)', payload: { sdp: 'x' } },
  ];

  for (const { name, payload } of badPayloadCases) {
    it(`webrtc_offer with ${name} payload is ignored without creating a peer`, () => {
      const { manager, peers, sendSignalCalls } = makeManager();
      assert.doesNotThrow(() =>
        manager.handleSignal(offerMsg({ payload: payload as never })),
      );
      assert.strictEqual(peers.length, 0);
      assert.deepStrictEqual(sendSignalCalls, []);
    });
  }

  it('webrtc_offer whose SDP is rejected natively does not throw, tears down only that pairing, and emits webrtc_close', () => {
    const { manager, peers, sendSignalCalls } = makeManager(
      () => 'SCREEN',
      (pc, index) => {
        // Second peer connection (the garbage offer) rejects the SDP.
        if (index === 1) pc.failSetRemoteDescription = true;
      },
    );

    // A healthy attached peer that must survive the bad offer.
    const healthy = attachPeer(manager, peers, 'sess-1', { pairId: 'pair-good', clientId: 'client-good' });

    assert.doesNotThrow(() =>
      manager.handleSignal(offerMsg({ pairId: 'pair-bad', clientId: 'client-bad', payload: 'GARBAGE_SDP' })),
    );

    const badPc = peers[1];
    assert.strictEqual(badPc.closed, true, 'bad pairing must be torn down');
    assert.strictEqual(healthy.pc.closed, false, 'healthy peer must be unaffected');
    assert.strictEqual(manager.hasAttachedPeers('sess-1'), true);

    const closes = sendSignalCalls.filter((m) => m.type === 'webrtc_close');
    assert.strictEqual(closes.length, 1);
    assert.strictEqual(closes[0].pairId, 'pair-bad');
    assert.strictEqual(closes[0].clientId, 'client-bad');
    assert.strictEqual(closes[0].bridgeId, OUR_BRIDGE_ID);
  });

  const badIceCases: Array<{ name: string; payload: string }> = [
    { name: 'unparseable JSON', payload: 'not-json{{{' },
    { name: 'JSON without a candidate string', payload: JSON.stringify({ mid: '0' }) },
  ];

  for (const { name, payload } of badIceCases) {
    it(`webrtc_ice with ${name} is dropped without tearing down the peer`, () => {
      const { manager, peers } = makeManager();
      manager.handleSignal(offerMsg());
      const pc = peers[0];

      assert.doesNotThrow(() =>
        manager.handleSignal({ type: 'webrtc_ice', pairId: 'pair-1', bridgeId: OUR_BRIDGE_ID, clientId: 'client-1', payload }),
      );

      assert.strictEqual(pc.closed, false);
      assert.deepStrictEqual(pc.addRemoteCandidateCalls, []);
    });
  }

  it('webrtc_ice whose candidate is rejected natively is dropped without teardown', () => {
    const { manager, peers } = makeManager(() => 'SCREEN', (pc) => {
      pc.failAddRemoteCandidate = true;
    });
    manager.handleSignal(offerMsg());
    const pc = peers[0];

    assert.doesNotThrow(() =>
      manager.handleSignal({
        type: 'webrtc_ice',
        pairId: 'pair-1',
        bridgeId: OUR_BRIDGE_ID,
        clientId: 'client-1',
        payload: JSON.stringify({ candidate: 'candidate:bad', mid: '0' }),
      }),
    );

    assert.strictEqual(pc.closed, false);
  });

  it('a new webrtc_offer for a clientId with an existing live peer tears down the old peer first', () => {
    const { manager, peers } = makeManager(() => 'SCREEN');
    const old = attachPeer(manager, peers, 'sess-1', { pairId: 'pair-old', clientId: 'client-1' });
    assert.strictEqual(manager.hasAttachedPeers('sess-1'), true);

    manager.handleSignal(offerMsg({ pairId: 'pair-new', clientId: 'client-1' }));

    assert.strictEqual(old.pc.closed, true, 'stale peer of the same client must be closed');
    assert.strictEqual(peers.length, 2);
    assert.strictEqual(peers[1].closed, false, 'replacement peer must be live');
    // Old attachment is gone; the new peer has not attached yet.
    assert.strictEqual(manager.hasAttachedPeers('sess-1'), false);
  });
});

describe('DirectPeerManager chunking', () => {
  it('sendScreen larger than the chunk size emits one screen frame (seq 0) plus output continuations (seq 1..n) that reconstruct the input', () => {
    const { manager, peers } = makeManager(() => '');
    const { dc } = attachPeer(manager, peers, 'sess-1');
    dc.sent.length = 0; // discard the attach-time screen frame

    const big = 'x'.repeat(CHUNK_SIZE) + 'y'.repeat(CHUNK_SIZE) + 'z'.repeat(123);
    manager.sendScreen('sess-1', big);

    const frames = dc.sent.filter((f) => f.sessionId === 'sess-1');
    assert.strictEqual(frames.length, 3);
    assert.deepStrictEqual(frames.map((f) => [f.kind, f.seq]), [
      ['screen', 0],
      ['output', 1],
      ['output', 2],
    ]);
    assert.strictEqual(frames.map((f) => f.data).join(''), big);
    assert.ok(frames.every((f) => (f.data as string).length <= CHUNK_SIZE));
  });

  it('sendOutput larger than the chunk size emits multiple output frames with monotonic seq that reconstruct the input', () => {
    const { manager, peers } = makeManager(() => '');
    const { dc } = attachPeer(manager, peers, 'sess-1');
    dc.sent.length = 0;

    const big = 'a'.repeat(CHUNK_SIZE + 1); // exactly two chunks
    manager.sendOutput('sess-1', big);
    manager.sendOutput('sess-1', 'tail'); // seq keeps climbing after the chunked burst

    const frames = dc.sent.filter((f) => f.sessionId === 'sess-1');
    assert.deepStrictEqual(frames.map((f) => f.kind), ['output', 'output', 'output']);
    assert.deepStrictEqual(frames.map((f) => f.seq), [1, 2, 3]);
    assert.strictEqual(frames.slice(0, 2).map((f) => f.data).join(''), big);
    assert.strictEqual(frames[2].data, 'tail');
  });

  it('a send failure on one peer drops the frame without tearing down that peer or affecting other peers', () => {
    const { manager, peers } = makeManager(() => 'SCREEN');
    const good = attachPeer(manager, peers, 'sess-1', { pairId: 'pair-good', clientId: 'client-good' });
    const bad = attachPeer(manager, peers, 'sess-1', { pairId: 'pair-bad', clientId: 'client-bad' });
    good.dc.sent.length = 0;
    bad.dc.failSend = true;

    assert.doesNotThrow(() => manager.sendOutput('sess-1', 'payload'));

    assert.deepStrictEqual(
      good.dc.sent.map((f) => [f.kind, f.data]),
      [['output', 'payload']],
    );
    assert.strictEqual(bad.pc.closed, false, 'failing peer must not be torn down by a send error');
    assert.strictEqual(good.pc.closed, false);

    // The failing peer keeps working once sends succeed again.
    bad.dc.failSend = false;
    manager.sendOutput('sess-1', 'after-recovery');
    assert.ok(bad.dc.sent.some((f) => f.kind === 'output' && f.data === 'after-recovery'));
  });
});

describe('DirectPeerManager pairing timeout', () => {
  const PAIRING_TIMEOUT_MS = 30_000; // private const in peer-manager.ts

  it('a peer whose channel never opens is torn down after the 30s pairing timeout', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { manager, peers } = makeManager();
    manager.handleSignal(offerMsg());
    const pc = peers[0];
    assert.strictEqual(pc.closed, false);

    t.mock.timers.tick(PAIRING_TIMEOUT_MS);

    assert.strictEqual(pc.closed, true);
  });

  it('a peer whose channel opens in time is NOT torn down by the pairing timeout', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { manager, peers } = makeManager(() => 'SCREEN');
    const { pc } = attachPeer(manager, peers, 'sess-1'); // channel open ⇒ keepalive started, pairing timer cleared

    t.mock.timers.tick(PAIRING_TIMEOUT_MS * 2);

    assert.strictEqual(pc.closed, false);
    assert.strictEqual(manager.hasAttachedPeers('sess-1'), true);
  });
});

describe('DirectPeerManager handshake gating', () => {
  it('input and resize frames BEFORE hello are ignored; after hello they flow', () => {
    const { manager, peers, inputCalls, resizeCalls } = makeManager();
    manager.handleSignal(offerMsg());
    const pc = peers[0];
    pc.triggerLocalDescription('ANSWER_SDP', 'answer');
    const dc = pc.triggerDataChannel();

    // Pre-hello: must be dropped.
    dc.receive({ kind: 'input', sessionId: 'sess-1', data: 'evil\n' });
    dc.receive({ kind: 'resize', sessionId: 'sess-1', cols: 10, rows: 5 });
    assert.deepStrictEqual(inputCalls, []);
    assert.deepStrictEqual(resizeCalls, []);

    dc.receive({ kind: 'hello', clientId: 'client-1', protocolVersion: DIRECT_PROTOCOL_VERSION });

    // Post-hello: same frames flow through.
    dc.receive({ kind: 'input', sessionId: 'sess-1', data: 'ls\n' });
    dc.receive({ kind: 'resize', sessionId: 'sess-1', cols: 80, rows: 24 });
    assert.deepStrictEqual(inputCalls, [['sess-1', 'ls\n']]);
    assert.deepStrictEqual(resizeCalls, [['sess-1', 80, 24]]);
  });
});

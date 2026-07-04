import { PeerConnection } from 'node-datachannel';

import {
  DATA_CHANNEL_LABEL,
  DIRECT_PROTOCOL_VERSION,
  PING_INTERVAL_MS,
  STUN_SERVERS,
  type DirectMessage,
  type SignalMessage,
} from './contract.js';

/** Minimal structural view of a node-datachannel DataChannel (injectable for tests). */
export interface DirectDataChannel {
  sendMessage(msg: string): boolean;
  isOpen(): boolean;
  close(): void;
  onOpen(cb: () => void): void;
  onClosed(cb: () => void): void;
  onError(cb: (err: string) => void): void;
  onMessage(cb: (msg: string | Buffer | ArrayBuffer) => void): void;
}

/** Minimal structural view of a node-datachannel PeerConnection (injectable for tests). */
export interface DirectPeerConnection {
  setRemoteDescription(sdp: string, type: string): void;
  addRemoteCandidate(candidate: string, mid: string): void;
  onLocalDescription(cb: (sdp: string, type: string) => void): void;
  onLocalCandidate(cb: (candidate: string, mid: string) => void): void;
  onStateChange(cb: (state: string) => void): void;
  onDataChannel(cb: (dc: DirectDataChannel) => void): void;
  close(): void;
}

export type PeerConnectionFactory = (
  peerName: string,
  config: { iceServers: string[] },
) => DirectPeerConnection;

export interface DirectPeerManagerOptions {
  /** This bridge's identity (as advertised on bridges:presence). */
  bridgeId: string;
  /** Emits bridge-originated answers/ICE over the signaling channel. */
  sendSignal: (msg: SignalMessage) => void;
  /** DataChannel `input` frames feed here (same sink as terminal-input). */
  onInput: (sessionId: string, data: string) => void;
  /** DataChannel `resize` frames feed here (same sink as terminal-input). */
  onResize: (sessionId: string, cols: number, rows: number) => void;
  /** Returns the current full serialized screen for a session on attach. */
  onAttach: (sessionId: string) => string;
  /** node-datachannel PeerConnection factory; defaults to the real module. */
  peerConnectionFactory?: PeerConnectionFactory;
  /** Injectable clock for keepalive/teardown timers (defaults to Date.now). */
  now?: () => number;
}

const ICE_DISCONNECT_GRACE_MS = 10_000;
const MAX_MISSED_PINGS = 2;
/** Peers that never reach channel-open within this window are torn down (leak guard). */
const PAIRING_TIMEOUT_MS = 30_000;
/**
 * Max chars per DataChannel frame `data` field. Worst-case UTF-8 is 4 bytes per
 * 2 chars, so 32k chars stays under ~128 KiB — safely below the ~256 KiB max
 * message size negotiated by libdatachannel and browsers. Larger payloads are
 * chunked: for screens, one `screen` frame (stream reset) followed by `output`
 * continuation frames — receivers apply them sequentially, reconstructing the
 * full serialized screen without any wire-format change.
 */
const MAX_FRAME_DATA_CHARS = 32_000;

function chunkData(data: string): string[] {
  if (data.length <= MAX_FRAME_DATA_CHARS) return [data];
  const chunks: string[] = [];
  for (let i = 0; i < data.length; i += MAX_FRAME_DATA_CHARS) {
    chunks.push(data.slice(i, i + MAX_FRAME_DATA_CHARS));
  }
  return chunks;
}

interface IceCandidatePayload {
  candidate: string;
  mid: string;
}

const defaultPeerConnectionFactory: PeerConnectionFactory = (peerName, config) =>
  // Verified structural match against node-datachannel's PeerConnection surface.
  new PeerConnection(peerName, config) as unknown as DirectPeerConnection;

/**
 * One WebRTC peer (one connection attempt, keyed by pairId). Owns its
 * PeerConnection + DataChannel, per-session monotonic seq, attach set, and
 * keepalive/teardown timers.
 */
class DirectPeer {
  readonly pairId: string;
  readonly clientId: string;
  readonly pc: DirectPeerConnection;
  private readonly manager: DirectPeerManager;
  private dc?: DirectDataChannel;
  private helloOk = false;
  private closed = false;
  private readonly attached = new Set<string>();
  private readonly seq = new Map<string, number>();
  private pingTimer?: ReturnType<typeof setInterval>;
  private missedPings = 0;
  private iceDisconnectTimer?: ReturnType<typeof setTimeout>;
  private pairingTimer?: ReturnType<typeof setTimeout>;

  constructor(
    manager: DirectPeerManager,
    pc: DirectPeerConnection,
    pairId: string,
    clientId: string,
  ) {
    this.manager = manager;
    this.pc = pc;
    this.pairId = pairId;
    this.clientId = clientId;

    pc.onLocalDescription((sdp, type) => {
      if (type === 'answer') {
        this.manager.emitSignal({ type: 'webrtc_answer', pairId, clientId, payload: sdp });
      }
    });
    pc.onLocalCandidate((candidate, mid) => {
      const payload: IceCandidatePayload = { candidate, mid };
      this.manager.emitSignal({ type: 'webrtc_ice', pairId, clientId, payload: JSON.stringify(payload) });
    });
    pc.onStateChange((state) => this.onStateChange(state));
    pc.onDataChannel((dc) => this.bindDataChannel(dc));

    // Leak guard: tear down attempts that never reach channel-open (client
    // vanished pre-ICE); keepalive only starts once the channel opens.
    this.pairingTimer = setTimeout(() => this.manager.teardown(this.pairId), PAIRING_TIMEOUT_MS);
    this.pairingTimer.unref?.();
  }

  hasAttached(sessionId: string): boolean {
    return this.attached.has(sessionId);
  }

  /** Throws on native rejection of the SDP; the manager catches and tears down. */
  applyOffer(sdp: string): void {
    this.pc.setRemoteDescription(sdp, 'offer');
  }

  applyIce(payload: string): void {
    let parsed: IceCandidatePayload;
    try {
      parsed = JSON.parse(payload) as IceCandidatePayload;
    } catch {
      return;
    }
    if (typeof parsed.candidate !== 'string') return;
    try {
      this.pc.addRemoteCandidate(parsed.candidate, parsed.mid ?? '');
    } catch {
      // Malformed candidate ⇒ drop it; ICE can still complete on other candidates.
    }
  }

  sendScreen(sessionId: string, data: string): void {
    if (!this.attached.has(sessionId)) return;
    // Large screens are chunked: `screen` resets the stream (seq 0), `output`
    // continuation frames carry the remainder; receivers apply them in order.
    const chunks = chunkData(data);
    this.seq.set(sessionId, chunks.length - 1);
    this.send({ kind: 'screen', sessionId, data: chunks[0], seq: 0 });
    for (let i = 1; i < chunks.length; i++) {
      this.send({ kind: 'output', sessionId, data: chunks[i], seq: i });
    }
  }

  sendOutput(sessionId: string, data: string): void {
    if (!this.attached.has(sessionId)) return;
    for (const chunk of chunkData(data)) {
      const next = (this.seq.get(sessionId) ?? 0) + 1;
      this.seq.set(sessionId, next);
      this.send({ kind: 'output', sessionId, data: chunk, seq: next });
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.iceDisconnectTimer) clearTimeout(this.iceDisconnectTimer);
    if (this.pairingTimer) clearTimeout(this.pairingTimer);
    this.attached.clear();
    this.seq.clear();
    try { this.dc?.close(); } catch { /* already gone */ }
    try { this.pc.close(); } catch { /* already gone */ }
  }

  private bindDataChannel(dc: DirectDataChannel): void {
    this.dc = dc;
    dc.onMessage((msg) => {
      if (typeof msg !== 'string') return;
      this.handleFrame(msg);
    });
    dc.onClosed(() => this.manager.teardown(this.pairId));
    dc.onError(() => this.manager.teardown(this.pairId));
    if (dc.isOpen()) this.startKeepalive();
    else dc.onOpen(() => this.startKeepalive());
  }

  private startKeepalive(): void {
    if (this.pairingTimer) {
      clearTimeout(this.pairingTimer);
      this.pairingTimer = undefined;
    }
    if (this.pingTimer) return;
    this.missedPings = 0;
    this.pingTimer = setInterval(() => {
      if (this.missedPings >= MAX_MISSED_PINGS) {
        this.manager.teardown(this.pairId);
        return;
      }
      this.missedPings += 1;
      this.send({ kind: 'ping' });
    }, PING_INTERVAL_MS);
    this.pingTimer.unref?.();
  }

  private handleFrame(raw: string): void {
    let msg: DirectMessage;
    try {
      msg = JSON.parse(raw) as DirectMessage;
    } catch {
      return;
    }
    switch (msg.kind) {
      case 'hello': {
        if (msg.protocolVersion !== DIRECT_PROTOCOL_VERSION) {
          this.manager.teardown(this.pairId);
          return;
        }
        this.helloOk = true;
        this.send({ kind: 'hello_ack', bridgeId: this.manager.bridgeId, protocolVersion: DIRECT_PROTOCOL_VERSION });
        return;
      }
      case 'attach': {
        if (!this.helloOk) return;
        this.attached.add(msg.sessionId);
        const screen = this.manager.getScreen(msg.sessionId);
        this.sendScreen(msg.sessionId, screen);
        return;
      }
      case 'detach': {
        this.attached.delete(msg.sessionId);
        this.seq.delete(msg.sessionId);
        return;
      }
      case 'input': {
        if (!this.helloOk) return;
        this.manager.deliverInput(msg.sessionId, msg.data);
        return;
      }
      case 'resize': {
        if (!this.helloOk) return;
        this.manager.deliverResize(msg.sessionId, msg.cols, msg.rows);
        return;
      }
      case 'ping': {
        this.send({ kind: 'pong' });
        return;
      }
      case 'pong': {
        this.missedPings = 0;
        return;
      }
      default:
        // Unknown kind ⇒ ignore.
        return;
    }
  }

  private onStateChange(state: string): void {
    if (state === 'disconnected') {
      if (this.iceDisconnectTimer) return;
      this.iceDisconnectTimer = setTimeout(() => this.manager.teardown(this.pairId), ICE_DISCONNECT_GRACE_MS);
      this.iceDisconnectTimer.unref?.();
    } else if (state === 'connected') {
      if (this.iceDisconnectTimer) {
        clearTimeout(this.iceDisconnectTimer);
        this.iceDisconnectTimer = undefined;
      }
    } else if (state === 'failed' || state === 'closed') {
      this.manager.teardown(this.pairId);
    }
  }

  private send(msg: DirectMessage): void {
    if (this.closed || !this.dc || !this.dc.isOpen()) return;
    try {
      this.dc.sendMessage(JSON.stringify(msg));
    } catch {
      // Drop the frame rather than kill the connection; a genuinely dead
      // channel is detected by onClosed/onError or missed pings.
    }
  }
}

/**
 * Manages client-initiated WebRTC peers behind an injectable node-datachannel
 * factory. Answers offers, relays ICE, and fans terminal output/screen to all
 * attached peers over the `ftown` DataChannel.
 */
export class DirectPeerManager {
  readonly bridgeId: string;
  private readonly sendSignalCb: (msg: SignalMessage) => void;
  private readonly onInputCb: (sessionId: string, data: string) => void;
  private readonly onResizeCb: (sessionId: string, cols: number, rows: number) => void;
  private readonly onAttachCb: (sessionId: string) => string;
  private readonly factory: PeerConnectionFactory;
  private readonly peers = new Map<string, DirectPeer>();

  constructor(options: DirectPeerManagerOptions) {
    this.bridgeId = options.bridgeId;
    this.sendSignalCb = options.sendSignal;
    this.onInputCb = options.onInput;
    this.onResizeCb = options.onResize;
    this.onAttachCb = options.onAttach;
    this.factory = options.peerConnectionFactory ?? defaultPeerConnectionFactory;
  }

  /** Never throws — a malformed signal must not propagate into the publication listener. */
  handleSignal(msg: SignalMessage): void {
    if (msg.bridgeId !== this.bridgeId) return;
    if (typeof msg.pairId !== 'string' || msg.pairId === '') return;
    try {
      switch (msg.type) {
        case 'webrtc_offer': {
          if (typeof msg.payload !== 'string' || msg.payload === '') return;
          if (typeof msg.clientId !== 'string' || msg.clientId === '') return;
          // Replace any prior pairing for this pairId AND any stale peer of the
          // same client (reconnect) so a session never gets duplicate frames.
          this.teardown(msg.pairId);
          for (const peer of [...this.peers.values()]) {
            if (peer.clientId === msg.clientId) this.teardown(peer.pairId);
          }
          const pc = this.factory(`ftown-${msg.pairId}`, { iceServers: [...STUN_SERVERS] });
          const peer = new DirectPeer(this, pc, msg.pairId, msg.clientId);
          this.peers.set(msg.pairId, peer);
          try {
            peer.applyOffer(msg.payload);
          } catch {
            // Malformed SDP: abort just this pairing attempt and tell the client.
            this.teardown(msg.pairId);
            this.emitSignal({ type: 'webrtc_close', pairId: msg.pairId, clientId: msg.clientId, payload: '' });
          }
          return;
        }
        case 'webrtc_ice': {
          if (typeof msg.payload !== 'string') return;
          this.peers.get(msg.pairId)?.applyIce(msg.payload);
          return;
        }
        case 'webrtc_close': {
          this.teardown(msg.pairId);
          return;
        }
        default:
          // webrtc_answer (our own echo) and anything else ⇒ ignore.
          return;
      }
    } catch (err) {
      console.error('[DirectTransport] Failed to handle signal:', err);
    }
  }

  sendOutput(sessionId: string, data: string): void {
    for (const peer of this.peers.values()) peer.sendOutput(sessionId, data);
  }

  sendScreen(sessionId: string, data: string): void {
    for (const peer of this.peers.values()) peer.sendScreen(sessionId, data);
  }

  hasAttachedPeers(sessionId: string): boolean {
    for (const peer of this.peers.values()) {
      if (peer.hasAttached(sessionId)) return true;
    }
    return false;
  }

  closeAll(): void {
    for (const peer of this.peers.values()) peer.close();
    this.peers.clear();
  }

  teardown(pairId: string): void {
    const peer = this.peers.get(pairId);
    if (!peer) return;
    this.peers.delete(pairId);
    peer.close();
  }

  emitSignal(partial: Omit<SignalMessage, 'bridgeId'>): void {
    this.sendSignalCb({ ...partial, bridgeId: this.bridgeId });
  }

  getScreen(sessionId: string): string {
    return this.onAttachCb(sessionId);
  }

  deliverInput(sessionId: string, data: string): void {
    this.onInputCb(sessionId, data);
  }

  deliverResize(sessionId: string, cols: number, rows: number): void {
    this.onResizeCb(sessionId, cols, rows);
  }
}

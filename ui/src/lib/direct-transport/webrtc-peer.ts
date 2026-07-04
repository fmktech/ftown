import {
  DIRECT_PROTOCOL_VERSION,
  DATA_CHANNEL_LABEL,
  STUN_SERVERS,
  PAIR_TIMEOUT_MS,
  PING_INTERVAL_MS,
  type DirectMessage,
  type SignalMessage,
  type TerminalDataHandlers,
} from './contract';

export interface WebRtcPeerOptions {
  bridgeId: string;
  clientId: string;
  sendSignal: (msg: SignalMessage) => void;
}

/** Public surface of {@link WebRtcPeer}; kept structural so tests can inject a fake. */
export interface WebRtcPeerApi {
  connect(): Promise<void>;
  attach(sessionId: string, handlers: TerminalDataHandlers): void;
  detach(sessionId: string): void;
  sendInput(sessionId: string, data: string): void;
  sendResize(sessionId: string, cols: number, rows: number): void;
  handleSignal(msg: SignalMessage): void;
  close(): void;
  onClose(cb: () => void): void;
}

export type WebRtcPeerFactory = (opts: WebRtcPeerOptions) => WebRtcPeerApi;

/**
 * Browser-native RTCPeerConnection wrapper implementing the client side of the
 * direct-transport DataChannel protocol and signaling. No npm deps.
 */
export class WebRtcPeer implements WebRtcPeerApi {
  private readonly bridgeId: string;
  private readonly clientId: string;
  private readonly sendSignal: (msg: SignalMessage) => void;
  private readonly pairId: string;

  private pc: RTCPeerConnection | null = null;
  private channel: RTCDataChannel | null = null;

  private connectPromise: Promise<void> | null = null;
  private resolveConnect: (() => void) | null = null;
  private rejectConnect: ((err: Error) => void) | null = null;
  private settled = false;

  private pairTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private missedPongs = 0;

  private remoteSet = false;
  private readonly pendingIce: RTCIceCandidateInit[] = [];

  private closed = false;

  private readonly handlers = new Map<string, TerminalDataHandlers>();
  private readonly closeCbs = new Set<() => void>();

  constructor(opts: WebRtcPeerOptions) {
    this.bridgeId = opts.bridgeId;
    this.clientId = opts.clientId;
    this.sendSignal = opts.sendSignal;
    this.pairId = crypto.randomUUID();
  }

  connect(): Promise<void> {
    if (this.connectPromise) return this.connectPromise;
    this.connectPromise = new Promise<void>((resolve, reject) => {
      this.resolveConnect = resolve;
      this.rejectConnect = reject;
    });
    this.pairTimer = setTimeout(() => this.fail(new Error('pair timeout')), PAIR_TIMEOUT_MS);
    void this.startPairing().catch((err) => this.fail(err instanceof Error ? err : new Error(String(err))));
    return this.connectPromise;
  }

  private async startPairing(): Promise<void> {
    const pc = new RTCPeerConnection({ iceServers: [{ urls: STUN_SERVERS }] });
    this.pc = pc;

    pc.onicecandidate = (ev) => {
      if (ev.candidate) {
        this.sendSignal({
          type: 'webrtc_ice',
          pairId: this.pairId,
          bridgeId: this.bridgeId,
          clientId: this.clientId,
          payload: JSON.stringify(ev.candidate.toJSON()),
        });
      }
    };
    pc.oniceconnectionstatechange = () => {
      const state = pc.iceConnectionState;
      if (state === 'failed' || state === 'closed') {
        this.fail(new Error(`ice ${state}`));
      }
    };

    const channel = pc.createDataChannel(DATA_CHANNEL_LABEL, { ordered: true });
    this.channel = channel;
    channel.onopen = () => this.onChannelOpen();
    channel.onmessage = (ev) => this.onFrame(ev.data);
    channel.onclose = () => this.close();
    channel.onerror = () => this.fail(new Error('datachannel error'));

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    this.sendSignal({
      type: 'webrtc_offer',
      pairId: this.pairId,
      bridgeId: this.bridgeId,
      clientId: this.clientId,
      payload: offer.sdp ?? '',
    });
  }

  private onChannelOpen(): void {
    this.send({ kind: 'hello', clientId: this.clientId, protocolVersion: DIRECT_PROTOCOL_VERSION });
  }

  private onFrame(raw: unknown): void {
    if (typeof raw !== 'string') return;
    let msg: DirectMessage;
    try {
      msg = JSON.parse(raw) as DirectMessage;
    } catch {
      return;
    }
    switch (msg.kind) {
      case 'hello_ack':
        if (msg.protocolVersion !== DIRECT_PROTOCOL_VERSION) {
          this.close();
          return;
        }
        if (this.pairTimer) {
          clearTimeout(this.pairTimer);
          this.pairTimer = null;
        }
        this.startPing();
        this.resolve();
        break;
      case 'screen':
        this.handlers.get(msg.sessionId)?.onScreen(msg.data);
        break;
      case 'output':
        this.handlers.get(msg.sessionId)?.onOutput(msg.data);
        break;
      case 'ping':
        this.send({ kind: 'pong' });
        break;
      case 'pong':
        this.missedPongs = 0;
        break;
      default:
        break;
    }
  }

  private startPing(): void {
    this.pingTimer = setInterval(() => {
      if (this.missedPongs >= 2) {
        this.close();
        return;
      }
      this.missedPongs++;
      this.send({ kind: 'ping' });
    }, PING_INTERVAL_MS);
  }

  handleSignal(msg: SignalMessage): void {
    if (this.closed) return;
    if (msg.clientId !== this.clientId || msg.pairId !== this.pairId || msg.bridgeId !== this.bridgeId) {
      return;
    }
    switch (msg.type) {
      case 'webrtc_answer':
        void this.applyAnswer(msg.payload);
        break;
      case 'webrtc_ice':
        this.addIce(msg.payload);
        break;
      case 'webrtc_close':
        this.close();
        break;
      default:
        break;
    }
  }

  private async applyAnswer(sdp: string): Promise<void> {
    if (!this.pc) return;
    try {
      await this.pc.setRemoteDescription({ type: 'answer', sdp });
      this.remoteSet = true;
      for (const candidate of this.pendingIce.splice(0)) {
        void this.pc.addIceCandidate(candidate).catch(() => {});
      }
    } catch (err) {
      this.fail(err instanceof Error ? err : new Error('setRemoteDescription failed'));
    }
  }

  private addIce(payload: string): void {
    let candidate: RTCIceCandidateInit;
    try {
      candidate = JSON.parse(payload) as RTCIceCandidateInit;
    } catch {
      return;
    }
    if (!this.pc || !this.remoteSet) {
      this.pendingIce.push(candidate);
      return;
    }
    void this.pc.addIceCandidate(candidate).catch(() => {});
  }

  attach(sessionId: string, handlers: TerminalDataHandlers): void {
    this.handlers.set(sessionId, handlers);
    this.send({ kind: 'attach', sessionId });
  }

  detach(sessionId: string): void {
    this.handlers.delete(sessionId);
    this.send({ kind: 'detach', sessionId });
  }

  sendInput(sessionId: string, data: string): void {
    this.send({ kind: 'input', sessionId, data });
  }

  sendResize(sessionId: string, cols: number, rows: number): void {
    this.send({ kind: 'resize', sessionId, cols, rows });
  }

  private send(msg: DirectMessage): void {
    const ch = this.channel;
    if (ch && ch.readyState === 'open') {
      ch.send(JSON.stringify(msg));
    }
  }

  onClose(cb: () => void): void {
    if (this.closed) {
      cb();
      return;
    }
    this.closeCbs.add(cb);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;

    if (this.pairTimer) {
      clearTimeout(this.pairTimer);
      this.pairTimer = null;
    }
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }

    if (this.channel) {
      try {
        this.channel.close();
      } catch {
        // ignore
      }
      this.channel = null;
    }
    if (this.pc) {
      // Best-effort notify the bridge to tear down its peer.
      this.sendSignal({
        type: 'webrtc_close',
        pairId: this.pairId,
        bridgeId: this.bridgeId,
        clientId: this.clientId,
        payload: '',
      });
      try {
        this.pc.close();
      } catch {
        // ignore
      }
      this.pc = null;
    }

    if (!this.settled) {
      this.reject(new Error('peer closed'));
    }

    for (const cb of this.closeCbs) cb();
    this.closeCbs.clear();
    this.handlers.clear();
  }

  private fail(err: Error): void {
    if (!this.settled) this.reject(err);
    this.close();
  }

  private resolve(): void {
    if (this.settled) return;
    this.settled = true;
    this.resolveConnect?.();
  }

  private reject(err: Error): void {
    if (this.settled) return;
    this.settled = true;
    this.rejectConnect?.(err);
  }
}

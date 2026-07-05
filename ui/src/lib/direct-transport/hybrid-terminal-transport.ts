import {
  WATCH_HEARTBEAT_MS,
  type DirectCommandMessage,
  type FallbackReason,
  type SignalMessage,
  type TerminalDataHandlers,
  type TerminalTransportApi,
  type TerminalTransportMode,
} from './contract';
import {
  WebRtcPeer,
  type WebRtcPeerApi,
  type WebRtcPeerFactory,
} from './webrtc-peer';

/** Minimal structural view of the Centrifuge client — only what this module uses. */
export interface CentrifugoSubscriptionLike {
  subscribe(): void;
  unsubscribe(): void;
  publish(data: unknown): Promise<unknown>;
  on(event: 'publication', listener: (ctx: { data: unknown }) => void): unknown;
  on(event: 'subscribed', listener: () => void): unknown;
  removeAllListeners(): unknown;
}

export interface CentrifugoClientLike {
  newSubscription(channel: string): CentrifugoSubscriptionLike;
  getSubscription(channel: string): CentrifugoSubscriptionLike | null;
  removeSubscription(sub: CentrifugoSubscriptionLike | null): void;
}

export interface HybridTerminalTransportOptions {
  centrifuge: CentrifugoClientLike;
  userId: string;
  clientId: string;
  publishCommand: (msg: DirectCommandMessage) => void;
  /** Injectable for tests; defaults to the real {@link WebRtcPeer}. */
  peerFactory?: WebRtcPeerFactory;
}

type PeerStatus = 'connecting' | 'direct' | 'failed';

interface PeerEntry {
  peer: WebRtcPeerApi | null;
  status: PeerStatus;
  sessions: Set<string>;
  /** Why this bridge's peer is on the failed/fallback path; null while connecting/direct. */
  reason: FallbackReason;
}

interface SessionEntry {
  sessionId: string;
  bridgeId: string;
  handlers: TerminalDataHandlers;
  mode: TerminalTransportMode;
  direct: boolean;
  disposed: boolean;
  outputSub: CentrifugoSubscriptionLike | null;
  inputSub: CentrifugoSubscriptionLike | null;
  watchTimer: ReturnType<typeof setInterval> | null;
  /** Why this session is on the centrifugo path; null when direct/connecting. */
  reason: FallbackReason;
}

/**
 * Hybrid terminal transport: prefers a WebRTC DataChannel (one peer per bridge,
 * shared across that bridge's sessions) and falls back to Centrifugo per R1/R3
 * on pairing failure/timeout or peer close.
 */
export class HybridTerminalTransport implements TerminalTransportApi {
  private readonly client: CentrifugoClientLike;
  private readonly userId: string;
  private readonly clientId: string;
  private readonly publishCommand: (msg: DirectCommandMessage) => void;
  private readonly peerFactory: WebRtcPeerFactory;

  private readonly peers = new Map<string, PeerEntry>();
  private readonly sessions = new Map<string, SessionEntry>();
  private readonly modeChangeCbs = new Set<(sessionId: string, mode: TerminalTransportMode) => void>();
  private disposed = false;

  constructor(opts: HybridTerminalTransportOptions) {
    this.client = opts.centrifuge;
    this.userId = opts.userId;
    this.clientId = opts.clientId;
    this.publishCommand = opts.publishCommand;
    this.peerFactory = opts.peerFactory ?? ((o) => new WebRtcPeer(o));
  }

  subscribeTerminal(
    sessionId: string,
    bridgeId: string,
    handlers: TerminalDataHandlers,
  ): () => void {
    if (this.disposed) return () => {};

    // Replace any existing subscription for this session.
    const prior = this.sessions.get(sessionId);
    if (prior) this.teardownSession(prior);

    const entry: SessionEntry = {
      sessionId,
      bridgeId,
      handlers,
      mode: 'connecting',
      direct: false,
      disposed: false,
      outputSub: null,
      inputSub: null,
      watchTimer: null,
      reason: null,
    };
    this.sessions.set(sessionId, entry);

    const pe = this.ensurePeer(bridgeId);
    pe.sessions.add(sessionId);

    if (pe.status === 'direct' && pe.peer) {
      this.goDirect(entry, pe.peer);
    } else if (pe.status === 'failed') {
      this.goCentrifugo(entry, pe.reason);
    }
    // 'connecting': stay in the default 'connecting' mode until the peer resolves.

    return () => this.unsubscribe(sessionId);
  }

  sendInput(sessionId: string, data: string): void {
    const entry = this.sessions.get(sessionId);
    if (!entry) return;
    if (entry.direct) {
      this.peers.get(entry.bridgeId)?.peer?.sendInput(sessionId, data);
    } else if (entry.inputSub) {
      void entry.inputSub.publish({ type: 'input', data });
    }
  }

  sendResize(sessionId: string, cols: number, rows: number): void {
    const entry = this.sessions.get(sessionId);
    if (!entry) return;
    if (entry.direct) {
      this.peers.get(entry.bridgeId)?.peer?.sendResize(sessionId, cols, rows);
    } else if (entry.inputSub) {
      void entry.inputSub.publish({ type: 'resize', cols, rows });
    }
  }

  getMode(sessionId: string): TerminalTransportMode {
    return this.sessions.get(sessionId)?.mode ?? 'connecting';
  }

  getFallbackReason(sessionId: string): FallbackReason {
    return this.sessions.get(sessionId)?.reason ?? null;
  }

  onModeChange(cb: (sessionId: string, mode: TerminalTransportMode) => void): () => void {
    this.modeChangeCbs.add(cb);
    return () => {
      this.modeChangeCbs.delete(cb);
    };
  }

  /**
   * Feed inbound signaling (webrtc_answer/webrtc_ice/webrtc_close) received on
   * commands:rpc into the matching bridge peer. Not part of TerminalTransportApi;
   * the wiring layer routes signals here.
   */
  handleSignal(msg: SignalMessage): void {
    this.peers.get(msg.bridgeId)?.peer?.handleSignal(msg);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;

    for (const entry of this.sessions.values()) {
      this.teardownSession(entry);
    }
    this.sessions.clear();

    for (const pe of this.peers.values()) {
      pe.peer?.close();
    }
    this.peers.clear();
    this.modeChangeCbs.clear();
  }

  // --- internals ---------------------------------------------------------

  private ensurePeer(bridgeId: string): PeerEntry {
    const existing = this.peers.get(bridgeId);
    if (existing) return existing;

    let peer: WebRtcPeerApi;
    try {
      peer = this.peerFactory({
        bridgeId,
        clientId: this.clientId,
        sendSignal: (m) => this.publishCommand(m),
      });
    } catch {
      // WebRTC unsupported/blocked (e.g. Safari): fall back for this bridge.
      const failed: PeerEntry = {
        peer: null,
        status: 'failed',
        sessions: new Set(),
        reason: 'pairing_failed',
      };
      this.peers.set(bridgeId, failed);
      return failed;
    }

    const pe: PeerEntry = { peer, status: 'connecting', sessions: new Set(), reason: null };
    this.peers.set(bridgeId, pe);

    peer.onClose(() => this.onPeerDown(bridgeId));
    peer
      .connect()
      .then(() => this.onPeerUp(bridgeId))
      .catch(() => this.onPeerDown(bridgeId));

    return pe;
  }

  private onPeerUp(bridgeId: string): void {
    if (this.disposed) return;
    const pe = this.peers.get(bridgeId);
    if (!pe || !pe.peer || pe.status === 'direct') return;
    pe.status = 'direct';
    for (const sessionId of pe.sessions) {
      const entry = this.sessions.get(sessionId);
      if (entry && !entry.disposed && !entry.direct) {
        this.goDirect(entry, pe.peer);
      }
    }
  }

  private onPeerDown(bridgeId: string): void {
    const pe = this.peers.get(bridgeId);
    if (!pe || pe.status === 'failed') return;
    // A peer that reached 'direct' was an open connection that closed mid-session;
    // one still 'connecting' never finished pairing at all.
    const reason: FallbackReason = pe.status === 'direct' ? 'peer_lost' : 'pairing_failed';
    pe.status = 'failed';
    pe.peer = null;
    pe.reason = reason;
    if (this.disposed) return;
    for (const sessionId of pe.sessions) {
      const entry = this.sessions.get(sessionId);
      if (entry && !entry.disposed) {
        this.goCentrifugo(entry, reason);
      }
    }
  }

  private goDirect(entry: SessionEntry, peer: WebRtcPeerApi): void {
    if (entry.disposed) return;
    entry.direct = true;
    entry.reason = null;
    // Bridge replies to attach with a `screen` frame before any `output` (R1).
    peer.attach(entry.sessionId, {
      onScreen: (data) => entry.handlers.onScreen(data),
      onOutput: (data) => entry.handlers.onOutput(data),
    });
    this.setMode(entry, 'direct');
  }

  private goCentrifugo(entry: SessionEntry, reason: FallbackReason): void {
    entry.reason = reason;
    if (entry.disposed || entry.mode === 'centrifugo') return;
    entry.direct = false;

    const outputChannel = `terminal:${entry.sessionId}#${this.userId}`;
    this.dropSubscription(outputChannel);
    const outputSub = this.client.newSubscription(outputChannel);
    outputSub.on('publication', (ctx) => {
      const msg = ctx.data as { type?: string; data?: string; raw?: string; lines?: string[] };
      if (msg.type === 'output' && typeof msg.data === 'string') {
        entry.handlers.onOutput(msg.data);
      } else if (msg.type === 'screen_dump') {
        const screen = msg.raw ?? (Array.isArray(msg.lines) ? msg.lines.join('\r\n') : '');
        entry.handlers.onScreen(screen);
      }
    });
    // Send terminal_watch only once the subscription is active: the bridge
    // reacts to the watch with a screen_dump, which would be lost if published
    // before we are subscribed (fresh subscribes don't recover history).
    // Centrifuge re-emits 'subscribed' after reconnects — re-sending a single
    // watch then refreshes the bridge watcher after possible TTL expiry, but
    // the heartbeat interval must not stack (R3).
    outputSub.on('subscribed', () => {
      if (entry.disposed) return;
      this.sendWatch('terminal_watch', entry.sessionId);
      if (entry.watchTimer === null) {
        entry.watchTimer = setInterval(
          () => this.sendWatch('terminal_watch', entry.sessionId),
          WATCH_HEARTBEAT_MS,
        );
      }
    });
    outputSub.subscribe();
    entry.outputSub = outputSub;

    const inputChannel = `terminal-input:${entry.sessionId}#${this.userId}`;
    this.dropSubscription(inputChannel);
    const inputSub = this.client.newSubscription(inputChannel);
    inputSub.subscribe();
    entry.inputSub = inputSub;

    this.setMode(entry, 'centrifugo');
  }

  private sendWatch(type: 'terminal_watch' | 'terminal_unwatch', sessionId: string): void {
    this.publishCommand({ type, sessionId, clientId: this.clientId });
  }

  private dropSubscription(channel: string): void {
    const existing = this.client.getSubscription(channel);
    if (existing) {
      existing.removeAllListeners();
      existing.unsubscribe();
      this.client.removeSubscription(existing);
    }
  }

  private unsubscribe(sessionId: string): void {
    const entry = this.sessions.get(sessionId);
    if (!entry) return;
    this.teardownSession(entry);
    this.sessions.delete(sessionId);
    this.peers.get(entry.bridgeId)?.sessions.delete(sessionId);
  }

  private teardownSession(entry: SessionEntry): void {
    if (entry.disposed) return;
    entry.disposed = true;

    if (entry.direct) {
      this.peers.get(entry.bridgeId)?.peer?.detach(entry.sessionId);
    } else if (entry.mode === 'centrifugo') {
      this.sendWatch('terminal_unwatch', entry.sessionId);
    }

    if (entry.watchTimer) {
      clearInterval(entry.watchTimer);
      entry.watchTimer = null;
    }
    if (entry.outputSub) {
      entry.outputSub.removeAllListeners();
      entry.outputSub.unsubscribe();
      this.client.removeSubscription(entry.outputSub);
      entry.outputSub = null;
    }
    if (entry.inputSub) {
      entry.inputSub.removeAllListeners();
      entry.inputSub.unsubscribe();
      this.client.removeSubscription(entry.inputSub);
      entry.inputSub = null;
    }
  }

  private setMode(entry: SessionEntry, mode: TerminalTransportMode): void {
    if (entry.mode === mode) return;
    entry.mode = mode;
    for (const cb of this.modeChangeCbs) cb(entry.sessionId, mode);
  }
}

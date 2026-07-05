import {
  LOOPBACK_TIMEOUT_MS,
  WATCH_HEARTBEAT_MS,
  type BridgeLocalAdvert,
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
import {
  LoopbackPeer,
  type LoopbackPeerApi,
  type LoopbackPeerFactory,
} from './loopback-peer';

/** Any active data-plane peer: the loopback WS rung or the WebRTC rung. */
type DirectPeerApi = WebRtcPeerApi | LoopbackPeerApi;

/** Presence result shape used to read a bridge's local advert (subset of centrifuge). */
interface CentrifugoPresenceResult {
  clients: Record<string, { connInfo?: unknown }>;
}

/** Minimal structural view of the Centrifuge client — only what this module uses. */
export interface CentrifugoSubscriptionLike {
  subscribe(): void;
  unsubscribe(): void;
  publish(data: unknown): Promise<unknown>;
  on(event: 'publication', listener: (ctx: { data: unknown }) => void): unknown;
  on(event: 'subscribed', listener: () => void): unknown;
  removeAllListeners(): unknown;
  /** Optional: only the bridges:presence subscription implements this. */
  presence?(): Promise<CentrifugoPresenceResult>;
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
  /** Injectable for tests; defaults to the real {@link LoopbackPeer}. */
  loopbackPeerFactory?: LoopbackPeerFactory;
  /**
   * Resolve a bridge's advertised loopback info (L6). Defaults to querying
   * presence on `bridges:presence#{userId}` via the injected centrifuge client;
   * resolves null when no advert is visible (⇒ loopback rung skipped).
   */
  getLocalAdvert?: (bridgeId: string) => Promise<BridgeLocalAdvert | null>;
}

type PeerStatus = 'connecting' | 'attached' | 'failed';

interface PeerEntry {
  peer: DirectPeerApi | null;
  status: PeerStatus;
  /** Which rung is currently attached; null while connecting/failed. */
  kind: 'local' | 'webrtc' | null;
  sessions: Set<string>;
  /** Why this bridge's peer is on the failed/fallback path; null while connecting/attached. */
  reason: FallbackReason;
}

/** Buffered resize while a session is still on the ladder — latest wins. */
interface PendingResize {
  cols: number;
  rows: number;
}

/**
 * Max UTF-16 code units of input buffered during the connecting window before
 * drop-oldest kicks in (an oversized single chunk keeps its tail instead).
 */
const MAX_PENDING_INPUT_CHARS = 64 * 1024;

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
  /** FIFO input buffered while the ladder runs (mode 'connecting'). */
  pendingInput: string[];
  pendingInputChars: number;
  /** Latest resize buffered while the ladder runs; coalesced to newest only. */
  pendingResize: PendingResize | null;
}

/**
 * Hybrid terminal transport with a per-bridge transport ladder
 * (loopback WS → WebRTC DataChannel → Centrifugo). One peer per bridge, shared
 * across that bridge's sessions. Falls back to Centrifugo per R1/R3 once both
 * direct rungs are exhausted, or when an attached rung closes mid-session.
 * Input/resize issued during the connecting window are buffered and flushed once
 * on activation so the first paint is correctly sized and no keystrokes are lost.
 */
export class HybridTerminalTransport implements TerminalTransportApi {
  private readonly client: CentrifugoClientLike;
  private readonly userId: string;
  private readonly clientId: string;
  private readonly publishCommand: (msg: DirectCommandMessage) => void;
  private readonly peerFactory: WebRtcPeerFactory;
  private readonly loopbackPeerFactory: LoopbackPeerFactory;
  private readonly getLocalAdvert: (bridgeId: string) => Promise<BridgeLocalAdvert | null>;
  /** Whether a loopback advert source was injected (vs the default presence query). */
  private readonly advertInjected: boolean;

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
    this.loopbackPeerFactory = opts.loopbackPeerFactory ?? ((o) => new LoopbackPeer(o));
    this.getLocalAdvert = opts.getLocalAdvert ?? ((bridgeId) => this.defaultGetLocalAdvert(bridgeId));
    this.advertInjected = typeof opts.getLocalAdvert === 'function';
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
      pendingInput: [],
      pendingInputChars: 0,
      pendingResize: null,
    };
    this.sessions.set(sessionId, entry);

    const pe = this.ensurePeer(bridgeId);
    pe.sessions.add(sessionId);

    if (pe.status === 'attached' && pe.peer) {
      this.goDirect(entry, pe.peer, this.modeForKind(pe.kind));
    } else if (pe.status === 'failed') {
      this.goCentrifugo(entry, pe.reason);
    }
    // 'connecting': stay in the default 'connecting' mode until the ladder resolves.

    return () => this.unsubscribe(sessionId);
  }

  sendInput(sessionId: string, data: string): void {
    const entry = this.sessions.get(sessionId);
    if (!entry || entry.disposed) return;
    if (this.hasActivePath(entry)) {
      this.dispatchInput(entry, data);
    } else {
      this.bufferInput(entry, data);
    }
  }

  sendResize(sessionId: string, cols: number, rows: number): void {
    const entry = this.sessions.get(sessionId);
    if (!entry || entry.disposed) return;
    if (this.hasActivePath(entry)) {
      this.dispatchResize(entry, cols, rows);
    } else {
      // Coalesce to the latest requested size — the pty only needs the final one.
      entry.pendingResize = { cols, rows };
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
   * the wiring layer routes signals here. Loopback peers have no signaling plane.
   */
  handleSignal(msg: SignalMessage): void {
    const peer = this.peers.get(msg.bridgeId)?.peer;
    if (peer && 'handleSignal' in peer) peer.handleSignal(msg);
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

  // --- ladder ------------------------------------------------------------

  private ensurePeer(bridgeId: string): PeerEntry {
    const existing = this.peers.get(bridgeId);
    if (existing) return existing;

    const pe: PeerEntry = {
      peer: null,
      status: 'connecting',
      kind: null,
      sessions: new Set(),
      reason: null,
    };
    this.peers.set(bridgeId, pe);
    void this.runLadder(bridgeId);
    return pe;
  }

  /** loopback (if advertised) → WebRTC → Centrifugo, per bridge. */
  private async runLadder(bridgeId: string): Promise<void> {
    // Only await the (async) advert lookup when a loopback rung is actually
    // possible. Otherwise fall through with NO await before tryWebRtc, so the
    // WebRTC peer is constructed synchronously (preserves pre-addendum timing).
    if (this.hasLoopbackAdvertChance()) {
      let advert: BridgeLocalAdvert | null = null;
      try {
        advert = await this.getLocalAdvert(bridgeId);
      } catch {
        advert = null;
      }
      if (!this.isStillConnecting(bridgeId)) return;

      if (advert && (await this.tryLoopback(bridgeId, advert))) return;
      if (!this.isStillConnecting(bridgeId)) return;
    }

    if (await this.tryWebRtc(bridgeId)) return;
    if (!this.isStillConnecting(bridgeId)) return;

    this.finalizeFailed(bridgeId, 'pairing_failed');
  }

  /**
   * Cheap synchronous probe: could the loopback rung ever yield an advert?
   * Get-or-creates the shared bridges:presence subscription (same shared-
   * subscription pattern as useCentrifugo/useSessions), so a fresh page load —
   * where useBridges has not mounted the subscription yet — still gets a
   * loopback attempt. Only false when the subscription object genuinely cannot
   * report presence (no `presence` method, e.g. minimal test fakes) — that keeps
   * the no-advert ladder synchronous through to the WebRTC rung.
   */
  private hasLoopbackAdvertChance(): boolean {
    if (this.advertInjected) return true;
    return typeof this.ensurePresenceSub().presence === 'function';
  }

  private async tryLoopback(bridgeId: string, advert: BridgeLocalAdvert): Promise<boolean> {
    const pe = this.peers.get(bridgeId);
    if (!pe) return false;

    let peer: LoopbackPeerApi;
    try {
      peer = this.loopbackPeerFactory({
        bridgeId,
        clientId: this.clientId,
        port: advert.localPort,
        nonce: advert.localNonce,
      });
    } catch {
      // Synchronous construction throw (e.g. Safari mixed-content) → next rung.
      return false;
    }
    pe.peer = peer;

    try {
      await peer.connect();
    } catch {
      pe.peer = null;
      peer.close();
      return false;
    }
    if (!this.isStillConnecting(bridgeId)) {
      peer.close();
      if (pe.peer === peer) pe.peer = null;
      return false;
    }
    this.attachPeer(bridgeId, peer, 'local');
    return true;
  }

  private async tryWebRtc(bridgeId: string): Promise<boolean> {
    const pe = this.peers.get(bridgeId);
    if (!pe) return false;

    let peer: WebRtcPeerApi;
    try {
      peer = this.peerFactory({
        bridgeId,
        clientId: this.clientId,
        sendSignal: (m) => this.publishCommand(m),
      });
    } catch {
      // WebRTC unsupported/blocked (e.g. Safari): next rung.
      return false;
    }
    // Must be routable for inbound answer/ICE while pairing is in flight.
    pe.peer = peer;

    try {
      await peer.connect();
    } catch {
      pe.peer = null;
      peer.close();
      return false;
    }
    if (!this.isStillConnecting(bridgeId)) {
      peer.close();
      if (pe.peer === peer) pe.peer = null;
      return false;
    }
    this.attachPeer(bridgeId, peer, 'webrtc');
    return true;
  }

  private isStillConnecting(bridgeId: string): boolean {
    const pe = this.peers.get(bridgeId);
    return !this.disposed && !!pe && pe.status === 'connecting';
  }

  private attachPeer(bridgeId: string, peer: DirectPeerApi, kind: 'local' | 'webrtc'): void {
    const pe = this.peers.get(bridgeId);
    if (!pe) return;
    pe.peer = peer;
    pe.status = 'attached';
    pe.kind = kind;
    pe.reason = null;

    // An attached rung that later closes drops the session straight to Centrifugo
    // with reason 'peer_lost' — no retry of the other rung (matches R1 philosophy).
    peer.onClose(() => this.onPeerDown(bridgeId));

    const mode = this.modeForKind(kind);
    for (const sessionId of pe.sessions) {
      const entry = this.sessions.get(sessionId);
      if (entry && !entry.disposed && !entry.direct) {
        this.goDirect(entry, peer, mode);
      }
    }
  }

  private onPeerDown(bridgeId: string): void {
    const pe = this.peers.get(bridgeId);
    if (!pe || pe.status !== 'attached') return;
    // Only attached peers register onClose; an attached rung closing mid-session
    // is a lost connection, not a pairing failure.
    this.finalizeFailed(bridgeId, 'peer_lost');
  }

  private finalizeFailed(bridgeId: string, reason: FallbackReason): void {
    const pe = this.peers.get(bridgeId);
    if (!pe || this.disposed) return;
    pe.status = 'failed';
    pe.peer = null;
    pe.kind = null;
    pe.reason = reason;
    for (const sessionId of pe.sessions) {
      const entry = this.sessions.get(sessionId);
      if (entry && !entry.disposed) {
        this.goCentrifugo(entry, reason);
      }
    }
  }

  private modeForKind(kind: 'local' | 'webrtc' | null): TerminalTransportMode {
    return kind === 'local' ? 'local' : 'direct';
  }

  // --- path activation ---------------------------------------------------

  private goDirect(entry: SessionEntry, peer: DirectPeerApi, mode: TerminalTransportMode): void {
    if (entry.disposed) return;
    entry.direct = true;
    entry.reason = null;
    // Bridge replies to attach with a `screen` frame before any `output` (R1).
    peer.attach(entry.sessionId, {
      onScreen: (data) => entry.handlers.onScreen(data),
      onOutput: (data) => entry.handlers.onOutput(data),
    });
    this.setMode(entry, mode);
    // Flush the connecting-window buffer onto the freshly-attached peer.
    this.flushPending(entry);
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
    // Flush the connecting-window buffer onto the terminal-input channel.
    this.flushPending(entry);
  }

  // --- connecting-window buffering --------------------------------------

  private hasActivePath(entry: SessionEntry): boolean {
    return entry.direct || entry.inputSub !== null;
  }

  private bufferInput(entry: SessionEntry, data: string): void {
    entry.pendingInput.push(data);
    entry.pendingInputChars += data.length;
    // Drop-oldest beyond the cap; the pty tolerates a lost prefix over unbounded growth.
    while (entry.pendingInputChars > MAX_PENDING_INPUT_CHARS && entry.pendingInput.length > 1) {
      const dropped = entry.pendingInput.shift();
      if (dropped !== undefined) entry.pendingInputChars -= dropped.length;
    }
    // A single chunk larger than the cap keeps its TAIL (truncate from the
    // front) so a huge paste degrades instead of vanishing entirely.
    if (entry.pendingInputChars > MAX_PENDING_INPUT_CHARS && entry.pendingInput.length === 1) {
      entry.pendingInput[0] = entry.pendingInput[0].slice(-MAX_PENDING_INPUT_CHARS);
      entry.pendingInputChars = entry.pendingInput[0].length;
    }
  }

  /** Flush the buffered latest-resize then queued input, exactly once, onto the active path. */
  private flushPending(entry: SessionEntry): void {
    const resize = entry.pendingResize;
    const input = entry.pendingInput;
    entry.pendingResize = null;
    entry.pendingInput = [];
    entry.pendingInputChars = 0;

    if (resize) {
      // Coalescing swallowed Terminal's deliberate cols-1→cols bounce, so emit
      // it here: tmux only re-wraps on a size CHANGE, and the flushed resize
      // must force a redraw for a correct first paint.
      if (resize.cols > 1) this.dispatchResize(entry, resize.cols - 1, resize.rows);
      this.dispatchResize(entry, resize.cols, resize.rows);
    }
    for (const data of input) this.dispatchInput(entry, data);
  }

  private dispatchInput(entry: SessionEntry, data: string): void {
    if (entry.direct) {
      this.peers.get(entry.bridgeId)?.peer?.sendInput(entry.sessionId, data);
    } else if (entry.inputSub) {
      void entry.inputSub.publish({ type: 'input', data });
    }
  }

  private dispatchResize(entry: SessionEntry, cols: number, rows: number): void {
    if (entry.direct) {
      this.peers.get(entry.bridgeId)?.peer?.sendResize(entry.sessionId, cols, rows);
    } else if (entry.inputSub) {
      void entry.inputSub.publish({ type: 'resize', cols, rows });
    }
  }

  // --- presence advert ---------------------------------------------------

  /**
   * Get-or-create the shared bridges:presence subscription. Never torn down by
   * this class — useBridges owns its lifecycle when mounted; when we create it
   * first, the shared-subscription pattern lets later hooks pick it up.
   */
  private ensurePresenceSub(): CentrifugoSubscriptionLike {
    const channel = `bridges:presence#${this.userId}`;
    const existing = this.client.getSubscription(channel);
    if (existing) return existing;
    const sub = this.client.newSubscription(channel);
    sub.subscribe();
    return sub;
  }

  private async defaultGetLocalAdvert(bridgeId: string): Promise<BridgeLocalAdvert | null> {
    const sub = this.ensurePresenceSub();
    if (typeof sub.presence !== 'function') return null;
    const result = await this.readPresenceBounded(sub);
    if (!result) return null;
    for (const info of Object.values(result.clients)) {
      const ci = info.connInfo as
        | { bridgeId?: string; localPort?: number; localNonce?: string }
        | undefined;
      if (
        ci &&
        ci.bridgeId === bridgeId &&
        typeof ci.localPort === 'number' &&
        typeof ci.localNonce === 'string'
      ) {
        return { localPort: ci.localPort, localNonce: ci.localNonce };
      }
    }
    return null;
  }

  /**
   * Read presence within LOOPBACK_TIMEOUT_MS, resolving null on timeout or
   * failure — never throwing into the ladder. Centrifuge queues presence()
   * calls issued while the subscription is still subscribing, so a rejection
   * genuinely means failure (⇒ no advert), and the timer bounds a hang.
   */
  private readPresenceBounded(
    sub: CentrifugoSubscriptionLike,
  ): Promise<CentrifugoPresenceResult | null> {
    return new Promise<CentrifugoPresenceResult | null>((resolve) => {
      let done = false;
      const finish = (result: CentrifugoPresenceResult | null): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(result);
      };
      const timer = setTimeout(() => finish(null), LOOPBACK_TIMEOUT_MS);
      sub
        .presence!()
        .then((result) => finish(result))
        .catch(() => finish(null));
    });
  }

  // --- internals ---------------------------------------------------------

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

    // Discard any un-flushed connecting-window buffer so it can't leak later.
    entry.pendingInput = [];
    entry.pendingInputChars = 0;
    entry.pendingResize = null;

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

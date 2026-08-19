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

/**
 * How long a switching session waits for the new peer's `screen` (the switch
 * point) before giving up and staying on cloud (review #1 watchdog). Generous:
 * a healthy attach delivers the screen sub-second, so this only trips on a wedged
 * pty / dropped attach — and it must comfortably exceed a heartbeat period so a
 * merely-slow bridge still completes the switch rather than being abandoned.
 */
const SWITCHOVER_SCREEN_TIMEOUT_MS = 30_000;

/** Any active data-plane peer: the loopback WS rung or the WebRTC rung. */
type DirectPeerApi = WebRtcPeerApi | LoopbackPeerApi;

/** Only WebRTC peers have a signaling plane (loopback needs no ICE/SDP exchange). */
function hasSignalingPlane(peer: DirectPeerApi): peer is WebRtcPeerApi {
  return 'handleSignal' in peer;
}

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
  /**
   * Per-bridge upgrade retry backoff in ms (T1). While a bridge has any
   * centrifugo-mode session and is online, the ladder is periodically re-run;
   * the timer walks this array and repeats the last entry (cap). Injectable for
   * tests; empty/undefined ⇒ the default ladder. (Addendum surface.)
   */
  upgradeBackoffMs?: number[];
  /** ±fraction jitter applied to each upgrade backoff delay (T1). Default 0.2. */
  upgradeJitter?: number;
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
  /**
   * The peer currently being paired during an in-flight UPGRADE attempt (T1/T2),
   * held here (separate from {@link peer}, which stays null while status is
   * 'failed') so inbound WebRTC answer/ICE can be routed to it without disturbing
   * the active centrifugo path. Null when no upgrade attempt is pairing.
   */
  upgradePeer: DirectPeerApi | null;
  /** Single per-bridge upgrade retry timer (T1: one loop per bridge). */
  upgradeTimer: ReturnType<typeof setTimeout> | null;
  /** Index into the backoff array for the next scheduled attempt (caps at last). */
  upgradeAttempt: number;
  /** In-flight guard: upgrade attempts never run concurrently (T2). */
  upgradeInFlight: boolean;
  /**
   * Tracks the in-progress screen-gated switchover of a just-committed upgrade
   * peer (watchdog bookkeeping). Null when no switchover is pending.
   */
  switchState: SwitchState | null;
}

/**
 * Bookkeeping for one committed upgrade peer's per-session switchover. If NO
 * session manages to switch (every attach goes screen-less within the watchdog),
 * the peer is torn down and the bridge reverts to 'failed' so the retry loop
 * resumes — a bridge is never pinned to a peer that delivered no screen.
 */
interface SwitchState {
  bridgeId: string;
  peer: DirectPeerApi;
  /** Sessions still awaiting their switch-point screen on {@link peer}. */
  pending: Set<string>;
  /** How many sessions successfully switched onto {@link peer}. */
  succeeded: number;
}

/**
 * Steering hooks for a shared ladder run ({@link HybridTerminalTransport.climbLadder}),
 * differing between initial pairing and an upgrade attempt: where the in-flight
 * pairing peer is stashed for signaling routing, and when the run is superseded.
 */
interface LadderCtx {
  /** Stash the pairing peer so inbound answer/ICE reaches it. */
  setPairing(peer: DirectPeerApi): void;
  /** Un-stash the pairing peer (on failure/supersede) if still current. */
  clearPairing(peer: DirectPeerApi): void;
  /** True once this run is superseded/disposed and must abandon its peer. */
  aborted(): boolean;
}

/** Buffered resize while a session is still on the ladder — latest wins. */
interface PendingResize {
  cols: number;
  rows: number;
}

/** Outbound frame on the centrifugo terminal-input channel (existing wire shapes). */
type OutboundInputFrame =
  | { type: 'input'; data: string }
  | { type: 'resize'; cols: number; rows: number };

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
  /**
   * During an upgrade switchover (T3), the freshly-attached-but-not-yet-active
   * peer. Non-null only between attaching over the new peer and its arriving
   * `screen` frame (the switch point); lets teardown detach it if the session
   * unsubscribes mid-switch. Null otherwise.
   */
  pendingSwitchPeer: DirectPeerApi | null;
  /**
   * Watchdog for a pending switchover: if the new peer's `screen` does not arrive
   * within the bound, the session aborts its switch and stays on cloud (T3
   * robustness). Null when no switchover is pending.
   */
  switchWatchdog: ReturnType<typeof setTimeout> | null;
  /**
   * Outbound queue for the centrifugo input path. centrifuge publish() has
   * non-uniform await depth: publishes issued while the sub is 'subscribing'
   * park internally until 'subscribed', while later ones take an
   * already-resolved fast path and OVERTAKE them at the synchronous
   * _addCommand point — transposing adjacent keystrokes on the wire. Keeping
   * exactly ONE publish in flight makes command order == keystroke order
   * regardless of centrifuge state transitions; adjacent input frames coalesce.
   */
  outQueue: OutboundInputFrame[];
  publishInFlight: boolean;
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
  /** Per-bridge upgrade retry backoff (T1); last entry repeats as the cap. */
  private readonly upgradeBackoffMs: number[];
  private readonly upgradeJitter: number;

  private readonly peers = new Map<string, PeerEntry>();
  private readonly sessions = new Map<string, SessionEntry>();
  private readonly modeChangeCbs = new Set<(sessionId: string, mode: TerminalTransportMode) => void>();
  private readonly bridgeReachabilityCbs = new Set<
    (bridgeId: string, reachable: boolean) => void
  >();
  private disposed = false;

  /** Registered-once global upgrade triggers (T2); null under SSR / no DOM. */
  private onlineHandler: (() => void) | null = null;
  private visibilityHandler: (() => void) | null = null;

  /**
   * The bridges:presence subscription IFF this transport created it (vs adopting
   * one useBridges already mounted). Only an owned subscription is torn down in
   * dispose() — never one another hook owns.
   */
  private ownedPresenceSub: CentrifugoSubscriptionLike | null = null;

  constructor(opts: HybridTerminalTransportOptions) {
    this.client = opts.centrifuge;
    this.userId = opts.userId;
    this.clientId = opts.clientId;
    this.publishCommand = opts.publishCommand;
    this.peerFactory = opts.peerFactory ?? ((o) => new WebRtcPeer(o));
    this.loopbackPeerFactory = opts.loopbackPeerFactory ?? ((o) => new LoopbackPeer(o));
    this.getLocalAdvert = opts.getLocalAdvert ?? ((bridgeId) => this.defaultGetLocalAdvert(bridgeId));
    this.advertInjected = typeof opts.getLocalAdvert === 'function';
    this.upgradeBackoffMs =
      opts.upgradeBackoffMs && opts.upgradeBackoffMs.length > 0
        ? opts.upgradeBackoffMs
        : [15_000, 30_000, 60_000, 120_000];
    this.upgradeJitter = typeof opts.upgradeJitter === 'number' ? opts.upgradeJitter : 0.2;
    this.registerGlobalTriggers();
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
      pendingSwitchPeer: null,
      switchWatchdog: null,
      outQueue: [],
      publishInFlight: false,
    };
    this.sessions.set(sessionId, entry);

    const pe = this.ensurePeer(bridgeId);
    pe.sessions.add(sessionId);

    if (pe.status === 'attached' && pe.peer) {
      this.goDirect(entry, pe.peer, this.modeForKind(pe.kind));
    } else if (pe.status === 'failed') {
      this.goCentrifugo(entry, pe.reason);
      // T2: a fresh subscribe for an already-fallen-back bridge resets the
      // backoff and triggers an immediate upgrade attempt.
      this.ensureUpgradeLoop(bridgeId, true);
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

  getDirectlyReachableBridgeIds(): string[] {
    return [...this.peers.entries()]
      .filter(([, pe]) => pe.status === 'attached' && pe.peer !== null)
      .map(([bridgeId]) => bridgeId)
      .sort();
  }

  onBridgeReachabilityChange(
    cb: (bridgeId: string, reachable: boolean) => void,
  ): () => void {
    this.bridgeReachabilityCbs.add(cb);
    return () => {
      this.bridgeReachabilityCbs.delete(cb);
    };
  }

  /**
   * Feed inbound signaling (webrtc_answer/webrtc_ice/webrtc_close) received on
   * commands:rpc into the matching bridge peer. Not part of TerminalTransportApi;
   * the wiring layer routes signals here. Loopback peers have no signaling plane.
   */
  handleSignal(msg: SignalMessage): void {
    const pe = this.peers.get(msg.bridgeId);
    // Route to the active peer, or the in-flight upgrade peer while pairing (the
    // active slot is null on a failed/centrifugo bridge).
    const peer = pe?.peer ?? pe?.upgradePeer;
    if (peer && hasSignalingPlane(peer)) peer.handleSignal(msg);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;

    this.unregisterGlobalTriggers();

    for (const entry of this.sessions.values()) {
      this.teardownSession(entry);
    }
    this.sessions.clear();

    for (const pe of this.peers.values()) {
      if (pe.upgradeTimer) {
        clearTimeout(pe.upgradeTimer);
        pe.upgradeTimer = null;
      }
      pe.upgradePeer?.close();
      pe.peer?.close();
    }
    this.peers.clear();
    this.modeChangeCbs.clear();
    this.bridgeReachabilityCbs.clear();

    // Tear down the bridges:presence subscription only if WE created it (#4).
    if (this.ownedPresenceSub) {
      this.ownedPresenceSub.removeAllListeners();
      this.ownedPresenceSub.unsubscribe();
      this.client.removeSubscription(this.ownedPresenceSub);
      this.ownedPresenceSub = null;
    }
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
      upgradePeer: null,
      upgradeTimer: null,
      upgradeAttempt: 0,
      upgradeInFlight: false,
      switchState: null,
    };
    this.peers.set(bridgeId, pe);
    void this.runLadder(bridgeId);
    return pe;
  }

  /** Initial pairing: loopback (if advertised) → WebRTC → Centrifugo, per bridge. */
  private async runLadder(bridgeId: string): Promise<void> {
    const result = await this.climbLadder(bridgeId, this.initialCtx(bridgeId));
    if (result) {
      this.attachPeer(bridgeId, result.peer, result.kind);
      return;
    }
    if (this.isStillConnecting(bridgeId)) {
      this.finalizeFailed(bridgeId, 'pairing_failed');
    }
  }

  /**
   * Shared ladder climb, reused by initial pairing and upgrade attempts. Builds
   * a connected peer (loopback if advertised, else WebRTC) WITHOUT committing it
   * to any session — the caller decides how to attach/switch. Returns null when
   * every rung fails or the run is superseded (see {@link LadderCtx.aborted}).
   */
  private async climbLadder(
    bridgeId: string,
    ctx: LadderCtx,
  ): Promise<{ peer: DirectPeerApi; kind: 'local' | 'webrtc' } | null> {
    // Only await the (async) advert lookup when a loopback rung is actually
    // possible. Otherwise fall through with NO await before the WebRTC attempt, so
    // the WebRTC peer is constructed synchronously (preserves pre-addendum timing).
    if (this.hasLoopbackAdvertChance()) {
      let advert: BridgeLocalAdvert | null = null;
      try {
        advert = await this.getLocalAdvert(bridgeId);
      } catch {
        advert = null;
      }
      if (ctx.aborted()) return null;

      if (advert) {
        const lp = await this.attemptLoopback(bridgeId, advert, ctx);
        if (lp) return { peer: lp, kind: 'local' };
        if (ctx.aborted()) return null;
      }
    }

    const wp = await this.attemptWebRtc(bridgeId, ctx);
    if (wp) return { peer: wp, kind: 'webrtc' };
    return null;
  }

  /** Ladder steering for the initial pairing run (peer held in `pe.peer`). */
  private initialCtx(bridgeId: string): LadderCtx {
    return {
      setPairing: (peer) => {
        const pe = this.peers.get(bridgeId);
        if (pe) pe.peer = peer;
      },
      clearPairing: (peer) => {
        const pe = this.peers.get(bridgeId);
        if (pe && pe.peer === peer) pe.peer = null;
      },
      aborted: () => !this.isStillConnecting(bridgeId),
    };
  }

  /**
   * Ladder steering for an upgrade attempt: the pairing peer lives in
   * `pe.upgradePeer` (leaving the active centrifugo path untouched), and the run
   * is superseded once the bridge is no longer failed or has no centrifugo
   * sessions left to upgrade.
   */
  private upgradeCtx(bridgeId: string): LadderCtx {
    return {
      setPairing: (peer) => {
        const pe = this.peers.get(bridgeId);
        if (pe) pe.upgradePeer = peer;
      },
      clearPairing: (peer) => {
        const pe = this.peers.get(bridgeId);
        if (pe && pe.upgradePeer === peer) pe.upgradePeer = null;
      },
      aborted: () => {
        const pe = this.peers.get(bridgeId);
        return this.disposed || !pe || pe.status !== 'failed' || !this.hasCentrifugoSessions(pe);
      },
    };
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

  private async attemptLoopback(
    bridgeId: string,
    advert: BridgeLocalAdvert,
    ctx: LadderCtx,
  ): Promise<LoopbackPeerApi | null> {
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
      return null;
    }
    ctx.setPairing(peer);

    try {
      await peer.connect();
    } catch {
      ctx.clearPairing(peer);
      peer.close();
      return null;
    }
    if (ctx.aborted()) {
      peer.close();
      ctx.clearPairing(peer);
      return null;
    }
    return peer;
  }

  private async attemptWebRtc(bridgeId: string, ctx: LadderCtx): Promise<WebRtcPeerApi | null> {
    let peer: WebRtcPeerApi;
    try {
      peer = this.peerFactory({
        bridgeId,
        clientId: this.clientId,
        sendSignal: (m) => this.publishCommand(m),
      });
    } catch {
      // WebRTC unsupported/blocked (e.g. Safari): next rung.
      return null;
    }
    // Must be routable for inbound answer/ICE while pairing is in flight.
    ctx.setPairing(peer);

    try {
      await peer.connect();
    } catch {
      ctx.clearPairing(peer);
      peer.close();
      return null;
    }
    if (ctx.aborted()) {
      peer.close();
      ctx.clearPairing(peer);
      return null;
    }
    return peer;
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
    this.emitBridgeReachability(bridgeId, true);

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
    const wasDirectlyReachable = pe.status === 'attached' && pe.peer !== null;
    pe.status = 'failed';
    pe.peer = null;
    pe.kind = null;
    pe.reason = reason;
    // Any pending switchover is void — the peer is gone.
    pe.switchState = null;
    if (wasDirectlyReachable) this.emitBridgeReachability(bridgeId, false);
    for (const sessionId of pe.sessions) {
      const entry = this.sessions.get(sessionId);
      if (entry && !entry.disposed) {
        this.goCentrifugo(entry, reason);
      }
    }
    // T1: any session now on the cloud path arms the per-bridge upgrade loop.
    this.ensureUpgradeLoop(bridgeId, false);
  }

  private modeForKind(kind: 'local' | 'webrtc' | null): TerminalTransportMode {
    return kind === 'local' ? 'local' : 'direct';
  }

  // --- upgrade loop (T1/T2/T7) -------------------------------------------

  /** True if the bridge has at least one live session still on the cloud path. */
  private hasCentrifugoSessions(pe: PeerEntry): boolean {
    for (const sessionId of pe.sessions) {
      const entry = this.sessions.get(sessionId);
      if (entry && !entry.disposed && entry.mode === 'centrifugo') return true;
    }
    return false;
  }

  /**
   * Start or resume the per-bridge upgrade loop (T1). Only runs for a failed
   * (centrifugo) bridge that still has a cloud session. `reset` (T2 triggers:
   * subscribe, online, visible) rewinds the backoff to 0 and fires an immediate
   * attempt; otherwise a timer is armed at the current backoff rung.
   */
  private ensureUpgradeLoop(bridgeId: string, reset: boolean): void {
    const pe = this.peers.get(bridgeId);
    if (!pe || this.disposed) return;
    if (pe.status !== 'failed' || !this.hasCentrifugoSessions(pe)) return;

    if (reset) {
      // -1 so the immediate attempt's failure-reschedule (post-increment) lands
      // back on backoff[0] — a reset rewinds the backoff to its first rung.
      pe.upgradeAttempt = -1;
      // An in-flight attempt already covers "attempt now"; it reschedules itself.
      if (pe.upgradeInFlight) return;
      this.armUpgradeTimer(pe, bridgeId, true);
      return;
    }
    if (pe.upgradeTimer || pe.upgradeInFlight) return;
    this.armUpgradeTimer(pe, bridgeId, false);
  }

  /** (Re)arm the single upgrade timer. `immediate` fires on the next tick (T2). */
  private armUpgradeTimer(pe: PeerEntry, bridgeId: string, immediate: boolean): void {
    if (this.disposed) return;
    if (pe.upgradeTimer) {
      clearTimeout(pe.upgradeTimer);
      pe.upgradeTimer = null;
    }
    const delay = immediate ? 0 : this.jittered(this.backoffFor(pe.upgradeAttempt));
    pe.upgradeTimer = setTimeout(() => {
      pe.upgradeTimer = null;
      void this.runUpgradeAttempt(bridgeId);
    }, delay);
  }

  private backoffFor(attempt: number): number {
    const idx = Math.min(Math.max(attempt, 0), this.upgradeBackoffMs.length - 1);
    return this.upgradeBackoffMs[idx];
  }

  /** Apply ±jitter to a backoff delay, clamped non-negative. */
  private jittered(base: number): number {
    const factor = 1 + (Math.random() * 2 - 1) * this.upgradeJitter;
    return Math.max(0, Math.round(base * factor));
  }

  /** Cancel the loop (T7): last session gone, no cloud sessions, offline, success. */
  private stopUpgradeLoop(pe: PeerEntry): void {
    if (pe.upgradeTimer) {
      clearTimeout(pe.upgradeTimer);
      pe.upgradeTimer = null;
    }
    pe.upgradeAttempt = 0;
  }

  /** Escalate the backoff one rung and re-arm the timer after a failed attempt. */
  private rescheduleUpgrade(pe: PeerEntry, bridgeId: string): void {
    pe.upgradeAttempt = Math.min(pe.upgradeAttempt + 1, this.upgradeBackoffMs.length - 1);
    this.armUpgradeTimer(pe, bridgeId, false);
  }

  /**
   * One upgrade attempt (T1): re-run the ladder for a still-failed, online bridge
   * and, on success, gracefully switch its cloud sessions over. Never runs
   * concurrently (in-flight guard). Silent on failure — sessions stay on
   * Centrifugo and the backoff escalates (T5).
   */
  private async runUpgradeAttempt(bridgeId: string): Promise<void> {
    const pe = this.peers.get(bridgeId);
    if (!pe || this.disposed) return;
    if (pe.status !== 'failed' || !this.hasCentrifugoSessions(pe)) {
      if (pe) this.stopUpgradeLoop(pe);
      return;
    }
    if (pe.upgradeInFlight) return;
    pe.upgradeInFlight = true;
    try {
      const online = await this.isBridgeOnlineForUpgrade(bridgeId);
      const still = this.peers.get(bridgeId);
      if (this.disposed || !still || still.status !== 'failed' || !this.hasCentrifugoSessions(still)) {
        if (still) this.stopUpgradeLoop(still);
        return;
      }
      if (!online) {
        // T7: bridge offline in presence → keep the loop alive and re-check on
        // the next backoff tick (bounded: one presence() read per tick). A bridge
        // returning to presence auto-resumes without needing a DOM event. Hard
        // cancel is reserved for last-session-unsubscribe and dispose().
        this.rescheduleUpgrade(still, bridgeId);
        return;
      }

      const result = await this.climbLadder(bridgeId, this.upgradeCtx(bridgeId));
      const pe2 = this.peers.get(bridgeId);
      if (this.disposed || !pe2 || pe2.status !== 'failed' || !this.hasCentrifugoSessions(pe2)) {
        result?.peer.close();
        if (pe2) this.stopUpgradeLoop(pe2);
        return;
      }
      if (result) {
        this.commitUpgrade(bridgeId, result.peer, result.kind);
        return;
      }
      this.rescheduleUpgrade(pe2, bridgeId);
    } finally {
      const peF = this.peers.get(bridgeId);
      if (peF) peF.upgradeInFlight = false;
    }
  }

  /**
   * Is the bridge currently present in bridges:presence (T1 online gate)? With an
   * injected advert source there is no presence to consult, so trust the ladder
   * (return true). With the default presence query, a missing `presence()` method
   * (minimal fakes / no presence support) counts as "cannot confirm" → not online.
   */
  private async isBridgeOnlineForUpgrade(bridgeId: string): Promise<boolean> {
    if (this.advertInjected) return true;
    const sub = this.ensurePresenceSub();
    if (typeof sub.presence !== 'function') return false;
    const result = await this.readPresenceBounded(sub);
    if (!result) return false;
    for (const info of Object.values(result.clients)) {
      const ci = info.connInfo as { bridgeId?: string } | undefined;
      if (ci && ci.bridgeId === bridgeId) return true;
    }
    return false;
  }

  /**
   * Promote a freshly-paired upgrade peer to THE bridge peer and switch every
   * cloud session over (T3). Stops the retry loop; a mid-session close of the new
   * peer falls all sessions back to Centrifugo via the normal onClose path.
   */
  private commitUpgrade(bridgeId: string, peer: DirectPeerApi, kind: 'local' | 'webrtc'): void {
    const pe = this.peers.get(bridgeId);
    if (!pe) {
      peer.close();
      return;
    }
    pe.peer = peer;
    pe.upgradePeer = null;
    pe.status = 'attached';
    pe.kind = kind;
    pe.reason = null;
    this.emitBridgeReachability(bridgeId, true);
    peer.onClose(() => this.onPeerDown(bridgeId));
    this.stopUpgradeLoop(pe);

    const mode = this.modeForKind(kind);
    // Snapshot: switchover may mutate session state as screens arrive.
    const switching: SessionEntry[] = [];
    for (const sessionId of [...pe.sessions]) {
      const entry = this.sessions.get(sessionId);
      if (!entry || entry.disposed) continue;
      if (entry.mode === 'centrifugo') {
        switching.push(entry);
      } else if (!entry.direct) {
        // Edge: a session still in the connecting window when the upgrade landed —
        // no active cloud path to preserve, so attach it directly.
        this.goDirect(entry, peer, mode);
      }
    }
    if (switching.length === 0) return;

    // Watchdog bookkeeping: if NO session switches (the peer's channel opened but
    // the bridge never replied to attach with a screen), the attempt is failed —
    // the peer is torn down and the bridge reverts to 'failed' (see maybeRevert).
    const state: SwitchState = {
      bridgeId,
      peer,
      pending: new Set(switching.map((e) => e.sessionId)),
      succeeded: 0,
    };
    pe.switchState = state;
    for (const entry of switching) this.switchoverSession(entry, peer, mode, state, SWITCHOVER_SCREEN_TIMEOUT_MS);
  }

  /**
   * Graceful per-session switchover from the Centrifugo cloud path to a
   * freshly-connected upgrade peer (T3/T4).
   *
   * SWITCH-POINT INVARIANT: attach over the new peer while the session KEEPS
   * consuming the cloud path (output flows, input routes to cloud). The bridge's
   * `screen` reply on the new peer (R1 full resync) is the ATOMIC switch point:
   * on it we swap input routing, tear the cloud path down (unsubscribe +
   * terminal_unwatch + stop heartbeat + drain the publish chain), THEN deliver the
   * screen. Because the cloud subscription is dropped synchronously inside this
   * handler, any output still arriving on the old path afterwards is discarded
   * rather than double-applied — no gap, no double-apply.
   *
   * A watchdog bounds the wait: a screen-less attach (wedged pty / dropped attach)
   * aborts THIS session's switch and leaves it on cloud instead of stranding it.
   */
  private switchoverSession(
    entry: SessionEntry,
    peer: DirectPeerApi,
    mode: TerminalTransportMode,
    state: SwitchState,
    timeout: number,
  ): void {
    entry.pendingSwitchPeer = peer;
    entry.switchWatchdog = setTimeout(() => {
      entry.switchWatchdog = null;
      this.abortSessionSwitch(entry, state);
    }, timeout);
    peer.attach(entry.sessionId, {
      onScreen: (data) => {
        if (entry.disposed) return;
        // First screen from the new peer == the switch point (fires once).
        if (entry.pendingSwitchPeer === peer && !entry.direct) {
          this.performSwitch(entry, mode, state);
        }
        entry.handlers.onScreen(data);
      },
      onOutput: (data) => {
        if (entry.disposed) return;
        // R1: the bridge sends `screen` before any `output` on attach, so output
        // seen here is always post-switch.
        entry.handlers.onOutput(data);
      },
    });
  }

  /** The atomic switch: flip input routing, tear the cloud path down, set mode. */
  private performSwitch(entry: SessionEntry, mode: TerminalTransportMode, state: SwitchState): void {
    if (entry.switchWatchdog) {
      clearTimeout(entry.switchWatchdog);
      entry.switchWatchdog = null;
    }
    // Capture input still queued-but-unpublished on the cloud chain: it never
    // reached the wire, so REPLAY (not drop) it onto the new peer after the switch
    // — no duplication, and the fresh screen makes buffered input correct.
    const replay = entry.outQueue.slice();
    entry.direct = true;
    entry.reason = null;
    entry.pendingSwitchPeer = null;
    // terminal_unwatch while mode is still 'centrifugo' (R3 teardown).
    this.sendWatch('terminal_unwatch', entry.sessionId);
    this.detachCentrifugo(entry);
    // fallbackReason cleared by this successful mode change (T5); onModeChange
    // fires Cloud -> Local/P2P (T8).
    this.setMode(entry, mode);
    // Replay onto the now-active new peer (entry.direct is true).
    for (const frame of replay) {
      if (frame.type === 'input') this.dispatchInput(entry, frame.data);
      else this.dispatchResize(entry, frame.cols, frame.rows);
    }

    state.succeeded++;
    state.pending.delete(entry.sessionId);
    // A success proves the peer works; keep it even if other sessions later abort.
    const pe = this.peers.get(state.bridgeId);
    if (pe && pe.switchState === state && state.pending.size === 0) pe.switchState = null;
  }

  /**
   * The new peer's `screen` never arrived for this session within the watchdog:
   * abandon its switch and leave it on the (still-intact) cloud path. detachCentrifugo
   * only runs at performSwitch, so the session's subscription/heartbeat are untouched.
   */
  private abortSessionSwitch(entry: SessionEntry, state: SwitchState): void {
    if (entry.disposed) return;
    const peer = entry.pendingSwitchPeer;
    if (!peer || peer !== state.peer) return; // already switched / torn down / superseded
    entry.pendingSwitchPeer = null;
    peer.detach(entry.sessionId); // clean the dead peer's handler map for this session
    state.pending.delete(entry.sessionId);
    this.maybeRevertUpgrade(state);
  }

  /**
   * Once every switching session has resolved (switched or aborted): if NONE
   * switched, the committed peer delivered no screen at all — tear it down, revert
   * the bridge to 'failed', and rearm the retry loop so a later attempt tries
   * again. Never leaves a bridge pinned to a screen-less peer (review #1).
   */
  private maybeRevertUpgrade(state: SwitchState): void {
    if (state.pending.size > 0 || state.succeeded > 0) return;
    const pe = this.peers.get(state.bridgeId);
    if (!pe || pe.switchState !== state) return;
    pe.switchState = null;
    if (pe.peer === state.peer) {
      pe.status = 'failed';
      pe.peer = null;
      pe.kind = null;
      pe.reason = 'pairing_failed';
    }
    state.peer.close(); // onClose → onPeerDown no-ops (status already 'failed')
    // All sessions are still on cloud (their switches aborted). Try again later.
    this.ensureUpgradeLoop(state.bridgeId, false);
  }

  /** Tear down a session's Centrifugo terminal subs/heartbeat/publish chain. */
  private detachCentrifugo(entry: SessionEntry): void {
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
    // Drop the outbound publish chain; an in-flight publish's continuation bails
    // on the now-null inputSub guard in pumpOutQueue.
    entry.outQueue = [];
  }

  // --- global upgrade triggers (T2) --------------------------------------

  private registerGlobalTriggers(): void {
    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
      this.onlineHandler = () => this.onGlobalTrigger();
      window.addEventListener('online', this.onlineHandler);
    }
    if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
      this.visibilityHandler = () => {
        if (document.visibilityState === 'visible') this.onGlobalTrigger();
      };
      document.addEventListener('visibilitychange', this.visibilityHandler);
    }
  }

  private onGlobalTrigger(): void {
    if (this.disposed) return;
    for (const bridgeId of this.peers.keys()) {
      this.ensureUpgradeLoop(bridgeId, true);
    }
  }

  private unregisterGlobalTriggers(): void {
    if (this.onlineHandler && typeof window !== 'undefined') {
      window.removeEventListener('online', this.onlineHandler);
    }
    this.onlineHandler = null;
    if (this.visibilityHandler && typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this.visibilityHandler);
    }
    this.visibilityHandler = null;
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
    // Abandon any in-flight upgrade switchover (the new peer is gone/superseded).
    entry.pendingSwitchPeer = null;
    if (entry.switchWatchdog) {
      clearTimeout(entry.switchWatchdog);
      entry.switchWatchdog = null;
    }
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
      // Direct/loopback frames are synchronous sends — already FIFO.
      this.peers.get(entry.bridgeId)?.peer?.sendInput(entry.sessionId, data);
    } else if (entry.inputSub) {
      const tail = entry.outQueue[entry.outQueue.length - 1];
      if (tail && tail.type === 'input') {
        // Coalesce adjacent input into one publish — fewer round-trips while
        // preserving byte order (a resize in between breaks the run).
        tail.data += data;
      } else {
        entry.outQueue.push({ type: 'input', data });
      }
      this.pumpOutQueue(entry);
    }
  }

  private dispatchResize(entry: SessionEntry, cols: number, rows: number): void {
    if (entry.direct) {
      this.peers.get(entry.bridgeId)?.peer?.sendResize(entry.sessionId, cols, rows);
    } else if (entry.inputSub) {
      // Resize rides the same chain so it stays ordered relative to input.
      entry.outQueue.push({ type: 'resize', cols, rows });
      this.pumpOutQueue(entry);
    }
  }

  /**
   * Single-in-flight publish chain for the centrifugo input path (see
   * SessionEntry.outQueue). A rejected publish drops that payload and continues
   * the chain — terminal input is not safely retryable (a duplicate keystroke
   * is worse than a dropped one).
   */
  private pumpOutQueue(entry: SessionEntry): void {
    if (entry.publishInFlight || entry.disposed || !entry.inputSub) return;
    const frame = entry.outQueue.shift();
    if (!frame) return;
    entry.publishInFlight = true;
    void entry.inputSub
      .publish(frame)
      .catch(() => {})
      .then(() => {
        entry.publishInFlight = false;
        this.pumpOutQueue(entry);
      });
  }

  // --- presence advert ---------------------------------------------------

  /**
   * Get-or-create the shared bridges:presence subscription. If useBridges already
   * mounted it we adopt it (and never tear it down); if WE create it, we remember
   * ownership so dispose() cleans up exactly the one we made (review #4).
   */
  private ensurePresenceSub(): CentrifugoSubscriptionLike {
    const channel = `bridges:presence#${this.userId}`;
    const existing = this.client.getSubscription(channel);
    if (existing) return existing;
    if (this.ownedPresenceSub) return this.ownedPresenceSub;
    const sub = this.client.newSubscription(channel);
    sub.subscribe();
    this.ownedPresenceSub = sub;
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
    const pe = this.peers.get(entry.bridgeId);
    if (pe) {
      pe.sessions.delete(sessionId);
      // T7: no cloud session left to upgrade → cancel the retry loop. (Peer
      // teardown rules are unchanged: the peer itself is left as-is.)
      if (!this.hasCentrifugoSessions(pe)) this.stopUpgradeLoop(pe);
    }
  }

  private teardownSession(entry: SessionEntry): void {
    if (entry.disposed) return;
    entry.disposed = true;

    // Discard any un-flushed connecting-window buffer so it can't leak later.
    entry.pendingInput = [];
    entry.pendingInputChars = 0;
    entry.pendingResize = null;
    // Drop the outbound publish chain: an in-flight continuation bails on the
    // disposed/inputSub-null guard in pumpOutQueue.
    entry.outQueue = [];

    // Mid-upgrade-switch: cancel the watchdog and detach from the
    // freshly-attached, not-yet-active peer.
    if (entry.switchWatchdog) {
      clearTimeout(entry.switchWatchdog);
      entry.switchWatchdog = null;
    }
    if (entry.pendingSwitchPeer) {
      entry.pendingSwitchPeer.detach(entry.sessionId);
      entry.pendingSwitchPeer = null;
      // Drop this session from its switchover cohort so a pending revert isn't
      // blocked waiting on a session that is now gone.
      if (!this.disposed) {
        const pe = this.peers.get(entry.bridgeId);
        if (pe?.switchState && pe.switchState.pending.has(entry.sessionId)) {
          pe.switchState.pending.delete(entry.sessionId);
          this.maybeRevertUpgrade(pe.switchState);
        }
      }
    }
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

  private emitBridgeReachability(bridgeId: string, reachable: boolean): void {
    for (const cb of this.bridgeReachabilityCbs) cb(bridgeId, reachable);
  }
}

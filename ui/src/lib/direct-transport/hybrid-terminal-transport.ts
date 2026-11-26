import { accountChannel, sessionChannel } from "@security/ledger/channels";
import type { SecureEndpointRuntime } from "../secure-endpoint-runtime";
import type { ApplicationJson } from "@security/protocol";
import type { DirectCommandRoute } from "./webrtc-peer";
import {
  LOOPBACK_TIMEOUT_MS,
  WATCH_HEARTBEAT_MS,
  type BridgeLocalAdvert,
  type DirectAddress,
  MAX_DIRECT_ADDRESSES,
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
  validPeerAddress,
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
  securityRuntime?: SecureEndpointRuntime;
  /** Local pairing mode: loopback only, never WebRTC or relay. */
  localOnly?: boolean;
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

/**
 * The localhost port each bridge was last seen on, kept across page loads. A bridge on this machine can then be reached before the
 * relay has said anything, or while the relay is down. A port is not a secret and proves nothing: the encrypted hello on the
 * connection is what identifies the bridge, so a stale port, or another program on it, only costs one failed attempt.
 */
export const LOCAL_PORTS_STORAGE_KEY = 'ftown.bridgeLocalPorts.v1';
const MAX_REMEMBERED_PORTS = 32;
const validPort = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value > 0 && value < 65_536;

/** Best effort: storage may be blocked or hold anything. */
function readRememberedPorts(): Map<string, number> {
  const ports = new Map<string, number>();
  try {
    if (typeof localStorage === 'undefined') return ports;
    const stored: unknown = JSON.parse(localStorage.getItem(LOCAL_PORTS_STORAGE_KEY) ?? '{}');
    if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return ports;
    for (const [bridgeId, port] of Object.entries(stored)) {
      if (ports.size >= MAX_REMEMBERED_PORTS) break;
      if (/^[A-Za-z0-9_-]{1,200}$/.test(bridgeId) && validPort(port)) ports.set(bridgeId, port);
    }
  } catch { /* nothing remembered */ }
  return ports;
}

function writeRememberedPorts(ports: Map<string, number>): void {
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(LOCAL_PORTS_STORAGE_KEY, JSON.stringify(Object.fromEntries(ports)));
  } catch { /* remembered for this page only */ }
}

/**
 * Where each bridge listens for connections made without signaling, as the bridge last reported it (`get_direct_address`), kept
 * across page loads. Like the localhost port it is not a secret: a browser that connects to a wrong or stale address simply
 * fails the certificate check or the encrypted hello.
 */
export const DIRECT_ADDRESSES_STORAGE_KEY = 'ftown.bridgeDirectAddresses.v1';
const MAX_REMEMBERED_ADDRESSES = 32;
/** Addresses of one bridge tried at once. */
const MAX_ADDRESSES_TRIED = 4;

function parseDirectAddress(value: unknown): DirectAddress | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const { port, fingerprint, addresses } = value as Record<string, unknown>;
  if (!Array.isArray(addresses)) return null;
  const usable = addresses.filter((ip): ip is string => validPeerAddress({ ip, port, fingerprint })).slice(0, MAX_DIRECT_ADDRESSES);
  return usable.length ? { port: port as number, fingerprint: fingerprint as string, addresses: usable } : null;
}

function readRememberedAddresses(): Map<string, DirectAddress> {
  const remembered = new Map<string, DirectAddress>();
  try {
    if (typeof localStorage === 'undefined') return remembered;
    const stored: unknown = JSON.parse(localStorage.getItem(DIRECT_ADDRESSES_STORAGE_KEY) ?? '{}');
    if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return remembered;
    for (const [bridgeId, value] of Object.entries(stored)) {
      if (remembered.size >= MAX_REMEMBERED_ADDRESSES) break;
      const address = parseDirectAddress(value);
      if (/^[A-Za-z0-9_-]{1,200}$/.test(bridgeId) && address) remembered.set(bridgeId, address);
    }
  } catch { /* nothing remembered */ }
  return remembered;
}

type PeerStatus = 'connecting' | 'attached' | 'failed';

/** A direct read that is not answered by then is repeated over the relay. */
export const DIRECT_COMMAND_TIMEOUT_MS = 8_000;
/** How long commands are held for a connection to their bridge, counted from the first attempt or from the loss of a channel. */
export const DIRECT_CONNECT_WAIT_MS = 10_000;
/** Pause between attempts inside that window. */
export const DIRECT_QUICK_RETRY_MS = 500;
/** After the window, commands start a new attempt at most this often. */
export const DIRECT_RETRY_MS = 15_000;

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
  /** Commands waiting for the current connection attempt to end, either way. */
  settleWaiters: Array<() => void>;
  /** When the last attempt failed (0 = never). */
  failedAt: number;
  /** Start of the window in which commands are held for a connection: the first attempt, or the loss of an attached channel. */
  windowStartedAt: number;
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
  watchId: string | null;
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
  private readonly securityRuntime?: SecureEndpointRuntime;
  /** Unanswered direct commands per peer, rejected together when that peer closes. */
  private readonly directUnanswered = new WeakSet<DirectPeerApi>();
  private readonly directWaiters = new WeakMap<DirectPeerApi, Set<(error: Error) => void>>();
  private readonly localOnly: boolean;
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
  // Scoped to this authenticated transport's lifetime; never persist nonces.
  // Cloud presence can disappear while the loopback server is still healthy.
  private readonly localAdverts = new Map<string, BridgeLocalAdvert>();
  /** Ports from earlier page loads (see LOCAL_PORTS_STORAGE_KEY). Tried first; never taken as a sign that the bridge is online. */
  private readonly rememberedPorts: Map<string, number>;
  /** Addresses from earlier page loads or reported this page load (see DIRECT_ADDRESSES_STORAGE_KEY). */
  private readonly rememberedAddresses: Map<string, DirectAddress>;
  private readonly sessions = new Map<string, SessionEntry>();
  private readonly modeChangeCbs = new Set<(sessionId: string, mode: TerminalTransportMode) => void>();
  private readonly bridgeReachabilityCbs = new Set<
    (bridgeId: string, reachable: boolean) => void
  >();
  private disposed = false;
  private securityUnsubscribe: (() => void) | null = null;

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
    this.securityRuntime = opts.securityRuntime;
    this.localOnly = opts.localOnly ?? false;
    this.userId = opts.userId;
    this.clientId = opts.clientId;
    this.publishCommand = opts.publishCommand;
    this.peerFactory = opts.peerFactory ?? ((o) => new WebRtcPeer(o));
    this.loopbackPeerFactory = opts.loopbackPeerFactory ?? ((o) => new LoopbackPeer(o));
    this.getLocalAdvert = opts.getLocalAdvert ?? ((bridgeId) => this.defaultGetLocalAdvert(bridgeId));
    this.advertInjected = typeof opts.getLocalAdvert === 'function';
    this.rememberedPorts = this.advertInjected ? new Map() : readRememberedPorts();
    this.rememberedAddresses = readRememberedAddresses();
    this.upgradeBackoffMs =
      opts.upgradeBackoffMs && opts.upgradeBackoffMs.length > 0
        ? opts.upgradeBackoffMs
        : [15_000, 30_000, 60_000, 120_000];
    this.upgradeJitter = typeof opts.upgradeJitter === 'number' ? opts.upgradeJitter : 0.2;
    this.securityUnsubscribe = this.securityRuntime?.onChange(() => {
      for (const [bridgeId, peer] of this.peers) if (["revoked", "key_changed"].includes(this.securityRuntime!.state(bridgeId).status)) {
        peer.peer?.close(); peer.upgradePeer?.close();
        if (peer.upgradeTimer) clearTimeout(peer.upgradeTimer);
        for (const entry of this.sessions.values()) if (entry.bridgeId === bridgeId) { entry.pendingInput = []; entry.pendingInputChars = 0; entry.outQueue = []; }
      }
    }) ?? null;
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
      watchId: null,
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
    } else if (!this.localOnly) {
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

  /**
   * Opens the connection to each of these bridges whose localhost port is remembered, without waiting for the relay or for a first
   * command. This is what lets a bridge on this machine be used while the relay is unreachable.
   */
  connectRemembered(bridgeIds: readonly string[]): void {
    if (this.disposed) return;
    for (const bridgeId of bridgeIds) {
      if ((this.rememberedPorts.has(bridgeId) || this.rememberedAddresses.has(bridgeId)) && !this.peers.has(bridgeId)) this.ensurePeer(bridgeId);
    }
  }

  /** Whether an address is remembered for this bridge (the caller asks the bridge for one otherwise). */
  hasRememberedAddress(bridgeId: string): boolean { return this.rememberedAddresses.has(bridgeId); }

  /**
   * Records where a bridge said it listens for connections without signaling (the answer to `get_direct_address`), or forgets it
   * when the bridge reports none. Anything malformed is treated as none.
   */
  rememberAddress(bridgeId: string, value: unknown): void {
    if (this.disposed || !/^[A-Za-z0-9_-]{1,200}$/.test(bridgeId)) return;
    const address = parseDirectAddress(value);
    if (JSON.stringify(address) === JSON.stringify(this.rememberedAddresses.get(bridgeId) ?? null)) return;
    this.rememberedAddresses.delete(bridgeId);
    if (address) this.rememberedAddresses.set(bridgeId, address);
    while (this.rememberedAddresses.size > MAX_REMEMBERED_ADDRESSES) this.rememberedAddresses.delete(this.rememberedAddresses.keys().next().value!);
    try {
      if (typeof localStorage !== 'undefined') localStorage.setItem(DIRECT_ADDRESSES_STORAGE_KEY, JSON.stringify(Object.fromEntries(this.rememberedAddresses)));
    } catch { /* remembered for this page only */ }
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
    this.securityUnsubscribe?.(); this.securityUnsubscribe = null;
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
    this.localAdverts.clear();
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

  /**
   * Sends one dashboard command over the bridge's direct channel, connecting to the bridge first if needed. Resolves once the
   * command has left, with a handle on the bridge's answer; resolves null when the bridge cannot be reached directly or does not
   * serve commands there (the caller then uses the relay). The answer rejects with DirectUnsentError when the command never left,
   * and with another error when the channel closed or stayed silent for `timeoutMs` after it was sent.
   */
  async directCommand(bridgeId: string, route: DirectCommandRoute, data: unknown, timeoutMs = DIRECT_COMMAND_TIMEOUT_MS): Promise<{ answer: Promise<ApplicationJson> } | null> {
    const peer = await this.commandPeer(bridgeId);
    if (!peer?.command) return null;
    let waiting = this.directWaiters.get(peer);
    if (!waiting) {
      const created = new Set<(error: Error) => void>();
      waiting = created; this.directWaiters.set(peer, created);
      peer.onClose(() => { for (const reject of [...created]) reject(new Error('Direct channel closed')); created.clear(); });
    }
    const waiters = waiting;
    const handle = peer.command(route, data);
    const answer = new Promise<ApplicationJson>((resolve, reject) => {
      const fail = (error: Error) => { clearTimeout(timer); waiters.delete(fail); reject(error); };
      // One unanswered command is enough to stop using this channel for commands; terminal traffic has its own keepalive.
      const timer = setTimeout(() => { this.directUnanswered.add(peer); fail(new Error('Direct command timed out')); }, timeoutMs);
      waiters.add(fail);
      handle.answer.then(value => { clearTimeout(timer); waiters.delete(fail); resolve(value); },
        (error: unknown) => fail(error instanceof Error ? error : new Error('Direct command failed')));
    });
    // The caller may not look at the answer before `sent` settles.
    answer.catch(() => {});
    await handle.sent;
    return { answer };
  }

  /**
   * The bridge's attached peer, if it serves commands.
   *
   * Commands wait for the connection: from the first attempt (or from the moment an attached channel was lost) there is a window
   * of DIRECT_CONNECT_WAIT_MS in which failed attempts are retried quickly and commands are held. A bridge that has only just
   * learned about this browser, or is restarting, connects within it. After the window the caller is no longer held up: the relay
   * carries the command, and a new attempt is started in the background at most every DIRECT_RETRY_MS.
   */
  private async commandPeer(bridgeId: string): Promise<DirectPeerApi | null> {
    for (;;) {
      if (this.disposed) return null;
      const pe = this.peers.get(bridgeId) ?? this.ensurePeer(bridgeId);
      const inWindow = Date.now() - pe.windowStartedAt < DIRECT_CONNECT_WAIT_MS;
      if (pe.status === 'failed') {
        // Sessions on the cloud path have their own upgrade loop; it must not race a second ladder.
        const owned = pe.upgradeInFlight || pe.upgradeTimer !== null || this.hasCentrifugoSessions(pe);
        const since = Date.now() - pe.failedAt;
        const delay = inWindow ? DIRECT_QUICK_RETRY_MS : DIRECT_RETRY_MS;
        if (!owned && since >= delay) {
          pe.status = 'connecting'; pe.reason = null;
          void this.runLadder(bridgeId);
        } else if (!owned && inWindow) {
          await new Promise<void>(resolve => setTimeout(resolve, delay - since));
          continue;
        } else {
          return null;
        }
      }
      if (pe.status === 'connecting') {
        if (!inWindow) return null;
        await new Promise<void>(resolve => {
          const done = () => { clearTimeout(timer); const index = pe.settleWaiters.indexOf(done); if (index >= 0) pe.settleWaiters.splice(index, 1); resolve(); };
          const timer = setTimeout(done, Math.max(1, pe.windowStartedAt + DIRECT_CONNECT_WAIT_MS - Date.now()));
          pe.settleWaiters.push(done);
        });
        if (this.peers.get(bridgeId) !== pe) return null;
        if ((pe.status as PeerStatus) !== 'attached') continue;
      }
      const peer = (pe.status as PeerStatus) === 'attached' ? pe.peer : null;
      if (!peer?.command || this.directUnanswered.has(peer)) return null;
      if (!(await (peer.whenCommandsKnown?.() ?? Promise.resolve(false)))) return null;
      return !this.disposed && this.peers.get(bridgeId)?.peer === peer ? peer : null;
    }
  }

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
      settleWaiters: [],
      failedAt: 0,
      windowStartedAt: Date.now(),
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
    // A port remembered from an earlier page load is tried before anything is asked of the relay.
    const remembered = this.rememberedPorts.get(bridgeId);
    if (remembered !== undefined) {
      const lp = await this.attemptLoopback(bridgeId, { localPort: remembered }, ctx);
      if (lp) return { peer: lp, kind: 'local' };
      if (ctx.aborted()) return null;
    }
    // A remembered address needs nothing from the relay, so it runs beside the signaled rungs instead of ahead of them: on the
    // bridge's network it answers long before signaling could, and away from it nothing waits for it to time out.
    const signaled = this.climbSignaled(bridgeId, ctx, remembered);
    const addressed = this.attemptAddressed(bridgeId, ctx);
    return new Promise(resolve => {
      let open = 2;
      const settle = (result: { peer: DirectPeerApi; kind: 'local' | 'webrtc' } | null) => {
        open--;
        if (result) resolve(result);
        else if (open === 0) resolve(null);
      };
      void signaled.then(settle, () => settle(null));
      void addressed.then(peer => settle(peer ? { peer, kind: 'webrtc' } : null), () => settle(null));
    });
  }

  /** The rungs that need the relay: the advertised localhost port, then signaled WebRTC. */
  private async climbSignaled(
    bridgeId: string,
    ctx: LadderCtx,
    remembered: number | undefined,
  ): Promise<{ peer: DirectPeerApi; kind: 'local' | 'webrtc' } | null> {
    if (this.hasLoopbackAdvertChance()) {
      let advert: BridgeLocalAdvert | null = null;
      try {
        advert = await this.getLocalAdvert(bridgeId);
      } catch {
        advert = null;
      }
      if (ctx.aborted()) return null;

      // The port just tried is not tried again; a different one means the bridge restarted on another port.
      if (advert && advert.localPort !== remembered) {
        const lp = await this.attemptLoopback(bridgeId, advert, ctx);
        if (lp) return { peer: lp, kind: 'local' };
        if (ctx.aborted()) return null;
      }
    }

    const wp = await this.attemptWebRtc(bridgeId, ctx);
    if (wp) return { peer: wp, kind: 'webrtc' };
    return null;
  }

  /**
   * Connects to the bridge's remembered addresses with no signaling, all at once; the first to complete the encrypted handshake
   * wins and the rest are closed. Resolves null when there is nothing remembered or nothing answers.
   */
  private async attemptAddressed(bridgeId: string, ctx: LadderCtx): Promise<WebRtcPeerApi | null> {
    const known = this.rememberedAddresses.get(bridgeId);
    if (!known || this.localOnly) return null;
    const peers: WebRtcPeerApi[] = [];
    for (const ip of known.addresses.slice(0, MAX_ADDRESSES_TRIED)) {
      try {
        peers.push(this.peerFactory({ bridgeId, clientId: this.clientId, sendSignal: () => {}, securityRuntime: this.securityRuntime,
          address: { ip, port: known.port, fingerprint: known.fingerprint } }));
      } catch { /* WebRTC unavailable here */ }
    }
    if (!peers.length) return null;
    const winner = await new Promise<WebRtcPeerApi | null>(resolve => {
      let failed = 0;
      for (const peer of peers) peer.connect().then(() => resolve(peer), () => { if (++failed === peers.length) resolve(null); });
    });
    for (const peer of peers) if (peer !== winner) peer.close();
    // Another rung attached first, or the run was superseded.
    if (winner && ctx.aborted()) { winner.close(); return null; }
    return winner;
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
        securityRuntime: this.securityRuntime,
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
    if (this.localOnly) return null;
    let peer: WebRtcPeerApi;
    try {
      peer = this.peerFactory({
        bridgeId,
        clientId: this.clientId,
        sendSignal: (m) => this.publishCommand(m),
        securityRuntime: this.securityRuntime,
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
    for (const done of pe.settleWaiters.splice(0)) done();
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
    pe.failedAt = Date.now();
    // Losing a working channel opens a new window; a failed attempt does not extend the current one.
    if (wasDirectlyReachable) pe.windowStartedAt = pe.failedAt;
    for (const done of pe.settleWaiters.splice(0)) done();
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
      if (entry && !entry.disposed && (entry.mode === 'centrifugo' || (this.localOnly && entry.mode === 'connecting'))) return true;
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
    // Let the authenticated loopback handshake determine local reachability,
    // even when Fly cannot answer presence queries.
    if (this.localAdverts.has(bridgeId)) return true;
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
      if (this.localOnly && entry.mode === 'connecting') {
        this.goDirect(entry, peer, this.modeForKind(kind));
      } else if (entry.mode === 'centrifugo') {
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
    this.sendWatch('terminal_unwatch', entry);
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
    if (this.localOnly) {
      entry.direct = false;
      entry.pendingInput = [];
      entry.pendingInputChars = 0;
      this.setMode(entry, 'connecting');
      return;
    }
    // Abandon any in-flight upgrade switchover (the new peer is gone/superseded).
    entry.pendingSwitchPeer = null;
    if (entry.switchWatchdog) {
      clearTimeout(entry.switchWatchdog);
      entry.switchWatchdog = null;
    }
    if (entry.disposed || entry.mode === 'centrifugo') return;
    entry.direct = false;

    const outputChannel = sessionChannel("terminal", entry.sessionId, this.userId);
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
    // Every successful subscribe needs a fresh screen, even if the bridge still
    // remembers our previous watch. Only heartbeats reuse the same watcher ID.
    outputSub.on('subscribed', () => {
      if (entry.disposed) return;
      this.sendWatch('terminal_unwatch', entry);
      entry.watchId = crypto.randomUUID();
      this.sendWatch('terminal_watch', entry);
      if (entry.watchTimer === null) {
        entry.watchTimer = setInterval(
          () => this.sendWatch('terminal_watch', entry),
          WATCH_HEARTBEAT_MS,
        );
      }
    });
    outputSub.subscribe();
    entry.outputSub = outputSub;

    const inputChannel = sessionChannel("terminal-input", entry.sessionId, this.userId);
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
    const channel = accountChannel("bridges:presence", this.userId);
    const existing = this.client.getSubscription(channel);
    if (existing) return existing;
    if (this.ownedPresenceSub) return this.ownedPresenceSub;
    const sub = this.client.newSubscription(channel);
    sub.subscribe();
    this.ownedPresenceSub = sub;
    return sub;
  }

  private rememberPort(bridgeId: string, port: number): void {
    if (!validPort(port) || this.rememberedPorts.get(bridgeId) === port) return;
    // Re-inserted so the map stays ordered by when a port was last learned; the oldest is dropped at the limit.
    this.rememberedPorts.delete(bridgeId);
    this.rememberedPorts.set(bridgeId, port);
    while (this.rememberedPorts.size > MAX_REMEMBERED_PORTS) this.rememberedPorts.delete(this.rememberedPorts.keys().next().value!);
    writeRememberedPorts(this.rememberedPorts);
  }

  private async defaultGetLocalAdvert(bridgeId: string): Promise<BridgeLocalAdvert | null> {
    const cached = this.localAdverts.get(bridgeId) ?? null;
    const sub = this.ensurePresenceSub();
    if (typeof sub.presence !== 'function') return cached;
    const result = await this.readPresenceBounded(sub);
    if (!result) return cached;
    for (const info of Object.values(result.clients)) {
      const ci = info.connInfo as
        | { bridgeId?: string; localPort?: number; localNonce?: string }
        | undefined;
      if (
        ci &&
        typeof ci.bridgeId === 'string' &&
        typeof ci.localPort === 'number'
      ) {
        this.localAdverts.set(ci.bridgeId, { localPort: ci.localPort });
        this.rememberPort(ci.bridgeId, ci.localPort);
      }
    }
    return this.localAdverts.get(bridgeId) ?? null;
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

  private sendWatch(type: 'terminal_watch' | 'terminal_unwatch', entry: SessionEntry): void {
    if (!entry.watchId) return;
    this.publishCommand({ type, sessionId: entry.sessionId, clientId: entry.watchId });
    if (type === 'terminal_unwatch') entry.watchId = null;
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
      this.sendWatch('terminal_unwatch', entry);
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

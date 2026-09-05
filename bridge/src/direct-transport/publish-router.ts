import { isSignalMessage, isWatchMessage, type DirectCommandMessage } from './contract.js';
import type { DirectPeerManager } from './peer-manager.js';
import type { WatchRegistry } from './watch-registry.js';

/** Minimal view of CentrifugoClient's terminal publish surface (R2 fallback path). */
export interface CentrifugoPublisher {
  publishTerminalData(userId: string, sessionId: string, data: string): Promise<void>;
  publishTerminalScreen(userId: string, sessionId: string, raw: string): Promise<void>;
}

/** Minimal view of the loopback WS rung (LoopbackPeerServer) the router fans to. */
export interface LoopbackPeerServerLike {
  sendOutput(sessionId: string, data: string): void;
  sendScreen(sessionId: string, data: string): void;
  hasAttachedPeers(sessionId: string): boolean;
}

export interface PublishRouterOptions {
  registry: WatchRegistry;
  peerManager: DirectPeerManager;
  centrifugo: CentrifugoPublisher;
  userId: string;
  /** Optional loopback WS rung; output/screen fan out to it as well as WebRTC. */
  loopback?: LoopbackPeerServerLike;
  /**
   * Optional guard: only register watchers for sessions this bridge owns (watch
   * messages fan out to every bridge on the shared commands channel). Defaults
   * to accepting all sessionIds.
   */
  isKnownSession?: (sessionId: string) => boolean;
  /** Injectable log sink for dropped watches (tests); defaults to console.warn. */
  warn?: (message: string) => void;
}

/**
 * Cap on remembered "already logged" sessionIds. Watch messages fan out to
 * every bridge on commands:rpc, so a long-lived bridge on a busy account would
 * otherwise accumulate one entry per foreign session forever.
 */
const UNKNOWN_LOG_CAP = 500;

/**
 * Implements R2: terminal output/screen always fan out to direct-attached peers;
 * they also go to Centrifugo iff the session has an unexpired remote watcher.
 * Truncation for the Centrifugo path stays inside CentrifugoClient's publishers.
 */
export class PublishRouter {
  private readonly registry: WatchRegistry;
  private readonly peerManager: DirectPeerManager;
  private readonly centrifugo: CentrifugoPublisher;
  private readonly userId: string;
  private readonly loopback?: LoopbackPeerServerLike;
  private readonly isKnownSession: (sessionId: string) => boolean;
  private readonly warn: (message: string) => void;
  /** sessionIds already logged as unknown; keeps heartbeats from spamming. */
  private readonly unknownLogged = new Set<string>();

  constructor(options: PublishRouterOptions) {
    this.registry = options.registry;
    this.peerManager = options.peerManager;
    this.centrifugo = options.centrifugo;
    this.userId = options.userId;
    this.loopback = options.loopback;
    this.isKnownSession = options.isKnownSession ?? (() => true);
    this.warn = options.warn ?? ((message) => console.warn(message));
  }

  /** R2 gating: a session is direct-attached if EITHER local rung has a peer. */
  hasAttachedPeers(sessionId: string): boolean {
    return (
      this.peerManager.hasAttachedPeers(sessionId) ||
      (this.loopback?.hasAttachedPeers(sessionId) ?? false)
    );
  }

  publishTerminalData(sessionId: string, data: string): void {
    this.peerManager.sendOutput(sessionId, data);
    this.loopback?.sendOutput(sessionId, data);
    if (this.registry.hasWatchers(sessionId)) {
      this.centrifugo.publishTerminalData(this.userId, sessionId, data).catch((err) => {
        console.error(`[DirectTransport] Failed to publish terminal data for ${sessionId}:`, err);
      });
    }
  }

  publishTerminalScreen(sessionId: string, screen: string): void {
    this.peerManager.sendScreen(sessionId, screen);
    this.loopback?.sendScreen(sessionId, screen);
    if (this.registry.hasWatchers(sessionId)) {
      this.centrifugo.publishTerminalScreen(this.userId, sessionId, screen).catch((err) => {
        console.error(`[DirectTransport] Failed to publish terminal screen for ${sessionId}:`, err);
      });
    }
  }

  /** Never throws — runs inside the Centrifugo publication listener. */
  handleCommand(msg: DirectCommandMessage): void {
    try {
      if (isSignalMessage(msg)) {
        this.peerManager.handleSignal(msg);
        return;
      }
      if (isWatchMessage(msg)) {
        if (typeof msg.sessionId !== 'string' || msg.sessionId === '') return;
        if (typeof msg.clientId !== 'string' || msg.clientId === '') return;
        if (msg.type === 'terminal_watch') {
          if (!this.isKnownSession(msg.sessionId)) {
            this.logUnknownWatch(msg.sessionId);
            return;
          }
          this.registry.watch(msg.sessionId, msg.clientId);
        } else {
          this.registry.unwatch(msg.sessionId, msg.clientId);
        }
      }
    } catch (err) {
      console.error('[DirectTransport] Failed to handle direct command:', err);
    }
  }

  /**
   * A dropped watch is normal for another bridge's session, but for a session
   * the user IS looking at it renders a permanently blank pane — and used to be
   * silent. Log once per sessionId: watchers re-send terminal_watch every
   * WATCH_HEARTBEAT_MS, so an unconditional line would repeat every 20s forever.
   */
  private logUnknownWatch(sessionId: string): void {
    if (this.unknownLogged.has(sessionId)) return;
    if (this.unknownLogged.size >= UNKNOWN_LOG_CAP) this.unknownLogged.clear();
    this.unknownLogged.add(sessionId);
    this.warn(
      `[DirectTransport] Dropped terminal_watch for unknown session ${sessionId} ` +
      '(no running process, no terminal buffer, no tmux session on this bridge)',
    );
  }
}

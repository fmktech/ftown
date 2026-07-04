import { isSignalMessage, isWatchMessage, type DirectCommandMessage } from './contract.js';
import type { DirectPeerManager } from './peer-manager.js';
import type { WatchRegistry } from './watch-registry.js';

/** Minimal view of CentrifugoClient's terminal publish surface (R2 fallback path). */
export interface CentrifugoPublisher {
  publishTerminalData(userId: string, sessionId: string, data: string): Promise<void>;
  publishTerminalScreen(userId: string, sessionId: string, raw: string): Promise<void>;
}

export interface PublishRouterOptions {
  registry: WatchRegistry;
  peerManager: DirectPeerManager;
  centrifugo: CentrifugoPublisher;
  userId: string;
  /**
   * Optional guard: only register watchers for sessions this bridge owns (watch
   * messages fan out to every bridge on the shared commands channel). Defaults
   * to accepting all sessionIds.
   */
  isKnownSession?: (sessionId: string) => boolean;
}

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
  private readonly isKnownSession: (sessionId: string) => boolean;

  constructor(options: PublishRouterOptions) {
    this.registry = options.registry;
    this.peerManager = options.peerManager;
    this.centrifugo = options.centrifugo;
    this.userId = options.userId;
    this.isKnownSession = options.isKnownSession ?? (() => true);
  }

  publishTerminalData(sessionId: string, data: string): void {
    this.peerManager.sendOutput(sessionId, data);
    if (this.registry.hasWatchers(sessionId)) {
      this.centrifugo.publishTerminalData(this.userId, sessionId, data).catch((err) => {
        console.error(`[DirectTransport] Failed to publish terminal data for ${sessionId}:`, err);
      });
    }
  }

  publishTerminalScreen(sessionId: string, screen: string): void {
    this.peerManager.sendScreen(sessionId, screen);
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
          if (!this.isKnownSession(msg.sessionId)) return;
          this.registry.watch(msg.sessionId, msg.clientId);
        } else {
          this.registry.unwatch(msg.sessionId, msg.clientId);
        }
      }
    } catch (err) {
      console.error('[DirectTransport] Failed to handle direct command:', err);
    }
  }
}

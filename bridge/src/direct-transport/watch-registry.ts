import { WATCH_TTL_MS } from './contract.js';

type FirstWatcherCallback = (sessionId: string) => void;

export interface WatchRegistryOptions {
  /** Injectable clock (defaults to Date.now) so tests can control expiry. */
  now?: () => number;
  /** Watcher lifetime; defaults to the frozen WATCH_TTL_MS. */
  ttlMs?: number;
  /** Housekeeping sweep interval; set 0 to disable the timer (lazy expiry only). */
  sweepIntervalMs?: number;
}

/**
 * Tracks unexpired remote watchers per session. Expiry is lazy (evaluated
 * against the injectable clock on every read) with an optional unref'd sweep
 * timer for memory housekeeping. `onFirstWatcher` fires when a session
 * transitions 0 -> 1 live watchers; `onNewWatcher` fires whenever a clientId
 * that was not already a live watcher registers (first watcher, each
 * additional distinct client, and re-registration after TTL expiry — but not
 * heartbeat refreshes).
 */
export class WatchRegistry {
  private readonly watchers = new Map<string, Map<string, number>>();
  private readonly firstWatcherCallbacks: FirstWatcherCallback[] = [];
  private readonly newWatcherCallbacks: FirstWatcherCallback[] = [];
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly sweepTimer?: ReturnType<typeof setInterval>;

  constructor(options: WatchRegistryOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    this.ttlMs = options.ttlMs ?? WATCH_TTL_MS;
    const sweepIntervalMs = options.sweepIntervalMs ?? WATCH_TTL_MS;
    if (sweepIntervalMs > 0) {
      this.sweepTimer = setInterval(() => this.sweep(), sweepIntervalMs);
      this.sweepTimer.unref?.();
    }
  }

  watch(sessionId: string, clientId: string): void {
    let inner = this.watchers.get(sessionId);
    if (!inner) {
      inner = new Map();
      this.watchers.set(sessionId, inner);
    }
    const hadWatchers = this.liveCount(inner) > 0;
    const wasLiveWatcher = inner.has(clientId);
    inner.set(clientId, this.now() + this.ttlMs);
    if (!hadWatchers) {
      for (const cb of this.firstWatcherCallbacks) cb(sessionId);
    }
    if (!wasLiveWatcher) {
      for (const cb of this.newWatcherCallbacks) cb(sessionId);
    }
  }

  unwatch(sessionId: string, clientId: string): void {
    const inner = this.watchers.get(sessionId);
    if (!inner) return;
    inner.delete(clientId);
    if (inner.size === 0) this.watchers.delete(sessionId);
  }

  hasWatchers(sessionId: string): boolean {
    const inner = this.watchers.get(sessionId);
    if (!inner) return false;
    const live = this.liveCount(inner) > 0;
    if (!live) this.watchers.delete(sessionId);
    return live;
  }

  onFirstWatcher(cb: FirstWatcherCallback): void {
    this.firstWatcherCallbacks.push(cb);
  }

  /** Fires for every distinct client registration (incl. post-expiry re-registration). */
  onNewWatcher(cb: FirstWatcherCallback): void {
    this.newWatcherCallbacks.push(cb);
  }

  dispose(): void {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.watchers.clear();
    this.firstWatcherCallbacks.length = 0;
    this.newWatcherCallbacks.length = 0;
  }

  /** Prunes expired entries from `inner` and returns the remaining live count. */
  private liveCount(inner: Map<string, number>): number {
    const now = this.now();
    for (const [clientId, expiresAt] of inner) {
      if (expiresAt <= now) inner.delete(clientId);
    }
    return inner.size;
  }

  private sweep(): void {
    for (const [sessionId, inner] of this.watchers) {
      if (this.liveCount(inner) === 0) this.watchers.delete(sessionId);
    }
  }
}

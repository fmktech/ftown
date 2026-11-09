import { UnauthorizedError } from 'centrifuge';

import type { BridgeAuthResponse } from './bridge-auth.js';

export interface RotatingTokenRefresherOptions {
  initialRefreshToken: string;
  refresh: (refreshToken: string) => Promise<BridgeAuthResponse>;
  loadPersistedRefreshToken: () => string | undefined;
  persistRefreshToken: (refreshToken: string) => void;
  onPersistedTokenRecovery?: () => void;
  /** Monotonic clock in ms; injectable for tests. */
  now?: () => number;
  /** Jitter source in [0, 1); injectable for tests. */
  random?: () => number;
}

const COOLDOWN_BASE_MS = 15_000;
const COOLDOWN_MAX_MS = 600_000;

/**
 * Owns the bridge's single-use refresh token.
 *
 * Token rotation is single-flight inside this process: if centrifuge-js asks
 * for a token twice concurrently, both callers share one exchange instead of
 * racing the same credential. If another process already rotated the token and
 * persisted its replacement, a rejected in-memory token gets one recovery
 * attempt from disk — the same state repair that previously required restart.
 *
 * Transient failures (network errors, 5xx) arm an exponential cooldown during
 * which getToken() rejects without calling the API, because centrifuge-js
 * retries a failed token fetch every 5-10 s with no growth. The cooldown error
 * is deliberately not an UnauthorizedError: centrifuge-js treats that as
 * permanent and stops retrying for good.
 */
export class RotatingTokenRefresher {
  private currentRefreshToken: string;
  private inFlight: Promise<string> | null = null;
  private consecutiveFailures = 0;
  private cooldownUntil = 0;
  private readonly now: () => number;
  private readonly random: () => number;

  constructor(private readonly options: RotatingTokenRefresherOptions) {
    this.currentRefreshToken = options.initialRefreshToken;
    this.now = options.now ?? (() => performance.now());
    this.random = options.random ?? Math.random;
  }

  cooldownRemainingMs(): number {
    return Math.max(0, this.cooldownUntil - this.now());
  }

  getToken(): Promise<string> {
    if (this.inFlight) return this.inFlight;

    const remaining = this.cooldownRemainingMs();
    if (remaining > 0) {
      return Promise.reject(
        new Error(
          `Token refresh cooling down for ${Math.ceil(remaining / 1000)}s after ${this.consecutiveFailures} failed attempts`,
        ),
      );
    }

    const operation = this.refreshAndRotate().finally(() => {
      if (this.inFlight === operation) this.inFlight = null;
    });
    this.inFlight = operation;
    return operation;
  }

  private async refreshAndRotate(): Promise<string> {
    try {
      const token = await this.exchange();
      this.consecutiveFailures = 0;
      this.cooldownUntil = 0;
      return token;
    } catch (error) {
      if (!(error instanceof UnauthorizedError)) this.armCooldown();
      throw error;
    }
  }

  private armCooldown(): void {
    this.consecutiveFailures++;
    const base = Math.min(
      COOLDOWN_BASE_MS * 2 ** (this.consecutiveFailures - 1),
      COOLDOWN_MAX_MS,
    );
    this.cooldownUntil = this.now() + base * (0.8 + 0.4 * this.random());
  }

  private async exchange(): Promise<string> {
    let refreshed: BridgeAuthResponse;
    try {
      refreshed = await this.options.refresh(this.currentRefreshToken);
    } catch (error) {
      if (!(error instanceof UnauthorizedError)) throw error;

      const persistedToken = this.options.loadPersistedRefreshToken();
      if (!persistedToken || persistedToken === this.currentRefreshToken) {
        throw error;
      }

      // Another bridge process sharing this data directory completed a
      // rotation first. Adopt its persisted token and retry exactly once.
      this.currentRefreshToken = persistedToken;
      this.options.onPersistedTokenRecovery?.();
      refreshed = await this.options.refresh(this.currentRefreshToken);
    }

    this.currentRefreshToken = refreshed.refreshToken;
    this.options.persistRefreshToken(this.currentRefreshToken);
    return refreshed.token;
  }
}

import { UnauthorizedError } from 'centrifuge';

import type { BridgeAuthResponse } from './bridge-auth.js';

export interface RotatingTokenRefresherOptions {
  initialRefreshToken: string;
  refresh: (refreshToken: string) => Promise<BridgeAuthResponse>;
  loadPersistedRefreshToken: () => string | undefined;
  persistRefreshToken: (refreshToken: string) => void;
  onPersistedTokenRecovery?: () => void;
}

/**
 * Owns the bridge's single-use refresh token.
 *
 * Token rotation is single-flight inside this process: if centrifuge-js asks
 * for a token twice concurrently, both callers share one exchange instead of
 * racing the same credential. If another process already rotated the token and
 * persisted its replacement, a rejected in-memory token gets one recovery
 * attempt from disk — the same state repair that previously required restart.
 */
export class RotatingTokenRefresher {
  private currentRefreshToken: string;
  private inFlight: Promise<string> | null = null;

  constructor(private readonly options: RotatingTokenRefresherOptions) {
    this.currentRefreshToken = options.initialRefreshToken;
  }

  getToken(): Promise<string> {
    if (this.inFlight) return this.inFlight;

    const operation = this.refreshAndRotate().finally(() => {
      if (this.inFlight === operation) this.inFlight = null;
    });
    this.inFlight = operation;
    return operation;
  }

  private async refreshAndRotate(): Promise<string> {
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

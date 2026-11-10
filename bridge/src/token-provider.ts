import { UnauthorizedError } from 'centrifuge';

export interface ProvidedToken {
  token: string;
  /** The server's absolute expiry. Never compared with the local clock: reuse is timed from the JWT's own exp − iat. */
  expiresAt: number;
}

export interface TokenProviderOptions {
  /** One proof-signed relay-token exchange (createRelayTokenFetcher plus the caller's hooks). */
  fetchToken: () => Promise<ProvidedToken>;
  /** Monotonic clock in ms (cooldown, reuse window, remembered 401); injectable for tests. */
  now?: () => number;
  /** Jitter source in [0, 1); injectable for tests. */
  random?: () => number;
  /** The local ledger head: a remembered 401 is forgotten as soon as it changes. */
  head?: () => string | null;
}

export interface TokenProvider {
  /**
   * A token while it has more than a minute left, else one shared exchange. Rejects (not as UnauthorizedError) while cooling down
   * after transient failures, and rethrows a remembered UnauthorizedError for 10 minutes or until the local ledger head changes.
   */
  getToken(): Promise<string>;
  cooldownRemainingMs(): number;
}

const COOLDOWN_BASE_MS = 15_000;
const COOLDOWN_MAX_MS = 600_000;
/** A token is reused until this long before it expires. */
const REUSE_MARGIN_MS = 60_000;
/** A refused key is not retried for this long, unless the local ledger changes. */
const UNAUTHORIZED_MEMORY_MS = 600_000;
/** A server that claims a longer lifetime is not believed beyond this. */
const MAX_LIFETIME_MS = 2 * 3_600_000;

/** exp − iat of a JWT in ms (capped at 2 h), or null when it is not a JWT with a positive numeric lifetime. */
export function tokenLifetimeMs(token: string): number | null {
  const parts = token.split('.');
  if (parts.length !== 3 || parts[1].length === 0) return null;
  let claims: unknown;
  try { claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')); } catch { return null; }
  if (typeof claims !== 'object' || claims === null || Array.isArray(claims)) return null;
  const { exp, iat } = claims as { exp?: unknown; iat?: unknown };
  if (typeof exp !== 'number' || typeof iat !== 'number' || !Number.isFinite(exp) || !Number.isFinite(iat)) return null;
  const lifetime = (exp - iat) * 1000;
  return lifetime > 0 ? Math.min(lifetime, MAX_LIFETIME_MS) : null;
}

/**
 * Owns the bridge's relay (Centrifugo) token. There is no stored credential: every exchange proves the bridge auth key.
 *
 * Exchanges are single-flight: concurrent callers (centrifuge-js, the push notifier, the endpoint directory) share one. A token is
 * reused until a minute before it expires, timed on the monotonic clock from its arrival and its own exp − iat, so a skewed local
 * clock can neither stretch nor shrink it.
 *
 * Transient failures (network errors, 5xx) arm an exponential cooldown (15 s doubling to 10 min, ±20% jitter) during which getToken()
 * rejects without calling the server, because centrifuge-js retries a failed token fetch every 5-10 s with no growth. The cooldown error
 * is deliberately not an UnauthorizedError: centrifuge-js treats that as permanent and stops retrying for good. An UnauthorizedError
 * never arms the cooldown and propagates as is; it is remembered (10 min, or until the local ledger head changes) so a refused key is
 * not re-proven on every call. A success resets the cooldown and the memory.
 */
export function createTokenProvider(options: TokenProviderOptions): TokenProvider {
  const now = options.now ?? (() => performance.now());
  const random = options.random ?? Math.random;
  const head = options.head ?? (() => null);
  let inFlight: Promise<string> | null = null;
  let cached: { token: string; reuseUntil: number } | null = null;
  let refused: { error: unknown; until: number; head: string | null } | null = null;
  let consecutiveFailures = 0;
  let cooldownUntil = 0;

  const cooldownRemainingMs = (): number => Math.max(0, cooldownUntil - now());

  const armCooldown = (): void => {
    consecutiveFailures++;
    const base = Math.min(COOLDOWN_BASE_MS * 2 ** (consecutiveFailures - 1), COOLDOWN_MAX_MS);
    cooldownUntil = now() + base * (0.8 + 0.4 * random());
  };

  const exchange = async (): Promise<string> => {
    try {
      const fetched = await options.fetchToken();
      const arrivedAt = now();
      consecutiveFailures = 0;
      cooldownUntil = 0;
      refused = null;
      const lifetime = tokenLifetimeMs(fetched.token);
      cached = lifetime === null ? null : { token: fetched.token, reuseUntil: arrivedAt + lifetime - REUSE_MARGIN_MS };
      return fetched.token;
    } catch (error) {
      if (error instanceof UnauthorizedError) refused = { error, until: now() + UNAUTHORIZED_MEMORY_MS, head: head() };
      else armCooldown();
      throw error;
    }
  };

  const getToken = (): Promise<string> => {
    if (inFlight) return inFlight;
    if (cached !== null && now() < cached.reuseUntil) return Promise.resolve(cached.token);
    cached = null;

    if (refused !== null) {
      if (now() < refused.until && head() === refused.head) return Promise.reject(refused.error);
      refused = null;
    }

    const remaining = cooldownRemainingMs();
    if (remaining > 0) {
      return Promise.reject(new Error(`Token refresh cooling down for ${Math.ceil(remaining / 1000)}s after ${consecutiveFailures} failed attempts`));
    }

    const operation = exchange().finally(() => {
      if (inFlight === operation) inFlight = null;
    });
    inFlight = operation;
    return operation;
  };

  return { getToken, cooldownRemainingMs };
}

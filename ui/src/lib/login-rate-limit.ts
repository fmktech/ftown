import { getDb } from "@/lib/db";

/**
 * Generic, scope-keyed rate limiter backed by the `rate_limit_attempts` table.
 *
 * A "scope" isolates independent limiters (e.g. "login" vs "register") so their
 * counters never collide, and a "key" identifies the subject within a scope
 * (an email for login, a client IP for registration).
 */

export interface RateLimitConfig {
  /** Attempts allowed before a lockout kicks in. */
  maxAttempts: number;
  /** How long a subject stays locked out once the threshold is hit. */
  lockoutMs: number;
}

export const LOGIN_RATE_LIMIT: RateLimitConfig = {
  maxAttempts: 10,
  lockoutMs: 60 * 60 * 1000, // 1 hour
};

export const REGISTER_RATE_LIMIT: RateLimitConfig = {
  maxAttempts: 10,
  lockoutMs: 60 * 60 * 1000, // 1 hour
};

interface RateLimitRow {
  failed_count: number;
  locked_until: string | null;
}

export interface RateLimitResult {
  allowed: boolean;
  retryAfterMs?: number;
}

export async function checkRateLimit(scope: string, key: string): Promise<RateLimitResult> {
  const sql = getDb();

  const rows = (await sql.query(
    "SELECT failed_count, locked_until FROM rate_limit_attempts WHERE scope = $1 AND key = $2",
    [scope, key]
  )) as RateLimitRow[];

  if (rows.length === 0) {
    return { allowed: true };
  }

  const row = rows[0];
  if (row.locked_until) {
    const lockedUntil = new Date(row.locked_until);
    const now = new Date();
    if (now < lockedUntil) {
      return { allowed: false, retryAfterMs: lockedUntil.getTime() - now.getTime() };
    }
    // Lockout expired — reset and allow.
    await sql.query(
      "UPDATE rate_limit_attempts SET failed_count = 0, locked_until = NULL, updated_at = NOW() WHERE scope = $1 AND key = $2",
      [scope, key]
    );
    return { allowed: true };
  }

  return { allowed: true };
}

export async function recordAttempt(
  scope: string,
  key: string,
  config: RateLimitConfig
): Promise<void> {
  const sql = getDb();

  const rows = (await sql.query(
    "SELECT failed_count FROM rate_limit_attempts WHERE scope = $1 AND key = $2",
    [scope, key]
  )) as { failed_count: number }[];

  if (rows.length === 0) {
    await sql.query(
      "INSERT INTO rate_limit_attempts (scope, key, failed_count, updated_at) VALUES ($1, $2, 1, NOW())",
      [scope, key]
    );
    return;
  }

  const newCount = rows[0].failed_count + 1;
  if (newCount >= config.maxAttempts) {
    const lockedUntil = new Date(Date.now() + config.lockoutMs).toISOString();
    await sql.query(
      "UPDATE rate_limit_attempts SET failed_count = $1, locked_until = $2, updated_at = NOW() WHERE scope = $3 AND key = $4",
      [newCount, lockedUntil, scope, key]
    );
  } else {
    await sql.query(
      "UPDATE rate_limit_attempts SET failed_count = $1, updated_at = NOW() WHERE scope = $2 AND key = $3",
      [newCount, scope, key]
    );
  }
}

export async function resetAttempts(scope: string, key: string): Promise<void> {
  const sql = getDb();
  await sql.query(
    "DELETE FROM rate_limit_attempts WHERE scope = $1 AND key = $2",
    [scope, key]
  );
}

// --- Login-scoped convenience wrappers (used by the credentials provider) ---

const LOGIN_SCOPE = "login";

export function checkLoginRateLimit(email: string): Promise<RateLimitResult> {
  return checkRateLimit(LOGIN_SCOPE, email);
}

export function recordFailedLogin(email: string): Promise<void> {
  return recordAttempt(LOGIN_SCOPE, email, LOGIN_RATE_LIMIT);
}

export function resetLoginAttempts(email: string): Promise<void> {
  return resetAttempts(LOGIN_SCOPE, email);
}

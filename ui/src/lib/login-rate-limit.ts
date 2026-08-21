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
    "SELECT locked_until FROM rate_limit_attempts WHERE scope = $1 AND key = $2",
    [scope, key]
  )) as Pick<RateLimitRow, "locked_until">[];

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
  }

  return { allowed: true };
}

export async function recordAttempt(
  scope: string,
  key: string,
  config: RateLimitConfig
): Promise<void> {
  const sql = getDb();

  // Single-statement atomic upsert: counter increment, lockout decision, and
  // expired-lock reset happen together so concurrent requests cannot race past
  // the threshold (a SELECT-then-UPDATE pair allowed exactly that).
  await sql.query(
    `INSERT INTO rate_limit_attempts (scope, key, failed_count, updated_at)
     VALUES ($1, $2, 1, NOW())
     ON CONFLICT (scope, key) DO UPDATE SET
       failed_count = rate_limit_attempts.failed_count + 1,
       locked_until = CASE
         WHEN rate_limit_attempts.locked_until IS NOT NULL
              AND rate_limit_attempts.locked_until > NOW()
           THEN rate_limit_attempts.locked_until
         WHEN rate_limit_attempts.failed_count + 1 >= $3::integer
           THEN NOW() + ($4::double precision / 1000.0) * interval '1 second'
         ELSE NULL
       END,
       updated_at = NOW()`,
    [scope, key, config.maxAttempts, config.lockoutMs]
  );
}

export async function resetAttempts(scope: string, key: string): Promise<void> {
  const sql = getDb();
  await sql.query(
    "DELETE FROM rate_limit_attempts WHERE scope = $1 AND key = $2",
    [scope, key]
  );
}

// --- Login-scoped convenience wrappers (used by the credentials provider) ---
//
// Two independent limiters: per-email (slows a targeted attack on one account)
// and per-IP (slows credential spraying across many accounts from one source).
// The IP limiter is deliberately looser so shared egress (office NAT, VPN) is
// not locked out by one user's typos.

const LOGIN_SCOPE = "login";
const LOGIN_IP_SCOPE = "login-ip";

export const LOGIN_IP_RATE_LIMIT: RateLimitConfig = {
  maxAttempts: 30,
  lockoutMs: 15 * 60 * 1000, // 15 minutes
};

export function checkLoginRateLimit(email: string): Promise<RateLimitResult> {
  return checkRateLimit(LOGIN_SCOPE, email);
}

export function recordFailedLogin(email: string): Promise<void> {
  return recordAttempt(LOGIN_SCOPE, email, LOGIN_RATE_LIMIT);
}

export function resetLoginAttempts(email: string): Promise<void> {
  return resetAttempts(LOGIN_SCOPE, email);
}

export function checkLoginIpRateLimit(ip: string): Promise<RateLimitResult> {
  return checkRateLimit(LOGIN_IP_SCOPE, ip);
}

export function recordFailedLoginIp(ip: string): Promise<void> {
  return recordAttempt(LOGIN_IP_SCOPE, ip, LOGIN_IP_RATE_LIMIT);
}

export function resetLoginIpAttempts(ip: string): Promise<void> {
  return resetAttempts(LOGIN_IP_SCOPE, ip);
}

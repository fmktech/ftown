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

/** Atomically consume an admission from a fixed, database-clock window. */
export async function consumeRateLimit(
  scope: string,
  key: string,
  config: RateLimitConfig
): Promise<RateLimitResult> {
  if (!Number.isSafeInteger(config.maxAttempts) || config.maxAttempts < 1 || config.maxAttempts >= 2147483647 ||
      !Number.isSafeInteger(config.lockoutMs) || config.lockoutMs < 1) {
    throw new RangeError("Invalid rate limit configuration");
  }

  const rows = await getDb().query(
    `INSERT INTO rate_limit_attempts (scope, key, failed_count, locked_until, updated_at)
     VALUES ($1, $2, 1, NOW() + ($4::double precision / 1000.0) * interval '1 second', NOW())
     ON CONFLICT (scope, key) DO UPDATE SET
       failed_count = CASE
         WHEN rate_limit_attempts.locked_until IS NULL OR rate_limit_attempts.locked_until <= NOW() THEN 1
         ELSE LEAST(rate_limit_attempts.failed_count, $3::integer) + 1
       END,
       locked_until = CASE
         WHEN rate_limit_attempts.locked_until IS NULL OR rate_limit_attempts.locked_until <= NOW()
           THEN NOW() + ($4::double precision / 1000.0) * interval '1 second'
         ELSE rate_limit_attempts.locked_until
       END,
       updated_at = NOW()
     RETURNING failed_count <= $3::integer AS allowed,
       GREATEST(0, LEAST($4::double precision,
         CEIL(EXTRACT(EPOCH FROM (locked_until - NOW())) * 1000))) AS retry_after_ms`,
    [scope, key, config.maxAttempts, config.lockoutMs]
  ) as { allowed: boolean; retry_after_ms: number | string }[];
  const row = rows[0];
  return row.allowed ? { allowed: true } : { allowed: false, retryAfterMs: Number(row.retry_after_ms) };
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

  // Atomically increment the legacy counter and reset expired locks. A separate
  // checkRateLimit call is not atomic with this write; use consumeRateLimit
  // when admission must be decided atomically.
  await sql.query(
    `INSERT INTO rate_limit_attempts (scope, key, failed_count, updated_at)
     VALUES ($1, $2, 1, NOW())
     ON CONFLICT (scope, key) DO UPDATE SET
       failed_count = CASE
         WHEN rate_limit_attempts.locked_until IS NOT NULL AND rate_limit_attempts.locked_until <= NOW() THEN 1
         ELSE rate_limit_attempts.failed_count + 1
       END,
       locked_until = CASE
         WHEN rate_limit_attempts.locked_until IS NOT NULL
              AND rate_limit_attempts.locked_until > NOW()
           THEN rate_limit_attempts.locked_until
         WHEN rate_limit_attempts.locked_until IS NOT NULL AND rate_limit_attempts.locked_until <= NOW()
           THEN CASE WHEN $3::integer <= 1 THEN NOW() + ($4::double precision / 1000.0) * interval '1 second' ELSE NULL END
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

// --- Legacy login-scoped convenience wrappers retained for compatibility ---
// The credentials provider now consumes an atomic source-IP admission budget
// via consumeRateLimit rather than using these separate check/write operations.

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

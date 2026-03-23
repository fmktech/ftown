import { getDb } from "@/lib/db";

const MAX_FAILED_ATTEMPTS = 10;
const LOCKOUT_DURATION_MS = 60 * 60 * 1000; // 1 hour

interface LoginAttemptRow {
  failed_count: number;
  locked_until: string | null;
}

export async function checkLoginRateLimit(email: string): Promise<{ allowed: boolean; retryAfterMs?: number }> {
  const sql = getDb();

  const rows = (await sql.query(
    "SELECT failed_count, locked_until FROM login_attempts WHERE email = $1",
    [email]
  )) as LoginAttemptRow[];

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
    // Lockout expired — reset and allow
    await sql.query(
      "UPDATE login_attempts SET failed_count = 0, locked_until = NULL, updated_at = NOW() WHERE email = $1",
      [email]
    );
    return { allowed: true };
  }

  return { allowed: true };
}

export async function recordFailedLogin(email: string): Promise<void> {
  const sql = getDb();

  const rows = (await sql.query(
    "SELECT failed_count FROM login_attempts WHERE email = $1",
    [email]
  )) as { failed_count: number }[];

  if (rows.length === 0) {
    await sql.query(
      "INSERT INTO login_attempts (email, failed_count, updated_at) VALUES ($1, 1, NOW())",
      [email]
    );
    return;
  }

  const newCount = rows[0].failed_count + 1;
  if (newCount >= MAX_FAILED_ATTEMPTS) {
    const lockedUntil = new Date(Date.now() + LOCKOUT_DURATION_MS).toISOString();
    await sql.query(
      "UPDATE login_attempts SET failed_count = $1, locked_until = $2, updated_at = NOW() WHERE email = $3",
      [newCount, lockedUntil, email]
    );
  } else {
    await sql.query(
      "UPDATE login_attempts SET failed_count = $1, updated_at = NOW() WHERE email = $2",
      [newCount, email]
    );
  }
}

export async function resetLoginAttempts(email: string): Promise<void> {
  const sql = getDb();
  await sql.query(
    "DELETE FROM login_attempts WHERE email = $1",
    [email]
  );
}

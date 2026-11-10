import { createHash, randomBytes } from 'node:crypto';
import { getDb } from '@/lib/db';

export type NoncePurpose = 'session' | 'relay' | 'passkey';
const hashNonce = (nonce: string) => createHash('sha256').update(nonce).digest('hex');

/** Issue a single-use server nonce (32 random bytes, base64url). Only its SHA-256 is stored. */
export async function issueNonce(purpose: NoncePurpose): Promise<{ nonce: string; expiresAt: number }> {
  const nonce = randomBytes(32).toString('base64url');
  const db = getDb();
  // Opportunistic cleanup of expired rows; failure must not block issuing.
  await db.query('DELETE FROM auth_nonces WHERE expires_at < NOW()', []).catch(() => undefined);
  const rows = await db.query(
    `INSERT INTO auth_nonces (nonce_hash, purpose, expires_at) VALUES ($1, $2, NOW() + interval '60 seconds')
     RETURNING (EXTRACT(EPOCH FROM expires_at) * 1000)::float8 AS expires_ms`,
    [hashNonce(nonce), purpose],
  ) as { expires_ms: number | string }[];
  const expiresAt = Number(rows[0]?.expires_ms);
  if (!Number.isFinite(expiresAt)) throw new Error('nonce_insert_failed');
  return { nonce, expiresAt };
}

/** Atomically consume a nonce. Returns true at most once per issued nonce. */
export async function consumeNonce(nonce: string, purpose: NoncePurpose): Promise<boolean> {
  if (typeof nonce !== 'string' || nonce.length === 0 || nonce.length > 128) return false;
  const rows = await getDb().query(
    'DELETE FROM auth_nonces WHERE nonce_hash = $1 AND purpose = $2 AND expires_at > NOW() RETURNING nonce_hash',
    [hashNonce(nonce), purpose],
  );
  return Array.isArray(rows) && rows.length > 0;
}

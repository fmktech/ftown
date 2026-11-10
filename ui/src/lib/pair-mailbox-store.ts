import { getDb } from '@/lib/db';

const TTL_MS = 10 * 60_000;
export const PAIR_MAILBOX_MAX_SEALED_BYTES = 256 * 1024;
export type PairApproval = { status: 'ready'; sealed: string } | { status: 'pending' } | { status: 'expired' };

function validRequestId(requestId: string): boolean {
  if (typeof requestId !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(requestId)) return false;
  const bytes = Buffer.from(requestId, 'base64url');
  return bytes.length === 32 && bytes.toString('base64url') === requestId;
}

export async function putPairApproval(requestId: string, accountId: string, sealed: string): Promise<void> {
  if (!validRequestId(requestId)) throw new Error('invalid_request_id');
  if (typeof sealed !== 'string' || Buffer.byteLength(sealed, 'utf8') > PAIR_MAILBOX_MAX_SEALED_BYTES) throw new Error('pair_mailbox_too_large');
  const rows = await getDb().query(
    `INSERT INTO pair_mailbox (request_id, account_id, sealed, expires_at) VALUES ($1, $2, $3, $4)
     ON CONFLICT (request_id) DO UPDATE SET sealed = EXCLUDED.sealed, expires_at = EXCLUDED.expires_at
     WHERE pair_mailbox.account_id = EXCLUDED.account_id
     RETURNING request_id`,
    [requestId, accountId, sealed, new Date(Date.now() + TTL_MS).toISOString()],
  );
  // No row returned: the request_id belongs to another account; never hijack it.
  if (!Array.isArray(rows) || rows.length === 0) throw new Error('pair_mailbox_conflict');
}

/** Read without deleting when ready: the bridge may re-read within the TTL after a crash.
 *  After an expired row is deleted, later reads return 'pending'. */
export async function takePairApproval(requestId: string): Promise<PairApproval> {
  if (!validRequestId(requestId)) throw new Error('invalid_request_id');
  const db = getDb();
  const rows = await db.query(
    'SELECT sealed, (expires_at <= NOW()) AS expired FROM pair_mailbox WHERE request_id = $1',
    [requestId],
  ) as { sealed: string; expired: boolean }[];
  const row = rows[0];
  if (!row) return { status: 'pending' };
  if (row.expired) {
    await db.query('DELETE FROM pair_mailbox WHERE request_id = $1 AND expires_at <= NOW()', [requestId]);
    return { status: 'expired' };
  }
  return { status: 'ready', sealed: row.sealed };
}

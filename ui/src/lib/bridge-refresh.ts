import { getDb } from "@/lib/db";

/**
 * Per-bridge refresh-token rotation state.
 *
 * Each bridge has exactly one CURRENT refresh-token id (`jti`) persisted in the
 * `bridge_refresh` table. A refresh token is only accepted if its embedded jti
 * matches the stored current jti; every accepted refresh atomically rotates the
 * stored jti to a new value, which invalidates the token just used (and any
 * older/leaked copy) on next use.
 */

interface JtiRow {
  current_jti: string;
}

/**
 * Establish (or reset) the current jti for a bridge. Called when a fresh
 * refresh token is minted from a bootstrap token — a re-bootstrap deliberately
 * supersedes any previously issued refresh token for the same bridge.
 */
export async function setBridgeRefreshJti(
  bridgeId: string,
  sub: string,
  jti: string
): Promise<void> {
  const sql = getDb();
  await sql.query(
    `INSERT INTO bridge_refresh (bridge_id, sub, current_jti, updated_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (bridge_id)
     DO UPDATE SET sub = EXCLUDED.sub, current_jti = EXCLUDED.current_jti, updated_at = NOW()`,
    [bridgeId, sub, jti]
  );
}

/**
 * Atomically verify that `expectedJti` is the current jti for `bridgeId` and, if
 * so, rotate it to `newJti`. Returns true when the rotation happened (token was
 * valid and fresh), false when the token was stale/reused/unknown.
 */
export async function rotateBridgeRefreshJti(
  bridgeId: string,
  sub: string,
  expectedJti: string,
  newJti: string
): Promise<boolean> {
  const sql = getDb();
  const rows = (await sql.query(
    `UPDATE bridge_refresh
     SET current_jti = $1, updated_at = NOW()
     WHERE bridge_id = $2 AND sub = $3 AND current_jti = $4
     RETURNING current_jti`,
    [newJti, bridgeId, sub, expectedJti]
  )) as JtiRow[];

  return rows.length === 1;
}

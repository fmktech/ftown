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

export interface BridgeDevice {
  bridgeId: string;
  hostname: string | null;
  lastSeen: string | null;
  revoked: boolean;
}

interface DeviceDbRow {
  bridge_id: string;
  hostname: string | null;
  last_seen: string | null;
  current_jti: string | null;
}

const REVOKED_JTI = "revoked";

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

/**
 * Upsert the bridge_refresh row for a device-pairing approval (P4): binds the
 * bridge to the approving sub, sets the current jti, records hostname/last_seen.
 */
export async function upsertBridgeRefresh(r: {
  bridgeId: string;
  sub: string;
  jti: string;
  hostname: string | null;
}): Promise<void> {
  const sql = getDb();
  await sql.query(
    `INSERT INTO bridge_refresh (bridge_id, sub, current_jti, hostname, last_seen, updated_at)
     VALUES ($1, $2, $3, $4, NOW(), NOW())
     ON CONFLICT (bridge_id)
     DO UPDATE SET sub = EXCLUDED.sub, current_jti = EXCLUDED.current_jti,
                   hostname = EXCLUDED.hostname, last_seen = NOW(), updated_at = NOW()`,
    [r.bridgeId, r.sub, r.jti, r.hostname]
  );
}

/**
 * List the caller's paired devices (P6). `revoked` reflects the tombstone
 * sentinel jti value set by revokeDevice.
 */
export async function getDevicesForSub(sub: string): Promise<BridgeDevice[]> {
  const sql = getDb();
  const rows = (await sql.query(
    `SELECT bridge_id, hostname, last_seen, current_jti
     FROM bridge_refresh
     WHERE sub = $1
     ORDER BY last_seen DESC NULLS LAST`,
    [sub]
  )) as DeviceDbRow[];

  return rows.map((row) => ({
    bridgeId: row.bridge_id,
    hostname: row.hostname,
    lastSeen: row.last_seen,
    revoked: row.current_jti === REVOKED_JTI,
  }));
}

/**
 * Owner-scoped revoke (P6): sets current_jti to the tombstone sentinel so the
 * bridge's next refresh attempt fails jti verification and it exits. Scoped by
 * sub so a caller can only revoke their own devices.
 */
export async function revokeDevice(sub: string, bridgeId: string): Promise<boolean> {
  const sql = getDb();
  const rows = (await sql.query(
    `UPDATE bridge_refresh
     SET current_jti = $1, updated_at = NOW()
     WHERE bridge_id = $2 AND sub = $3
     RETURNING bridge_id`,
    [REVOKED_JTI, bridgeId, sub]
  )) as { bridge_id: string }[];

  return rows.length === 1;
}

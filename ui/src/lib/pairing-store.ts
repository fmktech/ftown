import { getDb } from "@/lib/db";

/**
 * Store for `pairing_requests` — the ONLY module that touches that table.
 * See docs/plans/device-pairing-contract.md for the flow and state machine.
 */

export type PairingStatus = "pending" | "approved" | "denied" | "consumed";

export interface PairingRequestRow {
  deviceCode: string;
  userCode: string;
  bridgeId: string;
  hostname: string | null;
  platform: string | null;
  status: PairingStatus;
  sub: string | null;
  refreshJti: string | null;
  createdAt: string;
  expiresAt: string;
  approvedAt: string | null;
}

interface PairingRequestDbRow {
  device_code: string;
  user_code: string;
  bridge_id: string;
  hostname: string | null;
  platform: string | null;
  status: PairingStatus;
  sub: string | null;
  refresh_jti: string | null;
  created_at: string;
  expires_at: string;
  approved_at: string | null;
}

function toRow(r: PairingRequestDbRow): PairingRequestRow {
  return {
    deviceCode: r.device_code,
    userCode: r.user_code,
    bridgeId: r.bridge_id,
    hostname: r.hostname,
    platform: r.platform,
    status: r.status,
    sub: r.sub,
    refreshJti: r.refresh_jti,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
    approvedAt: r.approved_at,
  };
}

export async function createPairingRequest(r: {
  deviceCode: string;
  userCode: string;
  bridgeId: string;
  hostname: string | null;
  platform: string | null;
  expiresAtIso: string;
}): Promise<void> {
  const sql = getDb();
  await sql.query(
    `INSERT INTO pairing_requests (device_code, user_code, bridge_id, hostname, platform, status, expires_at)
     VALUES ($1, $2, $3, $4, $5, 'pending', $6)`,
    [r.deviceCode, r.userCode, r.bridgeId, r.hostname, r.platform, r.expiresAtIso]
  );
}

export async function getByDeviceCode(deviceCode: string): Promise<PairingRequestRow | null> {
  const sql = getDb();
  const rows = (await sql.query(
    `SELECT * FROM pairing_requests WHERE device_code = $1`,
    [deviceCode]
  )) as PairingRequestDbRow[];
  return rows.length === 1 ? toRow(rows[0]) : null;
}

export async function getByUserCode(userCode: string): Promise<PairingRequestRow | null> {
  const sql = getDb();
  const rows = (await sql.query(
    `SELECT * FROM pairing_requests WHERE user_code = $1`,
    [userCode]
  )) as PairingRequestDbRow[];
  return rows.length === 1 ? toRow(rows[0]) : null;
}

/**
 * Atomically flips pending -> approved, but only while the request is still
 * pending and not expired. Sets sub/refreshJti/approvedAt in the same statement
 * so there is no read-then-write window for a race between two approvers or an
 * approval racing expiry.
 */
export async function approvePairingRequest(
  userCode: string,
  sub: string,
  refreshJti: string
): Promise<PairingRequestRow | null> {
  const sql = getDb();
  const rows = (await sql.query(
    `UPDATE pairing_requests
     SET status = 'approved', sub = $2, refresh_jti = $3, approved_at = NOW()
     WHERE user_code = $1 AND status = 'pending' AND expires_at > NOW()
     RETURNING *`,
    [userCode, sub, refreshJti]
  )) as PairingRequestDbRow[];
  return rows.length === 1 ? toRow(rows[0]) : null;
}

/**
 * Atomically flips pending -> denied.
 */
export async function denyPairingRequest(userCode: string): Promise<boolean> {
  const sql = getDb();
  const rows = (await sql.query(
    `UPDATE pairing_requests
     SET status = 'denied'
     WHERE user_code = $1 AND status = 'pending'
     RETURNING device_code`,
    [userCode]
  )) as { device_code: string }[];
  return rows.length === 1;
}

/**
 * Atomically flips approved -> consumed exactly once. The single UPDATE ...
 * WHERE status = 'approved' ... RETURNING * guarantees only the first caller
 * to hit this transition observes a non-null row (carrying sub/bridgeId/
 * refreshJti for token issuance); every subsequent poll sees no matching row.
 */
export async function consumePairingRequest(deviceCode: string): Promise<PairingRequestRow | null> {
  const sql = getDb();
  const rows = (await sql.query(
    `UPDATE pairing_requests
     SET status = 'consumed'
     WHERE device_code = $1 AND status = 'approved'
     RETURNING *`,
    [deviceCode]
  )) as PairingRequestDbRow[];
  return rows.length === 1 ? toRow(rows[0]) : null;
}

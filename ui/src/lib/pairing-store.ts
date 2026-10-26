import { getDb } from "@/lib/db";
import type { AccountEnrollmentBundle, AccountEnrollmentRequest, AccountHead } from '@security/account-protocol';

/**
 * Legacy store for `pairing_requests`; pending-v1 uses an atomic multi-table store.
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
  enrollment: AccountEnrollmentRequest | null;
  accountApproval: AccountEnrollmentBundle | null;
  pendingV1?: boolean;
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
  enrollment: AccountEnrollmentRequest | null;
  account_approval: AccountEnrollmentBundle | null;
  pending_v1?: boolean;
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
    enrollment: r.enrollment ?? null,
    accountApproval: r.account_approval ?? null,
    pendingV1: r.pending_v1 ?? false,
  };
}

export async function createPairingRequest(r: {
  deviceCode: string;
  userCode: string;
  bridgeId: string;
  hostname: string | null;
  platform: string | null;
  expiresAtIso: string;
  enrollment?: AccountEnrollmentRequest;
}): Promise<void> {
  const sql = getDb();
  await sql.query(
    `INSERT INTO pairing_requests (device_code, user_code, bridge_id, hostname, platform, status, expires_at, enrollment)
     VALUES ($1, $2, $3, $4, $5, 'pending', $6, $7::jsonb)`,
    [r.deviceCode, r.userCode, r.bridgeId, r.hostname, r.platform, r.expiresAtIso, r.enrollment ? JSON.stringify(r.enrollment) : null]
  );
}

/**
 * Row hygiene (MED-3): opportunistically purge long-dead requests. Deletes rows
 * whose TTL lapsed more than an hour ago so the table stays bounded without a
 * cron. Called best-effort from /pair/start.
 */
export async function deleteExpiredRequests(): Promise<void> {
  const sql = getDb();
  await sql.query(
    `DELETE FROM pairing_requests WHERE device_code IN
      (SELECT device_code FROM pairing_requests WHERE expires_at < now() - interval '1 hour' ORDER BY expires_at LIMIT 1000)`
  );
}

export async function getByDeviceCode(deviceCode: string): Promise<PairingRequestRow | null> {
  const sql = getDb();
  const rows = (await sql.query(
    `SELECT p.*, EXISTS(SELECT 1 FROM security_pending_approvals a WHERE a.pair_device_code=p.device_code) AS pending_v1 FROM pairing_requests p WHERE device_code = $1`,
    [deviceCode]
  )) as PairingRequestDbRow[];
  return rows.length === 1 ? toRow(rows[0]) : null;
}

export async function getByUserCode(userCode: string): Promise<PairingRequestRow | null> {
  const sql = getDb();
  const rows = (await sql.query(
    `SELECT p.*, EXISTS(SELECT 1 FROM security_pending_approvals a WHERE a.pair_device_code=p.device_code) AS pending_v1 FROM pairing_requests p WHERE user_code = $1`,
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
  refreshJti: string,
  account?: PairingAccountBinding,
): Promise<PairingRequestRow | null> {
  const sql = getDb();
  if (account) {
    const rows = (await sql.query(`UPDATE pairing_requests p
      SET status='approved',sub=$2,refresh_jti=COALESCE(refresh_jti,$3),approved_at=COALESCE(approved_at,NOW()),account_approval=$4::jsonb
      WHERE user_code=$1 AND expires_at>NOW() AND enrollment=$5::jsonb
      AND NOT EXISTS(SELECT 1 FROM security_pending_approvals a WHERE a.pair_device_code=p.device_code)
      AND (status='pending' OR (status='approved' AND sub=$2 AND account_approval->'approver'=$4::jsonb->'approver'))
      AND EXISTS(SELECT 1 FROM security_account_history h WHERE h.owner_id=$6 AND h.root_id=$7 AND h.revision=$8 AND h.head=$9)
      RETURNING p.*`, [userCode, sub, refreshJti, JSON.stringify(account.bundle), JSON.stringify(account.enrollment), account.ownerId, account.head.rootId, account.head.revision, account.head.head])) as PairingRequestDbRow[];
    return rows.length === 1 ? toRow(rows[0]) : null;
  }
  const rows = (await sql.query(
    `UPDATE pairing_requests
     SET status = 'approved', sub = $2, refresh_jti = $3, approved_at = NOW()
     WHERE user_code = $1 AND status = 'pending' AND expires_at > NOW()
     AND NOT EXISTS(SELECT 1 FROM security_pending_approvals a WHERE a.pair_device_code=pairing_requests.device_code) AND enrollment IS NULL
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
     WHERE user_code = $1 AND status = 'pending' AND expires_at > NOW()
     AND NOT EXISTS(SELECT 1 FROM security_pending_approvals a WHERE a.pair_device_code=pairing_requests.device_code)
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
export interface PairingAccountBinding { ownerId: string; head: AccountHead; enrollment: AccountEnrollmentRequest; bundle: AccountEnrollmentBundle }
export async function consumePairingRequest(deviceCode: string, account?: PairingAccountBinding): Promise<PairingRequestRow | null> {
  const sql = getDb();
  if (account) {
    const rows = (await sql.query(`UPDATE pairing_requests p SET status='consumed'
      WHERE device_code=$1 AND status='approved' AND expires_at>NOW()
      AND NOT EXISTS(SELECT 1 FROM security_pending_approvals a WHERE a.pair_device_code=p.device_code) AND enrollment=$2::jsonb AND account_approval=$3::jsonb
      AND EXISTS(SELECT 1 FROM security_account_history h WHERE h.owner_id=$4 AND h.root_id=$5 AND h.revision=$6 AND h.head=$7)
      RETURNING p.*`, [deviceCode, JSON.stringify(account.enrollment), JSON.stringify(account.bundle), account.ownerId, account.head.rootId, account.head.revision, account.head.head])) as PairingRequestDbRow[];
    return rows.length === 1 ? toRow(rows[0]) : null;
  }
  const rows = (await sql.query(
    `UPDATE pairing_requests
     SET status = 'consumed'
     WHERE device_code = $1 AND status = 'approved' AND expires_at > NOW()
     AND NOT EXISTS(SELECT 1 FROM security_pending_approvals a WHERE a.pair_device_code=pairing_requests.device_code) AND enrollment IS NULL
     RETURNING *`,
    [deviceCode]
  )) as PairingRequestDbRow[];
  return rows.length === 1 ? toRow(rows[0]) : null;
}

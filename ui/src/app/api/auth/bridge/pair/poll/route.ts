import { PendingApprovalStore } from '@/lib/pending-approval-store';
import { ACCOUNT_HEADERS } from '@/app/api/security/account/_shared';
import { NextRequest, NextResponse } from "next/server";
import jwt from "jsonwebtoken";

import { parseLocalAdvert } from "../../local-advert";
import { getByDeviceCode, consumePairingRequest } from "@/lib/pairing-store";
import { upsertBridgeRefresh, getOwnerIdForSub } from "@/lib/bridge-refresh";
import { getRequiredSecret } from "@/lib/secrets";
import { checkRateLimit, recordAttempt, type RateLimitConfig } from "@/lib/login-rate-limit";
import { boundedSecurityJson } from '@/lib/security-store';
import { AccountTrustStore } from '@/lib/account-trust-store';
import { accountError } from '@/app/api/security/account/_shared';
import { AccountTrustError } from '@security/account-crypto';
import type { AccountEnrollmentBundle, AccountHistory } from '@security/account-protocol';
import type { PairingAccountBinding } from '@/lib/pairing-store';

export const runtime = "nodejs";

interface PairPollRequestBody {
  deviceCode: string;
  /** Loopback WS rung advert (optional; absent on old bridges). */
  localPort?: unknown;
  localNonce?: unknown;
}

type PairPollStatus =
  | "pending"
  | "approved"
  | "denied"
  | "expired"
  | "consumed"
  | "unknown"
  | "slow_down";

interface PairPollResponse {
  status: PairPollStatus;
  token?: string;
  refreshToken?: string;
  centrifugoUrl?: string;
  userId?: string;
  ownerId?: string;
  accountApproval?: AccountEnrollmentBundle;
  accountHistory?: AccountHistory;
}

const PAIR_POLL_RATE_LIMIT: RateLimitConfig = {
  maxAttempts: 200,
  lockoutMs: 10 * 60 * 1000, // 10 minutes
};

const PAIR_POLL_SCOPE = "pair-poll";

export async function POST(request: NextRequest): Promise<NextResponse> {
  let body: PairPollRequestBody;
  try {
    body = (await boundedSecurityJson(request, 2048)) as PairPollRequestBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!body || Object.keys(body).some(key => !['deviceCode', 'localPort', 'localNonce'].includes(key)) || typeof body.deviceCode !== "string" || body.deviceCode.length === 0 || body.deviceCode.length > 200) {
    return NextResponse.json({ error: "deviceCode is required" }, { status: 400 });
  }

  const advert = parseLocalAdvert(body);
  if (advert && 'error' in advert) return NextResponse.json({ error: advert.error }, { status: 400 });

  const rateLimit = await checkRateLimit(PAIR_POLL_SCOPE, body.deviceCode);
  if (!rateLimit.allowed) {
    return NextResponse.json({ error: "Polling too frequently. Try again later." }, { status: 429 });
  }
  await recordAttempt(PAIR_POLL_SCOPE, body.deviceCode, PAIR_POLL_RATE_LIMIT);

  const row = await getByDeviceCode(body.deviceCode);
  if (!row) {
    return NextResponse.json({ status: "unknown" } satisfies PairPollResponse);
  }

  if (row.pendingV1) {
    if (!advert || !('localPort' in advert)) return NextResponse.json({ error: 'localPort is required' }, { status: 400, headers: ACCOUNT_HEADERS });
    try {
      const secret = getRequiredSecret('CENTRIFUGO_TOKEN_SECRET');
      const centrifugoUrl = process.env.NEXT_PUBLIC_CENTRIFUGO_URL;
      if (!centrifugoUrl) return NextResponse.json({ error: 'Server misconfiguration' }, { status: 500, headers: ACCOUNT_HEADERS });
      const delivery = await new PendingApprovalStore().deliver(body.deviceCode, advert.localPort);
      if ('status' in delivery) return NextResponse.json(delivery, { headers: ACCOUNT_HEADERS });
      const { snapshot } = delivery;
      return NextResponse.json({ status: 'approved', ownerId: snapshot.ownerId,
        token: jwt.sign(snapshot.connection, secret, { algorithm: 'HS256' }),
        refreshToken: jwt.sign(snapshot.refresh, secret, { algorithm: 'HS256' }),
        centrifugoUrl,
        userId: snapshot.sub, pendingApproval: delivery.state.result }, { headers: ACCOUNT_HEADERS });
    } catch (error) { return accountError(error); }
  }

  if (row.status === "denied") {
    return NextResponse.json({ status: "denied" } satisfies PairPollResponse);
  }

  if (row.status === "consumed") {
    return NextResponse.json({ status: "consumed" } satisfies PairPollResponse);
  }

  if (!Number.isFinite(Date.parse(row.expiresAt)) || Date.parse(row.expiresAt) <= Date.now()) return NextResponse.json({ status: 'expired' } satisfies PairPollResponse);

  if (row.status === "pending") {
    if (new Date(row.expiresAt).getTime() < Date.now()) {
      return NextResponse.json({ status: "expired" } satisfies PairPollResponse);
    }
    return NextResponse.json({ status: "pending" } satisfies PairPollResponse);
  }

  // Validate credentials, fresh bindings and current signed membership BEFORE the one-use transition.
  if (!row.sub || !row.refreshJti) return NextResponse.json({ status: 'denied' } satisfies PairPollResponse);
  let secret: string;
  try { secret = getRequiredSecret('CENTRIFUGO_TOKEN_SECRET'); }
  catch { return NextResponse.json({ error: 'Server misconfiguration' }, { status: 500 }); }
  let ownerId: string;
  try { ownerId = await getOwnerIdForSub(row.sub); }
  catch { return NextResponse.json({ error: 'Bridge account is unavailable' }, { status: 401 }); }
  let account: PairingAccountBinding | undefined;
  let accountHistory: AccountHistory | undefined;
  if (row.enrollment) {
    try {
      if (row.enrollment.kind !== 'bridge' || row.enrollment.bridgeId !== row.bridgeId || !row.accountApproval) throw new AccountTrustError('account_enrollment_invalid');
      const verified = await new AccountTrustStore().validateApproval(ownerId, row.enrollment, row.accountApproval, true);
      account = { ownerId, head: verified.head, enrollment: verified.request, bundle: verified.bundle };
      accountHistory = verified.history;
    } catch (error) { return accountError(error); }
  } else if (row.accountApproval) return NextResponse.json({ error: 'Invalid account pairing' }, { status: 400 });
  const consumed = account ? await consumePairingRequest(body.deviceCode, account) : await consumePairingRequest(body.deviceCode);
  if (!consumed) {
    if (account) return accountError(new AccountTrustError('account_trust_conflict'));
    // Raced with another poll that already consumed this request.
    return NextResponse.json({ status: "consumed" } satisfies PairPollResponse);
  }

  if (!consumed.sub || !consumed.refreshJti) {
    // Should not happen: approve() always sets both alongside status='approved'.
    return NextResponse.json({ status: "consumed" } satisfies PairPollResponse);
  }

  // HIGH-1 defense in depth: the owner-scoped upsert is a no-op (returns false)
  // if this bridgeId is already owned by a different sub. In that case do NOT
  // issue credentials for a bridge that belongs to someone else; the bridge
  // treats `denied` as a hard stop.
  const upserted = await upsertBridgeRefresh({
    bridgeId: consumed.bridgeId,
    sub: consumed.sub,
    jti: consumed.refreshJti,
    hostname: consumed.hostname,
  });
  if (!upserted) {
    return NextResponse.json({ status: "denied" } satisfies PairPollResponse);
  }

  const token = jwt.sign(
    {
      sub: consumed.sub,
      info: {
        bridgeId: consumed.bridgeId,
        ownerId,
        hostname: consumed.hostname,
        connectedAt: new Date().toISOString(),
        ...(advert ?? {}),
      },
    },
    secret,
    { audience: "ftown:centrifugo", expiresIn: "24h" },
  );

  // HIGH-2: the refresh token claim set MUST match /api/auth/bridge exactly
  // ({ sub, bridgeId, type: 'bridge_refresh', jti }); the refresh route REQUIRES
  // type + bridgeId, so omitting them 401s every paired bridge's first refresh.
  const refreshToken = jwt.sign(
    {
      sub: consumed.sub,
      bridgeId: consumed.bridgeId,
      type: "bridge_refresh",
      jti: consumed.refreshJti,
      ownerId,
    },
    secret,
    { audience: "ftown:bridge-refresh", expiresIn: "30d" },
  );

  return NextResponse.json({
    status: "approved",
    token,
    refreshToken,
    centrifugoUrl: process.env.NEXT_PUBLIC_CENTRIFUGO_URL,
    userId: consumed.sub,
    ownerId,
    ...(account ? { accountApproval: account.bundle, accountHistory } : {}),
  } satisfies PairPollResponse);
}

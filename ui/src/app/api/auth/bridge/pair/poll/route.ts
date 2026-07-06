import { NextRequest, NextResponse } from "next/server";
import jwt from "jsonwebtoken";

import { getByDeviceCode, consumePairingRequest } from "@/lib/pairing-store";
import { upsertBridgeRefresh } from "@/lib/bridge-refresh";
import { getRequiredSecret } from "@/lib/secrets";
import { checkRateLimit, recordAttempt, type RateLimitConfig } from "@/lib/login-rate-limit";

export const runtime = "nodejs";

interface PairPollRequestBody {
  deviceCode: string;
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
}

const PAIR_POLL_RATE_LIMIT: RateLimitConfig = {
  maxAttempts: 200,
  lockoutMs: 10 * 60 * 1000, // 10 minutes
};

const PAIR_POLL_SCOPE = "pair-poll";

export async function POST(request: NextRequest): Promise<NextResponse> {
  let body: PairPollRequestBody;
  try {
    body = (await request.json()) as PairPollRequestBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!body || typeof body.deviceCode !== "string" || body.deviceCode.length === 0) {
    return NextResponse.json({ error: "deviceCode is required" }, { status: 400 });
  }

  const rateLimit = await checkRateLimit(PAIR_POLL_SCOPE, body.deviceCode);
  if (!rateLimit.allowed) {
    return NextResponse.json({ error: "Polling too frequently. Try again later." }, { status: 429 });
  }
  await recordAttempt(PAIR_POLL_SCOPE, body.deviceCode, PAIR_POLL_RATE_LIMIT);

  const row = await getByDeviceCode(body.deviceCode);
  if (!row) {
    return NextResponse.json({ status: "unknown" } satisfies PairPollResponse);
  }

  if (row.status === "denied") {
    return NextResponse.json({ status: "denied" } satisfies PairPollResponse);
  }

  if (row.status === "consumed") {
    return NextResponse.json({ status: "consumed" } satisfies PairPollResponse);
  }

  if (row.status === "pending") {
    if (new Date(row.expiresAt).getTime() < Date.now()) {
      return NextResponse.json({ status: "expired" } satisfies PairPollResponse);
    }
    return NextResponse.json({ status: "pending" } satisfies PairPollResponse);
  }

  // row.status === "approved"
  const consumed = await consumePairingRequest(body.deviceCode);
  if (!consumed) {
    // Raced with another poll that already consumed this request.
    return NextResponse.json({ status: "consumed" } satisfies PairPollResponse);
  }

  if (!consumed.sub || !consumed.refreshJti) {
    // Should not happen: approve() always sets both alongside status='approved'.
    return NextResponse.json({ status: "consumed" } satisfies PairPollResponse);
  }

  let secret: string;
  try {
    secret = getRequiredSecret("CENTRIFUGO_TOKEN_SECRET");
  } catch (err) {
    console.error(
      "[auth/bridge/pair/poll] secret misconfiguration:",
      err instanceof Error ? err.message : String(err),
    );
    return NextResponse.json({ error: "Server misconfiguration" }, { status: 500 });
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

  const token = jwt.sign({ sub: consumed.sub }, secret, {
    audience: "ftown:centrifugo",
    expiresIn: "24h",
  });

  // HIGH-2: the refresh token claim set MUST match /api/auth/bridge exactly
  // ({ sub, bridgeId, type: 'bridge_refresh', jti }); the refresh route REQUIRES
  // type + bridgeId, so omitting them 401s every paired bridge's first refresh.
  const refreshToken = jwt.sign(
    {
      sub: consumed.sub,
      bridgeId: consumed.bridgeId,
      type: "bridge_refresh",
      jti: consumed.refreshJti,
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
  } satisfies PairPollResponse);
}

import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "node:crypto";

import { auth } from "@/lib/auth";
import { approvePairingRequest, getByUserCode } from "@/lib/pairing-store";
import { getBridgeRefreshOwner } from "@/lib/bridge-refresh";
import { checkRateLimit, recordAttempt, type RateLimitConfig } from "@/lib/login-rate-limit";

export const runtime = "nodejs";

interface PairApproveRequestBody {
  userCode: string;
}

const PAIR_APPROVE_RATE_LIMIT: RateLimitConfig = {
  maxAttempts: 30,
  lockoutMs: 10 * 60 * 1000, // 10 minutes
};

const PAIR_APPROVE_SCOPE = "pair-approve";

export async function POST(request: NextRequest): Promise<NextResponse> {
  const session = await auth();
  const email = session?.user?.email;
  if (!email) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // MED-4: throttle userCode brute-forcing by a logged-in attacker.
  const rateLimit = await checkRateLimit(PAIR_APPROVE_SCOPE, email);
  if (!rateLimit.allowed) {
    return NextResponse.json(
      { error: "Too many approval attempts. Try again later." },
      { status: 429 }
    );
  }
  await recordAttempt(PAIR_APPROVE_SCOPE, email, PAIR_APPROVE_RATE_LIMIT);

  let body: PairApproveRequestBody;
  try {
    body = (await request.json()) as PairApproveRequestBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!body || typeof body.userCode !== "string" || body.userCode.length === 0) {
    return NextResponse.json({ error: "userCode is required" }, { status: 400 });
  }

  // HIGH-1: cross-account bridge takeover pre-check. Resolve the pending request
  // to read its bridgeId, then reject if that bridge is already owned by a
  // DIFFERENT account. The owner-scoped upsert in poll is the defense-in-depth
  // backstop; this gives the approver a clear 409 instead of a silent failure.
  const pending = await getByUserCode(body.userCode);
  if (pending) {
    const owner = await getBridgeRefreshOwner(pending.bridgeId);
    if (owner !== null && owner !== email) {
      return NextResponse.json(
        { error: "This bridge is registered to another account." },
        { status: 409 }
      );
    }
  }

  const refreshJti = randomUUID();
  const approved = await approvePairingRequest(body.userCode, email, refreshJti);
  if (!approved) {
    return NextResponse.json(
      { error: "Code not found, expired, or already handled." },
      { status: 400 }
    );
  }

  return NextResponse.json({ ok: true });
}

import { NextRequest, NextResponse } from "next/server";

import { auth } from "@/lib/auth";
import { denyPairingRequest } from "@/lib/pairing-store";
import { checkRateLimit, recordAttempt, type RateLimitConfig } from "@/lib/login-rate-limit";

export const runtime = "nodejs";

interface PairDenyRequestBody {
  userCode: string;
}

const PAIR_DENY_RATE_LIMIT: RateLimitConfig = {
  maxAttempts: 30,
  lockoutMs: 10 * 60 * 1000, // 10 minutes
};

const PAIR_DENY_SCOPE = "pair-deny";

export async function POST(request: NextRequest): Promise<NextResponse> {
  const session = await auth();
  const email = session?.user?.email;
  if (!email) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // MED-4: throttle userCode brute-forcing by a logged-in attacker.
  const rateLimit = await checkRateLimit(PAIR_DENY_SCOPE, email);
  if (!rateLimit.allowed) {
    return NextResponse.json(
      { error: "Too many attempts. Try again later." },
      { status: 429 }
    );
  }
  await recordAttempt(PAIR_DENY_SCOPE, email, PAIR_DENY_RATE_LIMIT);

  let body: PairDenyRequestBody;
  try {
    body = (await request.json()) as PairDenyRequestBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!body || typeof body.userCode !== "string" || body.userCode.length === 0) {
    return NextResponse.json({ error: "userCode is required" }, { status: 400 });
  }

  await denyPairingRequest(body.userCode);

  return NextResponse.json({ ok: true });
}

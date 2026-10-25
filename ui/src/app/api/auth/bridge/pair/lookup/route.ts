import { NextRequest, NextResponse } from "next/server";

import { auth } from "@/lib/auth";
import { getByUserCode } from "@/lib/pairing-store";
import { checkRateLimit, recordAttempt, type RateLimitConfig } from "@/lib/login-rate-limit";
import { isTrustedBrowserOrigin } from '@/lib/request-origin';
import { boundedSecurityJson } from '@/lib/security-store';
import { parseAccountEnrollmentRequest } from '@security/account-crypto';

export const runtime = "nodejs";

interface PairLookupRequestBody {
  userCode: string;
}

const NOT_FOUND_RESPONSE = { error: "That code is invalid or expired." } as const;

const PAIR_LOOKUP_RATE_LIMIT: RateLimitConfig = {
  maxAttempts: 30,
  lockoutMs: 10 * 60 * 1000, // 10 minutes
};

const PAIR_LOOKUP_SCOPE = "pair-lookup";

export async function POST(request: NextRequest): Promise<NextResponse> {
  const session = await auth();
  const email = session?.user?.email;
  if (!email) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!isTrustedBrowserOrigin(request)) return NextResponse.json({ error: 'forbidden_origin' }, { status: 403 });

  // MED-4: throttle userCode brute-forcing by a logged-in attacker.
  const rateLimit = await checkRateLimit(PAIR_LOOKUP_SCOPE, email);
  if (!rateLimit.allowed) {
    return NextResponse.json(
      { error: "Too many attempts. Try again later." },
      { status: 429 }
    );
  }
  await recordAttempt(PAIR_LOOKUP_SCOPE, email, PAIR_LOOKUP_RATE_LIMIT);

  let body: PairLookupRequestBody;
  try {
    body = (await boundedSecurityJson(request, 1024)) as PairLookupRequestBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!body || Object.keys(body).length !== 1 || typeof body.userCode !== "string" || !/^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(body.userCode)) {
    return NextResponse.json({ error: "userCode is required" }, { status: 400 });
  }

  const row = await getByUserCode(body.userCode);
  if (!row || !['pending', 'approved'].includes(row.status) || new Date(row.expiresAt).getTime() <= Date.now()) {
    return NextResponse.json(NOT_FOUND_RESPONSE, { status: 404 });
  }

  let enrollment = null;
  try { if (row.enrollment) enrollment = await parseAccountEnrollmentRequest(row.enrollment); }
  catch { return NextResponse.json(NOT_FOUND_RESPONSE, { status: 404 }); }

  return NextResponse.json({
    bridgeId: row.bridgeId,
    hostname: row.hostname,
    platform: row.platform,
    createdAt: row.createdAt,
    enrollment,
  });
}

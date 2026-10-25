import { NextRequest, NextResponse } from "next/server";

import { genDeviceCode, genUserCode, PAIR_REQUEST_TTL_MS, PAIR_POLL_INTERVAL_MS } from "@/lib/pairing";
import { createPairingRequest, deleteExpiredRequests } from "@/lib/pairing-store";
import { checkRateLimit, recordAttempt, type RateLimitConfig } from "@/lib/login-rate-limit";
import { clientIp } from "@/lib/client-ip";
import { boundedSecurityJson } from '@/lib/security-store';
import { parseAccountEnrollmentRequest } from '@security/account-crypto';
import type { AccountEnrollmentRequest } from '@security/account-protocol';

export const runtime = "nodejs";

interface PairStartRequestBody {
  bridgeId: string;
  hostname?: string;
  platform?: string;
  enrollment?: unknown;
}

const PAIR_START_RATE_LIMIT: RateLimitConfig = {
  maxAttempts: 20,
  lockoutMs: 60 * 60 * 1000, // 1 hour
};

const PAIR_START_SCOPE = "pair-start";

/** Unique-constraint violation on user_code (or any other column) from pg. */
function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: unknown }).code === "23505"
  );
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  let body: PairStartRequestBody;
  try {
    body = (await boundedSecurityJson(request, 8192)) as PairStartRequestBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !['bridgeId', 'hostname', 'platform', 'enrollment'].includes(key))
    || typeof body.bridgeId !== "string" || !/^[A-Za-z0-9_-]{1,200}$/.test(body.bridgeId)
    || (body.hostname !== undefined && (typeof body.hostname !== 'string' || body.hostname.length > 200 || /[\x00-\x1f\x7f]/.test(body.hostname)))
    || (body.platform !== undefined && (typeof body.platform !== 'string' || body.platform.length > 100 || /[\x00-\x1f\x7f]/.test(body.platform)))) {
    return NextResponse.json({ error: "bridgeId is required" }, { status: 400 });
  }

  let enrollment: AccountEnrollmentRequest | undefined;
  if (body.enrollment !== undefined) {
    try {
      enrollment = await parseAccountEnrollmentRequest(body.enrollment);
      if (enrollment.kind !== 'bridge' || enrollment.bridgeId !== body.bridgeId) throw new Error('invalid enrollment');
    } catch { return NextResponse.json({ error: 'Invalid account enrollment' }, { status: 400 }); }
  }

  const ip = clientIp(request);
  const rateLimit = await checkRateLimit(PAIR_START_SCOPE, ip);
  if (!rateLimit.allowed) {
    return NextResponse.json(
      { error: "Too many pairing attempts. Try again later." },
      { status: 429 }
    );
  }
  await recordAttempt(PAIR_START_SCOPE, ip, PAIR_START_RATE_LIMIT);

  // MED-3: best-effort row hygiene. A cleanup failure must never fail the
  // pairing request itself.
  try {
    await deleteExpiredRequests();
  } catch (err) {
    console.error(
      "[auth/bridge/pair/start] expired-request cleanup failed:",
      err instanceof Error ? err.message : String(err),
    );
  }

  const hostname = typeof body.hostname === "string" ? body.hostname : null;
  const platform = typeof body.platform === "string" ? body.platform : null;
  const deviceCode = genDeviceCode();
  const expiresAtIso = enrollment?.expiresAt ?? new Date(Date.now() + PAIR_REQUEST_TTL_MS).toISOString();

  let userCode = genUserCode();
  let created = false;
  const MAX_TRIES = 5;
  for (let attempt = 0; attempt < MAX_TRIES; attempt++) {
    try {
      await createPairingRequest({
        deviceCode,
        userCode,
        bridgeId: body.bridgeId,
        hostname,
        platform,
        expiresAtIso,
        ...(enrollment ? { enrollment } : {}),
      });
      created = true;
      break;
    } catch (err) {
      if (isUniqueViolation(err) && attempt < MAX_TRIES - 1) {
        userCode = genUserCode();
        continue;
      }
      throw err;
    }
  }

  if (!created) {
    return NextResponse.json(
      { error: "Could not allocate a pairing code. Try again." },
      { status: 500 }
    );
  }

  return NextResponse.json({
    deviceCode,
    userCode,
    verificationUri: `${new URL(request.url).origin}/pair?code=${userCode}`,
    intervalMs: PAIR_POLL_INTERVAL_MS,
    expiresInMs: Math.max(0, Date.parse(expiresAtIso) - Date.now()),
  });
}

import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "node:crypto";

import { auth } from "@/lib/auth";
import { approvePairingRequest, getByUserCode } from "@/lib/pairing-store";
import { getBridgeRefreshOwner } from "@/lib/bridge-refresh";
import { checkRateLimit, recordAttempt, type RateLimitConfig } from "@/lib/login-rate-limit";
import { isTrustedBrowserOrigin } from '@/lib/request-origin';
import { boundedSecurityJson } from '@/lib/security-store';
import { AccountTrustStore } from '@/lib/account-trust-store';
import { accountError } from '@/app/api/security/account/_shared';

export const runtime = "nodejs";

interface PairApproveRequestBody {
  userCode: string;
  accountApproval?: unknown;
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
  if (!isTrustedBrowserOrigin(request)) return NextResponse.json({ error: 'forbidden_origin' }, { status: 403 });

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
    body = (await boundedSecurityJson(request, 458192)) as PairApproveRequestBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!body || Object.keys(body).some(key => !['userCode', 'accountApproval'].includes(key)) || typeof body.userCode !== "string" || !/^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(body.userCode)) {
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
  if (pending?.enrollment) {
    if (!session?.user?.id || body.accountApproval === undefined || pending.enrollment.kind !== 'bridge' || pending.enrollment.bridgeId !== pending.bridgeId) {
      return NextResponse.json({ error: 'Account approval is required' }, { status: 400 });
    }
    try {
      const verified = await new AccountTrustStore().validateApproval(session.user.id, pending.enrollment, body.accountApproval);
      const approved = await approvePairingRequest(body.userCode, email, refreshJti, { ownerId: session.user.id, head: verified.head, enrollment: verified.request, bundle: verified.bundle });
      if (!approved) return NextResponse.json({ error: { code: 'account_trust_conflict', message: 'Pairing changed or expired. Refresh and try again.', retryable: true } }, { status: 409 });
      return NextResponse.json({ ok: true });
    } catch (error) { return accountError(error); }
  }
  if (body.accountApproval !== undefined) return NextResponse.json({ error: 'Account approval does not match this request' }, { status: 400 });
  const approved = await approvePairingRequest(body.userCode, email, refreshJti);
  if (!approved) {
    return NextResponse.json(
      { error: "Code not found, expired, or already handled." },
      { status: 400 }
    );
  }

  return NextResponse.json({ ok: true });
}

import { NextResponse } from 'next/server';
import { readBoundedJson, BoundedJsonError } from '@/lib/bounded-json';
import { clientIp } from '@/lib/client-ip';
import { requireAccount } from '@/lib/ledger-auth';
import { consumeRateLimit, type RateLimitConfig } from '@/lib/login-rate-limit';
import { putPairApproval, takePairApproval } from '@/lib/pair-mailbox-store';

export const runtime = 'nodejs';
const headers = { 'Cache-Control': 'no-store' };
const PAIR_READ_RATE_LIMIT: RateLimitConfig = { maxAttempts: 200, lockoutMs: 10 * 60 * 1000 };
const PAIR_READ_IP_RATE_LIMIT: RateLimitConfig = { maxAttempts: 120, lockoutMs: 60 * 1000 };
const PAIR_WRITE_RATE_LIMIT: RateLimitConfig = { maxAttempts: 30, lockoutMs: 10 * 60 * 1000 };
const PAIR_BODY_MAX_BYTES = 300 * 1024;

type Context = { params: Promise<{ requestId: string }> };

/** A request id is 32 random bytes in base64url, exactly 43 characters. Checked before any limiter or storage work. */
function validRequestIdShape(requestId: string): boolean {
  return /^[A-Za-z0-9_-]{43}$/.test(requestId);
}

export async function PUT(request: Request, context: Context): Promise<NextResponse> {
  let accountId: string;
  try {
    accountId = (await requireAccount()).accountId;
  } catch {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401, headers });
  }
  const requestId = (await context.params).requestId;
  if (!validRequestIdShape(requestId)) return NextResponse.json({ error: 'invalid_request' }, { status: 400, headers });
  try {
    const writeLimit = await consumeRateLimit('pair-write', accountId, PAIR_WRITE_RATE_LIMIT);
    if (!writeLimit.allowed) {
      return NextResponse.json({ error: 'rate_limited' }, { status: 429, headers: { ...headers, 'Retry-After': String(Math.ceil((writeLimit.retryAfterMs ?? 600000) / 1000)) } });
    }
    const body = await readBoundedJson(request, PAIR_BODY_MAX_BYTES);
    const sealed = typeof body === 'object' && body !== null ? (body as { sealed?: unknown }).sealed : undefined;
    if (typeof sealed !== 'string') return NextResponse.json({ error: 'invalid_request' }, { status: 400, headers });
    await putPairApproval(requestId, accountId, sealed);
    return new NextResponse(null, { status: 204, headers });
  } catch (error) {
    if (error instanceof BoundedJsonError) {
      return NextResponse.json({ error: error.status === 413 ? 'too_large' : 'invalid_request' }, { status: error.status, headers });
    }
    const code = error instanceof Error ? error.message : '';
    if (code === 'invalid_request_id') return NextResponse.json({ error: 'invalid_request' }, { status: 400, headers });
    if (code === 'pair_mailbox_too_large') return NextResponse.json({ error: 'too_large' }, { status: 413, headers });
    if (code === 'pair_mailbox_full') return NextResponse.json({ error: 'pair_mailbox_full' }, { status: 429, headers });
    if (code === 'pair_mailbox_conflict') return NextResponse.json({ error: 'conflict' }, { status: 409, headers });
    return NextResponse.json({ error: 'unavailable' }, { status: 503, headers });
  }
}

export async function GET(request: Request, context: Context): Promise<NextResponse> {
  try {
    const requestId = (await context.params).requestId;
    if (!validRequestIdShape(requestId)) return NextResponse.json({ error: 'invalid_request' }, { status: 400, headers });
    const ipLimit = await consumeRateLimit('pair-read-ip', clientIp(request), PAIR_READ_IP_RATE_LIMIT);
    if (!ipLimit.allowed) {
      return NextResponse.json({ error: 'rate_limited' }, { status: 429, headers: { ...headers, 'Retry-After': String(Math.ceil((ipLimit.retryAfterMs ?? 60000) / 1000)) } });
    }
    const limit = await consumeRateLimit('pair-read', requestId, PAIR_READ_RATE_LIMIT);
    if (!limit.allowed) {
      return NextResponse.json({ error: 'rate_limited' }, { status: 429, headers: { ...headers, 'Retry-After': String(Math.ceil((limit.retryAfterMs ?? 60000) / 1000)) } });
    }
    const approval = await takePairApproval(requestId);
    if (approval.status === 'ready') return NextResponse.json({ sealed: approval.sealed }, { status: 200, headers });
    if (approval.status === 'expired') return NextResponse.json({ status: 'expired' }, { status: 410, headers });
    return NextResponse.json({ status: 'pending' }, { status: 404, headers });
  } catch (error) {
    const code = error instanceof Error ? error.message : '';
    if (code === 'invalid_request_id') return NextResponse.json({ error: 'invalid_request' }, { status: 400, headers });
    return NextResponse.json({ error: 'unavailable' }, { status: 503, headers });
  }
}

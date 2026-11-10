import { NextResponse } from 'next/server';
import { rateLimitKeyIp } from '@/lib/client-ip';
import { consumeRateLimit } from '@/lib/login-rate-limit';
import { accountCreateGlobalPerDay, accountCreatePerHour, accountWritesPer10Min } from '@/lib/account-limits';
import { offerLedger, readLedger } from '@/lib/account-ledger-store';
import type { CreationRejection, OfferLimits } from '@/lib/account-ledger-store';
import { LEDGER_BODY_MAX_BYTES } from '@/lib/ledger-limits';
import { BoundedJsonError, readBoundedJson } from '@/lib/bounded-json';
import { afterLedgerResponse, publishLedger } from '@/lib/ledger-publish';

export const runtime = 'nodejs';
const HEADERS = { 'Cache-Control': 'no-store' };
const KEY = /^[A-Za-z0-9_-]{43}$/;
const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
/** Real writes to one existing account (adopt, or keep with new sticky ids). */
const ACCOUNT_WRITES_WINDOW_MS = 10 * MINUTE_MS;
const CREATION_STATUS: Record<CreationRejection, number> = {
  invalid_ledger: 400, registration_closed: 403, creation_too_large: 413, origin_mismatch: 400, server_misconfigured: 503, server_full: 503,
  handle_taken: 409, rate_limited: 429,
};
const json = (body: unknown, status: number, extra: Record<string, string> = {}): NextResponse => NextResponse.json(body, { status, headers: { ...HEADERS, ...extra } });

/** Fixed-window budget of maxAttempts per windowMs for key (default: the client address, IPv6 by /64). Over budget: 429 rate_limited
 *  with Retry-After. */
async function limited(request: Request, scope: string, maxAttempts: number, windowMs = MINUTE_MS, key = rateLimitKeyIp(request)): Promise<NextResponse | null> {
  const result = await consumeRateLimit(scope, key, { maxAttempts, lockoutMs: windowMs });
  if (result.allowed) return null;
  const seconds = Math.ceil((result.retryAfterMs ?? windowMs) / 1000);
  return json({ error: 'rate_limited' }, 429, { 'Retry-After': String(Math.min(windowMs / 1000, Math.max(1, seconds))) });
}

/** The store's limits, consulted only once a chain verified. Creation: per IP first, so a throttled client cannot drain the global
 *  budget; the global key bounds creations when every client shares one key ("unknown"). Existing account: per accountId, only for a
 *  real write. refusal() is the 429 of whichever limiter refused. */
function storeLimits(request: Request): OfferLimits & { refusal: () => NextResponse } {
  let refusal: NextResponse | null = null;
  return {
    admitCreation: async () => {
      refusal = await limited(request, 'account-create-ip', accountCreatePerHour(), HOUR_MS)
        ?? await limited(request, 'account-create-global', accountCreateGlobalPerDay(), DAY_MS, 'global');
      return refusal === null;
    },
    admitAccountWrite: async accountId => {
      refusal = await limited(request, 'ledger-adopt-account', accountWritesPer10Min(), ACCOUNT_WRITES_WINDOW_MS, accountId);
      return refusal === null;
    },
    refusal: () => refusal ?? json({ error: 'rate_limited' }, 429),
  };
}

/** Public by design: the ledger holds only public keys, labels, origins and timestamps, and its ids are unguessable 256-bit values. Rate-limited per IP. */
export async function GET(request: Request): Promise<NextResponse> {
  try {
    const params = new URL(request.url).searchParams;
    const accountId = params.get('accountId');
    const handle = params.get('handle');
    if ((accountId === null) === (handle === null)) return json({ error: 'invalid_request' }, 400);
    const value = accountId ?? handle ?? '';
    if (!KEY.test(value)) return json({ error: 'invalid_request' }, 400);
    const blocked = await limited(request, 'ledger-read', 120);
    if (blocked) return blocked;
    const stored = await readLedger(accountId !== null ? { accountId } : { handle: value });
    if (!stored) return json({ error: 'not_found' }, 404);
    return json({ ledger: stored.ledger }, 200);
  } catch (error) {
    console.error('[ledger] read failed', error);
    return json({ error: 'ledger_unavailable' }, 503);
  }
}

/** Body { ledger }; other members are ignored. Offers the chain to the store: replica rule (and the account's write budget) for an
 *  existing account, genesis admission (open registration, creation budget) for a new one. */
export async function POST(request: Request): Promise<NextResponse> {
  try {
    const blocked = await limited(request, 'ledger-write', 30);
    if (blocked) return blocked;
    let body: unknown;
    try { body = await readBoundedJson(request, LEDGER_BODY_MAX_BYTES); } catch (error) {
      if (error instanceof BoundedJsonError) return json({ error: error.status === 413 ? 'payload_too_large' : 'invalid_request' }, error.status);
      throw error;
    }
    const record = body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : null;
    const ledger = record?.ledger;
    if (ledger === undefined) return json({ error: 'invalid_request' }, 400);
    const limits = storeLimits(request);
    const result = await offerLedger(ledger, { admitCreation: limits.admitCreation, admitAccountWrite: limits.admitAccountWrite });
    if (result.decision === 'reject') {
      if (result.reason === 'rate_limited') return limits.refusal();
      if (result.stored === null) return json({ error: result.reason }, CREATION_STATUS[result.reason]);
      return json({ error: 'ledger_rejected', ledger: result.stored.ledger }, 409);
    }
    const { decision, stored, discarded } = result;
    if (decision === 'created' || decision === 'adopt') {
      const accountId = stored.trusted.accountId;
      afterLedgerResponse(() => publishLedger(accountId, stored.ledger));
    }
    return json({ decision, ledger: stored.ledger, discarded }, decision === 'created' ? 201 : 200);
  } catch (error) {
    console.error('[ledger] write failed', error);
    return json({ error: 'ledger_unavailable' }, 503);
  }
}

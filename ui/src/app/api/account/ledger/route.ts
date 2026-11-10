import { NextResponse } from 'next/server';
import { clientIp } from '@/lib/client-ip';
import { consumeRateLimit } from '@/lib/login-rate-limit';
import { offerLedger, readLedger } from '@/lib/account-ledger-store';
import { LEDGER_BODY_MAX_BYTES } from '@/lib/ledger-limits';
import { BoundedJsonError, readBoundedJson } from '@/lib/bounded-json';
import { afterLedgerResponse, publishLedger } from '@/lib/ledger-publish';

export const runtime = 'nodejs';
const MAX_BOOTSTRAP_LENGTH = 256;
const HEADERS = { 'Cache-Control': 'no-store' };
const KEY = /^[A-Za-z0-9_-]{43}$/;
const json = (body: unknown, status: number, extra: Record<string, string> = {}): NextResponse => NextResponse.json(body, { status, headers: { ...HEADERS, ...extra } });

async function limited(request: Request, scope: string, maxAttempts: number): Promise<NextResponse | null> {
  const result = await consumeRateLimit(scope, clientIp(request), { maxAttempts, lockoutMs: 60_000 });
  if (result.allowed) return null;
  return json({ error: 'rate_limited' }, 429, { 'Retry-After': String(Math.min(60, Math.max(1, Math.ceil((result.retryAfterMs ?? 60_000) / 1000)))) });
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
    const bootstrap = record?.bootstrap;
    if (bootstrap !== undefined && (typeof bootstrap !== 'string' || bootstrap.length > MAX_BOOTSTRAP_LENGTH)) return json({ error: 'invalid_request' }, 400);
    const { decision, stored, discarded } = await (bootstrap === undefined ? offerLedger(ledger) : offerLedger(ledger, { bootstrap }));
    if (decision === 'reject' && !stored) return json({ error: 'registration_closed' }, 403);
    if (decision === 'reject' || !stored) return json({ error: 'ledger_rejected', ledger: stored?.ledger ?? null }, 409);
    if (decision === 'created' || decision === 'adopt') {
      const accountId = stored.checkpoint.accountId;
      afterLedgerResponse(() => publishLedger(accountId, stored.ledger));
    }
    return json({ decision, ledger: stored.ledger, discarded }, decision === 'created' ? 201 : 200);
  } catch (error) {
    console.error('[ledger] write failed', error);
    return json({ error: 'ledger_unavailable' }, 503);
  }
}

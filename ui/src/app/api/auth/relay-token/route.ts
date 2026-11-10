import { NextResponse } from 'next/server';
import { consumeNonce } from '@/lib/auth-nonce-store';
import { readLedger, readTrustedCheckpoint } from '@/lib/account-ledger-store';
import { clientIp } from '@/lib/client-ip';
import { consumeRateLimit, type RateLimitConfig } from '@/lib/login-rate-limit';
import { publicOrigin } from '@/lib/ledger-auth';
import { signRelayToken } from '@/lib/relay-jwt';
import { isValidBridgeLabel } from '@/lib/bridge-label';
import { BoundedJsonError, readBoundedJson } from '@/lib/bounded-json';
import { parseLocalAdvert } from '@/lib/local-advert';
import { parseAuthProof, verifyAuthProof } from '@security/ledger/proof';

export const runtime = 'nodejs';
const headers = { 'Cache-Control': 'no-store' };
const MAX_BODY = 16384;
const IP_LIMIT: RateLimitConfig = { maxAttempts: 120, lockoutMs: 60 * 1000 };
const KEY_LIMIT: RateLimitConfig = { maxAttempts: 30, lockoutMs: 10 * 60 * 1000 };

const fail = (status: number, body: Record<string, unknown>, extra: Record<string, string> = {}) =>
  NextResponse.json(body, { status, headers: { ...headers, ...extra } });
const unauthorized = () => fail(401, { error: 'unauthorized' });

export async function POST(request: Request): Promise<NextResponse> {
  try {
    const ipLimit = await consumeRateLimit('relay-token-ip', clientIp(request), IP_LIMIT);
    if (!ipLimit.allowed) return fail(429, { error: 'rate_limited' }, { 'Retry-After': String(Math.ceil((ipLimit.retryAfterMs ?? 60000) / 1000)) });

    let body: unknown;
    try { body = await readBoundedJson(request, MAX_BODY); } catch (error) { return fail(error instanceof BoundedJsonError ? error.status : 400, { error: 'invalid_request' }); }
    if (typeof body !== 'object' || body === null || Array.isArray(body)) return fail(400, { error: 'invalid_request' });
    const { proof: rawProof, head, hostname, localPort } = body as Record<string, unknown>;
    if (typeof head !== 'string' && head !== null && head !== undefined) return fail(400, { error: 'invalid_request' });

    const proof = parseAuthProof(rawProof);
    if (!proof || proof.purpose !== 'relay') return unauthorized();

    let info: Record<string, unknown> | undefined;
    if (proof.kind === 'bridge') {
      if (hostname !== undefined && !isValidBridgeLabel(hostname)) return fail(400, { error: 'invalid_request' });
      const advert = parseLocalAdvert({ localPort });
      if (advert && 'error' in advert) return fail(400, { error: 'invalid_request' });
      info = { bridgeId: proof.keyId, ownerId: proof.accountId, ...(hostname !== undefined ? { hostname } : {}), connectedAt: new Date().toISOString(), ...(advert ?? {}) };
    }

    // Consume the nonce before any ledger work: replay protection is only this atomic delete.
    if (!(await consumeNonce(proof.nonce, 'relay'))) return unauthorized();
    // The decision uses the persisted trusted checkpoint; the chain itself is read (never re-verified) only when it is sent back.
    const trusted = await readTrustedCheckpoint(proof.accountId);
    if (!trusted) return unauthorized();
    const chain = async () => (await readLedger({ accountId: proof.accountId }))?.ledger ?? null;

    const valid = await verifyAuthProof(trusted, proof, { audience: publicOrigin(), purpose: 'relay' });
    if (!valid) {
      const revoked = trusted.revokedBridgeIds.includes(proof.keyId) || trusted.revokedDeviceIds.includes(proof.keyId);
      if (!revoked) return unauthorized();
      const ledger = await chain();
      return ledger ? fail(401, { error: 'key_revoked', ledger }) : unauthorized();
    }

    const keyLimit = await consumeRateLimit('relay-token-key', `${proof.accountId}:${proof.keyId}`, KEY_LIMIT);
    if (!keyLimit.allowed) return fail(429, { error: 'rate_limited' }, { 'Retry-After': String(Math.ceil((keyLimit.retryAfterMs ?? 600000) / 1000)) });

    const centrifugoUrl = process.env.NEXT_PUBLIC_CENTRIFUGO_URL;
    if (!centrifugoUrl) { console.error('[auth/relay-token] NEXT_PUBLIC_CENTRIFUGO_URL is not configured'); return fail(503, { error: 'unavailable' }); }
    const ledger = head === trusted.head ? null : await chain();
    if (head !== trusted.head && !ledger) return unauthorized();
    const { token, expiresAt } = signRelayToken({ accountId: proof.accountId, info });
    return NextResponse.json(ledger ? { token, expiresAt, centrifugoUrl, ledger } : { token, expiresAt, centrifugoUrl }, { headers });
  } catch (error) {
    console.error('[auth/relay-token] unavailable:', error instanceof Error ? error.name : 'unknown');
    return fail(503, { error: 'unavailable' });
  }
}

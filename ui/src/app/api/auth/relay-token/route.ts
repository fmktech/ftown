import { NextResponse } from 'next/server';
import { consumeNonce } from '@/lib/auth-nonce-store';
import { readLedger, readTrustedCheckpoint } from '@/lib/account-ledger-store';
import { rateLimitKeyIp } from '@/lib/client-ip';
import { consumeRateLimit, type RateLimitConfig } from '@/lib/login-rate-limit';
import { publicOrigin } from '@/lib/ledger-auth';
import { signRelayToken } from '@/lib/relay-jwt';
import { isValidBridgeLabel } from '@/lib/bridge-label';
import { BoundedJsonError, readBoundedJson } from '@/lib/bounded-json';
import { parseLocalAdvert } from '@/lib/local-advert';
import { parseAuthProof, verifyAuthProof, type AuthProof } from '@security/ledger/proof';
import type { Ledger, LedgerCheckpoint } from '@security/ledger/protocol';

export const runtime = 'nodejs';
const headers = { 'Cache-Control': 'no-store' };
const MAX_BODY = 16384;
const IP_LIMIT: RateLimitConfig = { maxAttempts: 120, lockoutMs: 60 * 1000 };
const KEY_LIMIT: RateLimitConfig = { maxAttempts: 30, lockoutMs: 10 * 60 * 1000 };

const fail = (status: number, body: Record<string, unknown>, extra: Record<string, string> = {}) =>
  NextResponse.json(body, { status, headers: { ...headers, ...extra } });
const unauthorized = () => fail(401, { error: 'unauthorized' });

/**
 * A checkpoint view in which the revoked member is present again (its key taken from the chain's add record) and no longer listed
 * as revoked, so the shared verifyAuthProof can check the caller's signature, audience and purpose against the key the account
 * recorded. Null when this chain never admitted that member.
 */
function revokedMemberView(trusted: LedgerCheckpoint, ledger: Ledger, proof: AuthProof): LedgerCheckpoint | null {
  const list = proof.kind === 'device' ? trusted.revokedDeviceIds : trusted.revokedBridgeIds;
  if (!list.includes(proof.keyId)) return null;
  for (const { payload } of ledger.transitions ?? []) {
    const op = payload?.operation;
    if (proof.kind === 'device' && op?.type === 'add_device' && op.device.endpoint.id === proof.keyId) {
      return { ...trusted, devices: [...trusted.devices, op.device], revokedDeviceIds: trusted.revokedDeviceIds.filter(id => id !== proof.keyId) };
    }
    if (proof.kind === 'bridge' && op?.type === 'add_bridge' && op.bridge.bridgeId === proof.keyId) {
      return { ...trusted, bridges: [...trusted.bridges, op.bridge], revokedBridgeIds: trusted.revokedBridgeIds.filter(id => id !== proof.keyId) };
    }
  }
  return null;
}

export async function POST(request: Request): Promise<NextResponse> {
  try {
    const ipLimit = await consumeRateLimit('relay-token-ip', rateLimitKeyIp(request), IP_LIMIT);
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
    const expect = { audience: publicOrigin(), purpose: 'relay' } as const;

    const valid = await verifyAuthProof(trusted, proof, expect);
    if (!valid) {
      // key_revoked is evidence for the holder of the revoked key only: the signature must verify against the key the chain recorded.
      const revokedList = proof.kind === 'device' ? trusted.revokedDeviceIds : trusted.revokedBridgeIds;
      if (!revokedList.includes(proof.keyId)) return unauthorized();
      const ledger = await chain();
      const view = ledger ? revokedMemberView(trusted, ledger, proof) : null;
      if (!ledger || !view || !(await verifyAuthProof(view, proof, expect))) return unauthorized();
      return fail(401, { error: 'key_revoked', ledger });
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

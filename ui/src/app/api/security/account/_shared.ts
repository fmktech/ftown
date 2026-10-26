import { NextResponse } from 'next/server';
import jwt from 'jsonwebtoken';
import { auth } from '@/lib/auth';
import { getDb } from '@/lib/db';
import { getRequiredSecret } from '@/lib/secrets';
import { isTrustedBrowserOrigin } from '@/lib/request-origin';
import { boundedSecurityJson, SecurityStoreError } from '@/lib/security-store';
import { AccountTrustError } from '@security/account-crypto';
import type { AccountApiError } from '@security/account-protocol';
import { AccountStoreError } from '@/lib/account-trust-store';

export const ACCOUNT_HEADERS = { 'Cache-Control': 'no-store' };
class AuthenticationError extends Error { constructor(readonly status: number, readonly code: string, readonly retryAfter?: number) { super(code); } }
export async function accountOwner(request: Request, mutation = false): Promise<string> {
  if (mutation && !isTrustedBrowserOrigin(request)) throw new AuthenticationError(403, 'forbidden_origin');
  const authorization = request.headers.get('authorization');
  if (!mutation && authorization) {
    if (!authorization.startsWith('Bearer ')) throw new AuthenticationError(401, 'unauthorized');
    let claims;
    try { claims = jwt.verify(authorization.slice(7), getRequiredSecret('CENTRIFUGO_TOKEN_SECRET'), { audience: 'ftown:centrifugo', algorithms: ['HS256'] }); }
    catch { throw new AuthenticationError(401, 'unauthorized'); }
    if (typeof claims === 'string' || typeof claims.sub !== 'string' || !claims.info || typeof claims.info !== 'object'
      || typeof claims.info.bridgeId !== 'string' || typeof claims.info.ownerId !== 'string') throw new AuthenticationError(403, 'forbidden');
    const rows = await getDb().query(`SELECT u.id::text AS owner_id FROM users u JOIN bridge_refresh b ON b.sub=u.email
      WHERE b.bridge_id=$1 AND b.sub=$2 AND b.current_jti<>'revoked'`, [claims.info.bridgeId, claims.sub]);
    if (rows.length !== 1 || rows[0].owner_id !== claims.info.ownerId) throw new AuthenticationError(403, 'forbidden');
    return claims.info.ownerId;
  }
  const session = await auth();
  if (!session?.user?.id) throw new AuthenticationError(401, 'unauthorized');
  return session.user.id;
}
export async function accountRateLimit(ownerId: string, scope: string, maxAttempts: number): Promise<void> {
  // updated_at anchors the window; neither admitted nor rejected traffic slides it.
  // Ignore legacy login-counter locks, which could re-lock successful reads forever.
  const rows = await getDb().query(`INSERT INTO rate_limit_attempts(scope,key,failed_count,locked_until,updated_at)
    VALUES($1,$2,1,NULL,statement_timestamp())
    ON CONFLICT(scope,key) DO UPDATE SET
      failed_count=CASE WHEN rate_limit_attempts.updated_at<=statement_timestamp()-INTERVAL '60 seconds'
        THEN 1 ELSE LEAST(rate_limit_attempts.failed_count,$3::integer)+1 END,
      locked_until=NULL,
      updated_at=CASE WHEN rate_limit_attempts.updated_at<=statement_timestamp()-INTERVAL '60 seconds'
        THEN statement_timestamp() ELSE rate_limit_attempts.updated_at END
    RETURNING failed_count,EXTRACT(EPOCH FROM(updated_at+INTERVAL '60 seconds'-statement_timestamp())) AS retry_after`, [scope, ownerId, maxAttempts]);
  const count = Number(rows[0]?.failed_count);
  if (rows.length !== 1 || !Number.isSafeInteger(count) || count < 1) throw new AccountTrustError('account_storage_unavailable');
  if (count > maxAttempts) {
    const remaining = Number(rows[0].retry_after);
    const retryAfter = Number.isFinite(remaining) ? Math.min(60, Math.max(1, Math.ceil(remaining))) : 60;
    throw new AuthenticationError(429, 'rate_limited', retryAfter);
  }
}
export async function accountBody(request: Request, maxBytes: number): Promise<unknown> {
  return boundedSecurityJson(request, maxBytes);
}
export function accountError(error: unknown): NextResponse {
  if (error instanceof AuthenticationError) return NextResponse.json({ error: error.code }, { status: error.status,
    headers: { ...ACCOUNT_HEADERS, ...(error.retryAfter === undefined ? {} : { 'Retry-After': String(error.retryAfter) }) } });
  const failure = error instanceof AccountTrustError ? error : new AccountTrustError('account_storage_unavailable');
  const status = error instanceof SecurityStoreError || error instanceof AccountStoreError ? error.status
    : failure.code === 'account_storage_unavailable' ? 503
      : failure.code === 'account_trust_conflict' || failure.code === 'account_last_admin' ? 409
        : failure.code === 'account_enrollment_expired' ? 410
          : failure.code === 'account_capacity_exceeded' ? 413
            : ['account_approval_required', 'account_device_revoked', 'account_bridge_revoked'].includes(failure.code) ? 403 : 400;
  const body: AccountApiError = { error: { code: error instanceof SecurityStoreError ? error.status === 413 ? 'account_capacity_exceeded' : 'invalid_account_trust' : failure.code,
    message: error instanceof SecurityStoreError ? 'Account request is invalid or exceeds its size limit.' : failure.message, retryable: error instanceof SecurityStoreError ? false : failure.retryable } };
  return NextResponse.json(body, { status, headers: ACCOUNT_HEADERS });
}

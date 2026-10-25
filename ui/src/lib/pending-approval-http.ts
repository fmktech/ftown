import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { isTrustedBrowserOrigin } from '@/lib/request-origin';
import { boundedSecurityJson } from '@/lib/security-store';
import { accountError, accountRateLimit, ACCOUNT_HEADERS } from '@/app/api/security/account/_shared';
import { PendingApprovalStore } from '@/lib/pending-approval-store';
import { checkRateLimit, recordAttempt } from '@/lib/login-rate-limit';
import { clientIp } from '@/lib/client-ip';
import { PENDING_APPROVAL_LIMITS } from '@security/pending-approval-crypto';

class BrowserFailure extends Error { constructor(readonly status: number, readonly code: string) { super(code); } }
async function browser(request: Request, mutation: boolean): Promise<string> {
  if ((mutation || request.headers.has('origin')) && !isTrustedBrowserOrigin(request)) throw new BrowserFailure(403, 'forbidden_origin');
  const session = await auth();
  if (!session?.user?.id) throw new BrowserFailure(401, 'unauthorized');
  await accountRateLimit(session.user.id, mutation ? 'pending-approval-mutation' : 'pending-approval-read', mutation ? 60 : 200);
  return session.user.id;
}
function failure(error: unknown): NextResponse {
  if (error instanceof BrowserFailure) return NextResponse.json({ error: error.code }, { status: error.status, headers: ACCOUNT_HEADERS });
  return accountError(error);
}
export async function pendingInbox(request: Request): Promise<NextResponse> {
  try { return NextResponse.json(await new PendingApprovalStore().inbox(await browser(request, false)), { headers: ACCOUNT_HEADERS }); }
  catch (error) { return failure(error); }
}
export async function pendingCreate(request: Request): Promise<NextResponse> {
  try {
    const owner = await browser(request, true);
    return NextResponse.json(await new PendingApprovalStore().createBrowser(owner, await boundedSecurityJson(request, PENDING_APPROVAL_LIMITS.maxWireBytes)), { headers: ACCOUNT_HEADERS });
  } catch (error) { return failure(error); }
}
export async function pendingRead(request: Request, id: string): Promise<NextResponse> {
  try { return NextResponse.json(await new PendingApprovalStore().read(await browser(request, false), id), { headers: ACCOUNT_HEADERS }); }
  catch (error) { return failure(error); }
}
export async function pendingReview(request: Request, id: string): Promise<NextResponse> {
  try {
    const owner = await browser(request, true);
    return NextResponse.json(await new PendingApprovalStore().reviewer(owner, id, await boundedSecurityJson(request, PENDING_APPROVAL_LIMITS.maxWireBytes)), { headers: ACCOUNT_HEADERS });
  } catch (error) { return failure(error); }
}
export async function pendingCandidate(request: Request, id: string): Promise<NextResponse> {
  try {
    // CLI has no browser Origin. An explicitly supplied browser Origin must be trusted.
    if (request.headers.has('origin') && !isTrustedBrowserOrigin(request)) throw new BrowserFailure(403, 'forbidden_origin');
    const key = clientIp(request);
    if (!(await checkRateLimit('pending-candidate', key)).allowed) throw new BrowserFailure(429, 'rate_limited');
    await recordAttempt('pending-candidate', key, { maxAttempts: 600, lockoutMs: 60000 });
    return NextResponse.json(await new PendingApprovalStore().candidate(id, await boundedSecurityJson(request, PENDING_APPROVAL_LIMITS.maxWireBytes)), { headers: ACCOUNT_HEADERS });
  } catch (error) { return failure(error); }
}

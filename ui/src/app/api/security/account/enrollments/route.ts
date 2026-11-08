import { NextResponse } from 'next/server';
import { AccountTrustStore } from '@/lib/account-trust-store';
import { afterResponse, nudgeOwnerById } from '@/lib/server-security-nudge';
import { accountBody, accountError, accountOwner, accountRateLimit, ACCOUNT_HEADERS } from '../_shared';
export const runtime = 'nodejs';
export async function POST(request: Request): Promise<NextResponse> {
  try {
    const owner = await accountOwner(request, true);
    await accountRateLimit(owner, 'account-enrollment-create', 30);
    const store = new AccountTrustStore();
    const result = await store.createEnrollment(owner, await accountBody(request, 8192));
    if (store.changed) afterResponse(() => nudgeOwnerById(owner, 'account'));
    return NextResponse.json(result, { headers: ACCOUNT_HEADERS });
  } catch (error) { return accountError(error); }
}

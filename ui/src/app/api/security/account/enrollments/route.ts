import { NextResponse } from 'next/server';
import { AccountTrustStore } from '@/lib/account-trust-store';
import { accountBody, accountError, accountOwner, accountRateLimit, ACCOUNT_HEADERS } from '../_shared';
export const runtime = 'nodejs';
export async function POST(request: Request): Promise<NextResponse> {
  try {
    const owner = await accountOwner(request, true);
    await accountRateLimit(owner, 'account-enrollment-create', 30);
    const result = await new AccountTrustStore().createEnrollment(owner, await accountBody(request, 8192));
    return NextResponse.json(result, { headers: ACCOUNT_HEADERS });
  } catch (error) { return accountError(error); }
}

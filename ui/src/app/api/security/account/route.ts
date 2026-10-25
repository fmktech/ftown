import { NextResponse } from 'next/server';
import { AccountTrustStore } from '@/lib/account-trust-store';
import { ACCOUNT_TRUST_LIMITS } from '@security/account-crypto';
import { accountBody, accountError, accountOwner, accountRateLimit, ACCOUNT_HEADERS } from './_shared';
export const runtime = 'nodejs';
export async function GET(request: Request): Promise<NextResponse> {
  try {
    const owner = await accountOwner(request);
    await accountRateLimit(owner, 'account-read', 300);
    return NextResponse.json({ history: await new AccountTrustStore().read(owner) }, { headers: ACCOUNT_HEADERS });
  } catch (error) { return accountError(error); }
}
export async function POST(request: Request): Promise<NextResponse> {
  try {
    const owner = await accountOwner(request, true);
    await accountRateLimit(owner, 'account-append', 60);
    const history = await new AccountTrustStore().append(owner, await accountBody(request, ACCOUNT_TRUST_LIMITS.maxHistoryBytes + 8192));
    return NextResponse.json({ history }, { headers: ACCOUNT_HEADERS });
  } catch (error) { return accountError(error); }
}

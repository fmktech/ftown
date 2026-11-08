import { NextResponse } from 'next/server';
import { AccountTrustStore } from '@/lib/account-trust-store';
import { ACCOUNT_TRUST_LIMITS } from '@security/account-crypto';
import { afterResponse, nudgeOwnerById } from '@/lib/server-security-nudge';
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
    const store = new AccountTrustStore();
    const history = await store.append(owner, await accountBody(request, ACCOUNT_TRUST_LIMITS.maxHistoryBytes + 8192));
    if (store.changed) afterResponse(() => nudgeOwnerById(owner, 'account'));
    return NextResponse.json({ history }, { headers: ACCOUNT_HEADERS });
  } catch (error) { return accountError(error); }
}

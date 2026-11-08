import { NextResponse } from 'next/server';
import { AccountTrustStore } from '@/lib/account-trust-store';
import { afterResponse, nudgeOwnerById } from '@/lib/server-security-nudge';
import { accountBody, accountError, accountOwner, accountRateLimit, ACCOUNT_HEADERS } from '../../_shared';
export const runtime = 'nodejs';
type Context = { params: Promise<{ id: string }> };
export async function GET(request: Request, context: Context): Promise<NextResponse> {
  try {
    const owner = await accountOwner(request);
    await accountRateLimit(owner, 'account-enrollment-read', 120);
    return NextResponse.json(await new AccountTrustStore().enrollment(owner, (await context.params).id), { headers: ACCOUNT_HEADERS });
  } catch (error) { return accountError(error); }
}
export async function POST(request: Request, context: Context): Promise<NextResponse> {
  try {
    const owner = await accountOwner(request, true);
    await accountRateLimit(owner, 'account-enrollment-approve', 60);
    const store = new AccountTrustStore();
    const result = await store.approveEnrollment(owner, (await context.params).id, await accountBody(request, 458192));
    if (store.changed) afterResponse(() => nudgeOwnerById(owner, 'account'));
    return NextResponse.json(result, { headers: ACCOUNT_HEADERS });
  } catch (error) { return accountError(error); }
}

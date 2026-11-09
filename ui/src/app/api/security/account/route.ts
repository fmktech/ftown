import { NextResponse } from 'next/server';
import { AccountTrustStore } from '@/lib/account-trust-store';
import { ACCOUNT_TRUST_LIMITS } from '@security/account-crypto';
import { revokeBridgeRefreshForOwner } from '@/lib/bridge-refresh';
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
    if (store.changed) {
      try {
        const operation = history.transitions[history.transitions.length - 1]?.payload?.operation;
        if (operation?.type === 'revoke_bridge') await revokeBridgeRefreshForOwner(owner, operation.bridgeId);
      } catch (error) { console.error('[account] bridge refresh tombstone failed', error); }
      afterResponse(() => nudgeOwnerById(owner, 'account'));
    }
    return NextResponse.json({ history }, { headers: ACCOUNT_HEADERS });
  } catch (error) { return accountError(error); }
}

import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { isTrustedBrowserOrigin } from '@/lib/request-origin';
import { boundedSecurityJson, SecurityStoreError } from '@/lib/security-store';
import { accountRateLimit } from '@/app/api/security/account/_shared';
import { DeviceDisplayNameStore, DeviceNameStoreError, parseDeviceNameRequest } from '@/lib/device-display-name-store';
import type { DeviceNameErrorCode, DeviceNameErrorResponse } from '@/lib/device-display-name-contract';

export const runtime = 'nodejs';
const headers = { 'Cache-Control': 'no-store' };
const status: Record<DeviceNameErrorCode, number> = { unauthorized: 401, forbidden_origin: 403, invalid_request: 400,
  unknown_device: 404, conflict: 409, rate_limited: 429, storage_unavailable: 503 };
const messages: Record<DeviceNameErrorCode, string> = { unauthorized: 'Sign in to manage display names.', forbidden_origin: 'Request origin is not allowed.',
  invalid_request: 'Invalid display name request.', unknown_device: 'Device is not available.', conflict: 'Device access changed; refresh and try again.',
  rate_limited: 'Too many requests. Try again shortly.', storage_unavailable: 'Display names are unavailable.' };
function fail(error: unknown): NextResponse<DeviceNameErrorResponse> {
  let code: DeviceNameErrorCode = error instanceof DeviceNameStoreError ? error.code : error instanceof SecurityStoreError ? 'invalid_request' : 'storage_unavailable';
  let retryAfter: string | undefined;
  if (error instanceof Error && error.message === 'rate_limited' && 'retryAfter' in error && typeof error.retryAfter === 'number') {
    code = 'rate_limited'; retryAfter = String(error.retryAfter);
  }
  return NextResponse.json({ error: { code, message: messages[code] } }, { status: status[code], headers: { ...headers, ...(retryAfter ? { 'Retry-After': retryAfter } : {}) } });
}
async function owner(request: Request, mutation: boolean): Promise<string> {
  if (mutation && !isTrustedBrowserOrigin(request)) throw new DeviceNameStoreError('forbidden_origin');
  const session = await auth();
  if (!session?.user?.id) throw new DeviceNameStoreError('unauthorized');
  return session.user.id;
}
export async function GET(request: Request): Promise<NextResponse> {
  try {
    const id = await owner(request, false);
    await accountRateLimit(id, 'device-names-read', 120);
    return NextResponse.json(await new DeviceDisplayNameStore().list(id), { headers });
  } catch (error) { return fail(error); }
}
export async function PUT(request: Request): Promise<NextResponse> {
  try {
    const id = await owner(request, true);
    await accountRateLimit(id, 'device-names-write', 60);
    const input = parseDeviceNameRequest(await boundedSecurityJson(request, 2048));
    return NextResponse.json(await new DeviceDisplayNameStore().set(id, input), { headers });
  } catch (error) { return fail(error); }
}

import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { getDevicesForSub } from '@/lib/bridge-refresh';
import { SecurityStore, SecurityStoreError } from '@/lib/security-store';
export const runtime = 'nodejs';
export async function GET(request: Request): Promise<NextResponse> {
  const headers = { 'Cache-Control': 'no-store' };
  try {
    const session = await auth();
    if (!session?.user?.id || !session.user.email) throw new SecurityStoreError('unauthorized', 401);
    const url = new URL(request.url);
    if ([...url.searchParams.keys()].some(key => !['bridgeId', 'cursor', 'limit'].includes(key))) throw new SecurityStoreError('invalid_request', 400);
    const bridgeId = url.searchParams.get('bridgeId') || undefined;
    if (bridgeId && !(await getDevicesForSub(session.user.email)).some(device => device.bridgeId === bridgeId)) throw new SecurityStoreError('forbidden', 403);
    const limit = url.searchParams.has('limit') ? Number(url.searchParams.get('limit')) : undefined;
    return NextResponse.json(await new SecurityStore().activity(session.user.id, { bridgeId, limit, cursor: url.searchParams.get('cursor') || undefined }), { headers });
  } catch (error) {
    const invalidCursor = typeof error === 'object' && error !== null && 'code' in error && error.code === 'invalid_cursor';
    return NextResponse.json({ error: error instanceof SecurityStoreError ? error.code : invalidCursor ? 'invalid_cursor' : 'storage_unavailable' }, { status: error instanceof SecurityStoreError ? error.status : invalidCursor ? 400 : 503, headers });
  }
}

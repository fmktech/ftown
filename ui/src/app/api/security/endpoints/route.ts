import { NextResponse } from 'next/server';
import jwt from 'jsonwebtoken';
import { auth } from '@/lib/auth';
import { getDb } from '@/lib/db';
import { getRequiredSecret } from '@/lib/secrets';
import { SecurityStore, SecurityStoreError, boundedSecurityJson, parseDirectoryEntry } from '@/lib/security-store';
import { isTrustedBrowserOrigin } from '@/lib/request-origin';
export const runtime = 'nodejs';
const headers = { 'Cache-Control': 'no-store' };
export async function GET(): Promise<NextResponse> {
  try {
    const session = await auth();
    if (!session?.user?.id) return NextResponse.json({ error: 'unauthorized' }, { status: 401, headers });
    return NextResponse.json(await new SecurityStore().directory(session.user.id), { headers });
  } catch { return NextResponse.json({ error: 'storage_unavailable' }, { status: 503, headers }); }
}
export async function PUT(request: Request): Promise<NextResponse> {
  try {
    const entry = await parseDirectoryEntry(await boundedSecurityJson(request, 4096));
    const bearer = request.headers.get('authorization');
    let ownerId: string;
    if (bearer) {
      if (!bearer.startsWith('Bearer ')) throw new SecurityStoreError('unauthorized', 401);
      let claims;
      try { claims = jwt.verify(bearer.slice(7), getRequiredSecret('CENTRIFUGO_TOKEN_SECRET'), { audience: 'ftown:centrifugo', algorithms: ['HS256'] }); }
      catch { throw new SecurityStoreError('unauthorized', 401); }
      if (typeof claims === 'string' || typeof claims.sub !== 'string' || !claims.info || typeof claims.info !== 'object'
        || entry.endpoint.kind !== 'bridge' || entry.bridgeId !== claims.info.bridgeId || entry.endpoint.ownerId !== claims.info.ownerId) throw new SecurityStoreError('forbidden', 403);
      const rows = await getDb().query("SELECT u.id::text AS owner_id FROM users u JOIN bridge_refresh b ON b.sub=u.email WHERE b.bridge_id=$1 AND b.sub=$2 AND b.current_jti<>'revoked'", [entry.bridgeId, claims.sub]);
      if (rows.length !== 1 || rows[0].owner_id !== entry.endpoint.ownerId) throw new SecurityStoreError('forbidden', 403);
      ownerId = entry.endpoint.ownerId;
    } else {
      if (!isTrustedBrowserOrigin(request)) throw new SecurityStoreError('forbidden_origin', 403);
      const session = await auth();
      if (!session?.user?.id) throw new SecurityStoreError('unauthorized', 401);
      if (entry.endpoint.kind !== 'browser' || entry.bridgeId !== null || entry.endpoint.ownerId !== session.user.id) throw new SecurityStoreError('forbidden', 403);
      ownerId = session.user.id;
    }
    await new SecurityStore().register(ownerId, entry);
    return NextResponse.json({ registered: true }, { headers });
  } catch (error) {
    return NextResponse.json({ error: error instanceof SecurityStoreError ? error.code : 'storage_unavailable' }, { status: error instanceof SecurityStoreError ? error.status : 503, headers });
  }
}

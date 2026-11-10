import { NextResponse } from 'next/server';
import { requireAccount, UnauthorizedError } from '@/lib/ledger-auth';
import { requireAccountOrBridge } from '@/lib/relay-auth';
import { SecurityStore, SecurityStoreError, boundedSecurityJson, parseDirectoryEntry } from '@/lib/security-store';
import { isTrustedBrowserOrigin } from '@/lib/request-origin';
export const runtime = 'nodejs';
const headers = { 'Cache-Control': 'no-store' };
export async function GET(): Promise<NextResponse> {
  try {
    const { accountId, trusted } = await requireAccount();
    const directory = await new SecurityStore().directory(accountId);
    // Only endpoints that are CURRENT (trusted) devices/bridges of the ledger are discoverable.
    const live = (entry: { endpoint: { id: string; publicKey: string }; bridgeId: string | null }): boolean => entry.bridgeId === null
      ? trusted.devices.some(d => d.endpoint.id === entry.endpoint.id && d.endpoint.publicKey === entry.endpoint.publicKey)
      : trusted.bridges.some(b => b.bridgeId === entry.bridgeId && b.endpoint.id === entry.endpoint.id && b.endpoint.publicKey === entry.endpoint.publicKey);
    return NextResponse.json({ ...directory, endpoints: directory.endpoints.filter(live) }, { headers });
  } catch (error) {
    if (error instanceof UnauthorizedError) return NextResponse.json({ error: 'unauthorized' }, { status: 401, headers });
    return NextResponse.json({ error: 'storage_unavailable' }, { status: 503, headers });
  }
}
export async function PUT(request: Request): Promise<NextResponse> {
  try {
    const entry = await parseDirectoryEntry(await boundedSecurityJson(request, 4096));
    // Browsers (no Authorization header) are CSRF-checked first; bridges authenticate with their relay JWT.
    if (!request.headers.get('authorization') && !isTrustedBrowserOrigin(request)) throw new SecurityStoreError('forbidden_origin', 403);
    let caller;
    try { caller = await requireAccountOrBridge(request); }
    catch (error) { if (error instanceof UnauthorizedError) throw new SecurityStoreError('unauthorized', 401); throw error; }
    if (entry.endpoint.ownerId !== caller.accountId) throw new SecurityStoreError('forbidden', 403);
    const same = (e: { id: string; publicKey: string }): boolean => e.id === entry.endpoint.id && e.publicKey === entry.endpoint.publicKey;
    if (caller.kind === 'bridge') {
      // A bridge may only publish its OWN entry, with the endpoint key the ledger lists for it.
      if (entry.endpoint.kind !== 'bridge' || entry.bridgeId !== caller.bridgeId) throw new SecurityStoreError('forbidden', 403);
      const own = caller.trusted.bridges.find(b => b.bridgeId === caller.bridgeId);
      if (!own || !same(own.endpoint)) throw new SecurityStoreError('forbidden', 403);
    } else {
      // A browser may only publish the endpoint of the device its session was proven with.
      if (entry.endpoint.kind !== 'browser' || entry.bridgeId !== null || entry.endpoint.id !== caller.endpointId) throw new SecurityStoreError('forbidden', 403);
      const own = caller.trusted.devices.find(d => d.endpoint.id === caller.endpointId);
      if (!own || !same(own.endpoint)) throw new SecurityStoreError('forbidden', 403);
    }
    await new SecurityStore().register(caller.accountId, entry);
    return NextResponse.json({ registered: true }, { headers });
  } catch (error) {
    return NextResponse.json({ error: error instanceof SecurityStoreError ? error.code : 'storage_unavailable' }, { status: error instanceof SecurityStoreError ? error.status : 503, headers });
  }
}

import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { getDevicesForSub } from '@/lib/bridge-refresh';
import { mcpConsentRequest } from '@/lib/mcp-consent';
import { SecurityStoreError, boundedSecurityJson } from '@/lib/security-store';
import type { McpBridgeApproval } from '@security/protocol';
import { parseSecureEnvelope } from '@security/crypto';
import { isTrustedBrowserOrigin } from '@/lib/request-origin';
export const runtime = 'nodejs';
const headers = { 'Cache-Control': 'no-store' };
export async function GET(request: Request): Promise<NextResponse> {
  try {
    const session = await auth();
    if (!session?.user?.id) throw new SecurityStoreError('unauthorized', 401);
    const id = new URL(request.url).searchParams.get('request') ?? '';
    return NextResponse.json(await mcpConsentRequest(session.user.id, id, 'inspect'), { headers });
  } catch { return NextResponse.json({ error: 'approval_unavailable' }, { status: 400, headers }); }
}
export async function POST(request: Request): Promise<NextResponse> {
  try {
    if (!isTrustedBrowserOrigin(request)) throw new SecurityStoreError('forbidden_origin', 403);
    const session = await auth();
    if (!session?.user?.id || !session.user.email) throw new SecurityStoreError('unauthorized', 401);
    const body = await boundedSecurityJson(request);
    if (typeof body !== 'object' || body === null || !('requestId' in body) || typeof body.requestId !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(body.requestId)
      || !('decision' in body) || !['approve', 'deny'].includes(String(body.decision))
      || !('machines' in body) || !Array.isArray(body.machines) || body.machines.length > 64 || body.machines.some(machine => typeof machine !== 'string')
      || !('approvals' in body) || !Array.isArray(body.approvals) || body.approvals.length > 64) throw new SecurityStoreError('invalid_request', 400);
    const machines: string[] = body.machines;
    const details = await mcpConsentRequest<{ redirectUri: string }>(session.user.id, body.requestId, 'inspect');
    const owned = new Set((await getDevicesForSub(session.user.email)).filter(device => !device.revoked).map(device => device.bridgeId));
    if (body.decision === 'approve' && (!machines.length || new Set(machines).size !== machines.length || machines.some(machine => !owned.has(machine)))) throw new SecurityStoreError('forbidden', 403);
    const approvals: McpBridgeApproval[] = [];
    for (const value of body.approvals) {
      if (typeof value !== 'object' || value === null || typeof value.bridgeId !== 'string' || !machines.includes(value.bridgeId) || typeof value.bridge !== 'object' || value.bridge === null
        || value.bridge.kind !== 'bridge' || value.bridge.ownerId !== session.user.id || typeof value.bridge.publicKey !== 'string' || typeof value.bridge.id !== 'string' || value.bridge.version !== 1) throw new SecurityStoreError('invalid_request', 400);
      approvals.push({ bridgeId: value.bridgeId, bridge: { version: 1, kind: 'bridge', ownerId: session.user.id, id: value.bridge.id, publicKey: value.bridge.publicKey }, receipt: parseSecureEnvelope(value.receipt) });
    }
    const result = await mcpConsentRequest<{ redirect: string }>(session.user.id, body.requestId, body.decision === 'deny' ? 'deny' : 'approve', machines, approvals);
    const target = new URL(result.redirect); const registered = new URL(details.redirectUri);
    if (target.origin !== registered.origin || target.pathname !== registered.pathname) throw new SecurityStoreError('approval_unavailable', 400);
    return NextResponse.json(result, { headers });
  } catch (error) {
    return NextResponse.json({ error: error instanceof SecurityStoreError ? error.code : 'approval_unavailable' }, { status: error instanceof SecurityStoreError ? error.status : 400, headers });
  }
}

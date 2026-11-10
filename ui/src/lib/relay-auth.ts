import jwt from 'jsonwebtoken';
import { readTrustedCheckpoint } from '@/lib/account-ledger-store';
import type { LedgerCheckpoint } from '@security/ledger/protocol';
import { requireAccount, UnauthorizedError } from '@/lib/ledger-auth';
import { RELAY_TOKEN_AUDIENCE } from '@/lib/relay-jwt';
import { getRequiredSecret } from '@/lib/secrets';

const ACCOUNT_ID = /^[A-Za-z0-9_-]{43}$/;

export type RelayCaller =
  | { kind: 'bridge'; accountId: string; bridgeId: string; trusted: LedgerCheckpoint }
  | { kind: 'account'; accountId: string; endpointId: string; trusted: LedgerCheckpoint };

/**
 * Authenticate a bridge by its relay JWT (HS256, audience ftown:centrifugo, sub = accountId, info.bridgeId, info.ownerId === sub) and
 * re-check the bridge against the CURRENT trusted checkpoint (sticky revocations applied; the persisted one, so no chain is verified per
 * request): a 1 h token outlives revocation.
 * Throws UnauthorizedError (status 401) on every failure.
 */
export async function requireBridge(request: Request): Promise<{ accountId: string; bridgeId: string; trusted: LedgerCheckpoint }> {
  const authorization = request.headers.get('authorization');
  if (!authorization || !authorization.startsWith('Bearer ')) throw new UnauthorizedError();
  let claims: unknown;
  try { claims = jwt.verify(authorization.slice(7), getRequiredSecret('CENTRIFUGO_TOKEN_SECRET'), { audience: RELAY_TOKEN_AUDIENCE, algorithms: ['HS256'] }); }
  catch { throw new UnauthorizedError(); }
  if (typeof claims !== 'object' || claims === null) throw new UnauthorizedError();
  const { sub, info } = claims as { sub?: unknown; info?: unknown };
  if (typeof sub !== 'string' || !ACCOUNT_ID.test(sub)) throw new UnauthorizedError();
  if (typeof info !== 'object' || info === null) throw new UnauthorizedError();
  const { bridgeId, ownerId } = info as { bridgeId?: unknown; ownerId?: unknown };
  if (typeof bridgeId !== 'string' || bridgeId.length === 0 || ownerId !== sub) throw new UnauthorizedError();
  const trusted = await readTrustedCheckpoint(sub);
  if (!trusted || !trusted.bridges.some(bridge => bridge.bridgeId === bridgeId)) throw new UnauthorizedError();
  return { accountId: sub, bridgeId, trusted };
}

/** A Bearer relay JWT means a bridge; otherwise the signed-in browser session. */
export async function requireAccountOrBridge(request: Request): Promise<RelayCaller> {
  if (request.headers.get('authorization')?.startsWith('Bearer ')) return { kind: 'bridge', ...(await requireBridge(request)) };
  return { kind: 'account', ...(await requireAccount()) };
}

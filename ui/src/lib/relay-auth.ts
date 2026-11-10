import jwt from 'jsonwebtoken';
import { readLedger, type StoredLedger } from '@/lib/account-ledger-store';
import { requireAccount, UnauthorizedError } from '@/lib/ledger-auth';
import { RELAY_TOKEN_AUDIENCE } from '@/lib/relay-jwt';
import { getRequiredSecret } from '@/lib/secrets';

const ACCOUNT_ID = /^[A-Za-z0-9_-]{43}$/;

export type RelayCaller =
  | { kind: 'bridge'; accountId: string; bridgeId: string; stored: StoredLedger }
  | { kind: 'account'; accountId: string; endpointId: string; stored: StoredLedger };

/**
 * Authenticate a bridge by its relay JWT (HS256, audience ftown:centrifugo, sub = accountId, info.bridgeId, info.ownerId === sub) and
 * re-check the bridge against the CURRENT trusted ledger (sticky revocations applied): a 1 h token outlives revocation.
 * Throws UnauthorizedError (status 401) on every failure.
 */
export async function requireBridge(request: Request): Promise<{ accountId: string; bridgeId: string; stored: StoredLedger }> {
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
  const stored = await readLedger({ accountId: sub });
  if (!stored || !stored.trusted.bridges.some(bridge => bridge.bridgeId === bridgeId)) throw new UnauthorizedError();
  return { accountId: sub, bridgeId, stored };
}

/** A Bearer relay JWT means a bridge; otherwise the signed-in browser session. */
export async function requireAccountOrBridge(request: Request): Promise<RelayCaller> {
  if (request.headers.get('authorization')?.startsWith('Bearer ')) return { kind: 'bridge', ...(await requireBridge(request)) };
  return { kind: 'account', ...(await requireAccount()) };
}

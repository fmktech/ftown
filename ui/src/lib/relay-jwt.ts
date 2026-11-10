import jwt from 'jsonwebtoken';
import { getRequiredSecret } from '@/lib/secrets';

export const RELAY_TOKEN_LIFETIME_SECONDS = 3600;
export const RELAY_TOKEN_AUDIENCE = 'ftown:centrifugo';

/** Mint a Centrifugo connection JWT for an account: HS256, sub = accountId, exactly 1 h. Throws if the secret is unusable. */
export function signRelayToken(input: { accountId: string; info?: Record<string, unknown> }): { token: string; expiresAt: number } {
  const secret = getRequiredSecret('CENTRIFUGO_TOKEN_SECRET');
  const iat = Math.floor(Date.now() / 1000);
  const exp = iat + RELAY_TOKEN_LIFETIME_SECONDS;
  const claims: Record<string, unknown> = { sub: input.accountId, iat, exp };
  if (input.info !== undefined) claims.info = input.info;
  const token = jwt.sign(claims, secret, { algorithm: 'HS256', audience: RELAY_TOKEN_AUDIENCE });
  return { token, expiresAt: exp * 1000 };
}

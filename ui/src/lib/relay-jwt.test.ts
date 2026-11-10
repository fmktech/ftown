import jwt from 'jsonwebtoken';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { signRelayToken } from './relay-jwt';

const SECRET = 's'.repeat(40);
beforeEach(() => { vi.stubEnv('CENTRIFUGO_TOKEN_SECRET', SECRET); });
afterEach(() => { vi.unstubAllEnvs(); });

describe('signRelayToken', () => {
  it('signs HS256 with sub, audience and a lifetime of exactly 3600 s', () => {
    const { token, expiresAt } = signRelayToken({ accountId: 'acct' });
    const claims = jwt.verify(token, SECRET, { audience: 'ftown:centrifugo', algorithms: ['HS256'] }) as jwt.JwtPayload;
    expect(claims.sub).toBe('acct');
    expect(claims.exp! - claims.iat!).toBe(3600);
    expect(expiresAt).toBe(claims.exp! * 1000);
    expect(claims.info).toBeUndefined();
  });
  it('carries info when given', () => {
    const { token } = signRelayToken({ accountId: 'acct', info: { bridgeId: 'b' } });
    expect((jwt.decode(token) as jwt.JwtPayload).info).toEqual({ bridgeId: 'b' });
  });
  it('refuses a missing or placeholder secret', () => {
    vi.stubEnv('CENTRIFUGO_TOKEN_SECRET', '');
    expect(() => signRelayToken({ accountId: 'a' })).toThrow();
    vi.stubEnv('CENTRIFUGO_TOKEN_SECRET', 'change-me-' + 'x'.repeat(40));
    expect(() => signRelayToken({ accountId: 'a' })).toThrow();
  });
});

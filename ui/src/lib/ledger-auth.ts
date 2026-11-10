import Credentials from 'next-auth/providers/credentials';
import { consumeNonce } from '@/lib/auth-nonce-store';
import { publicOrigin } from '@/lib/public-origin';
import { readTrustedCheckpoint } from '@/lib/account-ledger-store';
import type { LedgerCheckpoint } from '@security/ledger/protocol';
import { parseAuthProof, verifyAuthProof } from '@security/ledger/proof';

const MAX_PROOF_JSON = 2048;

/** Lifetime for the NextAuth session JWT (12 h), for the wave-4 wiring. */
export const LEDGER_SESSION_MAX_AGE_SECONDS = 43200;
const ACCOUNT_ID = /^[A-Za-z0-9_-]{43}$/;

export { publicOrigin };

/** Verify a device possession proof for a session. Consumes the nonce before any ledger work. Never throws. */
export async function authorizeLedgerProof(raw: unknown): Promise<{ id: string; endpointId: string } | null> {
  try {
    const proof = parseAuthProof(raw);
    if (!proof || proof.kind !== 'device' || proof.purpose !== 'session') return null;
    if (!(await consumeNonce(proof.nonce, 'session'))) return null;
    const trusted = await readTrustedCheckpoint(proof.accountId);
    if (!trusted) return null;
    const ok = await verifyAuthProof(trusted, proof, { audience: publicOrigin(), purpose: 'session' });
    return ok ? { id: proof.accountId, endpointId: proof.keyId } : null;
  } catch { return null; }
}

/** NextAuth credentials provider `ledger`: credentials.proof is a JSON-encoded AuthProof. */
export function ledgerCredentialsProvider() {
  return Credentials({
    id: 'ledger',
    name: 'Ledger device key',
    credentials: { proof: { label: 'Proof', type: 'text' } },
    async authorize(credentials) {
      const text = credentials?.proof;
      if (typeof text !== 'string' || text.length === 0 || text.length > MAX_PROOF_JSON) return null;
      let parsed: unknown;
      try { parsed = JSON.parse(text); } catch { return null; }
      const result = await authorizeLedgerProof(parsed);
      return result ? { id: result.id, endpointId: result.endpointId } : null;
    },
  });
}

export class UnauthorizedError extends Error {
  readonly status = 401;
  constructor() { super('unauthorized'); this.name = 'UnauthorizedError'; }
}

type SessionReader = () => Promise<{ user?: { id?: string; endpointId?: string } } | null>;

/**
 * Resolve the signed-in account and re-check it against the CURRENT trusted checkpoint on every call: a session JWT outlives
 * device revocation, and a pre-ledger cookie must not pass. Throws UnauthorizedError unless the session's device is still trusted.
 * The checkpoint is the MAC-authenticated one persisted with the chain (readTrustedCheckpoint): no chain is verified per request.
 */
export async function requireAccount(readSession?: SessionReader): Promise<{ accountId: string; endpointId: string; trusted: LedgerCheckpoint }> {
  const read = readSession ?? (async () => (await import('@/lib/auth')).auth() as ReturnType<SessionReader>);
  const session = await read();
  const accountId = session?.user?.id;
  const endpointId = session?.user?.endpointId;
  if (typeof accountId !== 'string' || !ACCOUNT_ID.test(accountId)) throw new UnauthorizedError();
  if (typeof endpointId !== 'string' || endpointId.length === 0) throw new UnauthorizedError();
  const trusted = await readTrustedCheckpoint(accountId);
  // A revoked id never passes, even if a checkpoint ever listed it as a member too.
  if (!trusted || trusted.revokedDeviceIds.includes(endpointId) || trusted.devices.every(device => device.endpoint.id !== endpointId)) throw new UnauthorizedError();
  return { accountId, endpointId, trusted };
}

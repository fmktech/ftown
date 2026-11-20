import { AsyncLocalStorage } from 'node:async_hooks';
import type { VerifiedPrincipal } from './security/protocol.js';
import { z } from 'zod';
import { normalizeShellType } from './harness-registry.js';
import type { Session } from './types.js';

export const sessionRequestPrincipal = new AsyncLocalStorage<VerifiedPrincipal>();

type Parent = Pick<Session, 'id' | 'bridgeId' | 'name' | 'projectName' | 'parentSessionId' | 'parentBridgeId' | 'shellType' | 'workingDir' | 'account' | 'allowedAccounts'>;
export type RemoteParentLookup = (owner: string, id: string) => Promise<Parent>;
const identifier = z.string().regex(/^[A-Za-z0-9_-]{1,200}$/);
const remoteParent = z.object({ id: identifier, bridgeId: identifier, name: z.string(),
  projectName: z.string().max(256).optional(), parentSessionId: identifier.optional(),
  parentBridgeId: identifier.optional(), shellType: z.string().optional().transform(normalizeShellType) });

export function parseRemoteParent(body: unknown) {
  return z.object({ session: remoteParent }).parse(body).session;
}

export class ParentLookupError extends Error {}

export async function resolveSessionParent(store: { loadSession(id: string): Promise<Parent | null> },
  local: string, id: string, owner = local, remote?: RemoteParentLookup) {
  async function load(owner: string, id: string) {
    if (!identifier.safeParse(id).success) throw new ParentLookupError('Invalid parentSessionId');
    let session: Parent | null | undefined;
    if (owner === local) session = await store.loadSession(id);
    else {
      try { session = await remote?.(owner, id); }
      catch { throw new ParentLookupError('Parent session unavailable'); }
    }
    if (!session || session.id !== id) throw new ParentLookupError('Parent session not found');
    if (session.bridgeId !== owner) throw new ParentLookupError('Parent session belongs to another bridge');
    return session;
  }
  const direct = await load(owner, id);
  const root = direct.parentSessionId ? await load(direct.parentBridgeId ?? owner, direct.parentSessionId) : direct;
  if (root.parentSessionId) throw new ParentLookupError('Invalid parent hierarchy');
  return { direct, root };
}

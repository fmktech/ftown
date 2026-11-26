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

type ParentTarget = { bridgeId: string; id: string };
/** In-progress writes are visible to other bridges during their authoritative topology reads. */
export class SessionHierarchyWrites {
  private readonly writes = new Set<{ source?: string; target?: ParentTarget }>();
  begin(source?: string, target?: ParentTarget): () => void {
    if (source && this.isMoving(source)) throw new ParentLookupError('Session is moving; retry');
    const change = { source, target };
    this.writes.add(change);
    return () => { this.writes.delete(change); };
  }
  isMoving(id: string): boolean {
    return [...this.writes].some(w => w.source === id);
  }
  pendingParents(): ParentTarget[] {
    return [...this.writes].flatMap(w => w.target ? [w.target] : []);
  }
}

export function hasPendingChild(body: unknown, bridgeId: string, id: string): boolean {
  const snapshot = z.object({ pendingParents: z.array(z.object({ bridgeId: identifier, id: identifier })).optional() }).parse(body);
  return !!snapshot.pendingParents?.some(p => p.bridgeId === bridgeId && p.id === id);
}

export function parseRemoteParent(body: unknown) {
  const { session, hierarchyChanging } = z.object({ session: remoteParent, hierarchyChanging: z.boolean().optional() }).parse(body);
  if (hierarchyChanging) throw new ParentLookupError('Parent session is moving; retry');
  return session;
}

export class ParentLookupError extends Error {}

export async function resolveSessionParent(store: { loadSession(id: string): Promise<Parent | null> },
  local: string, id: string, owner = local, remote?: RemoteParentLookup, writes?: SessionHierarchyWrites) {
  async function load(owner: string, id: string) {
    if (!identifier.safeParse(id).success) throw new ParentLookupError('Invalid parentSessionId');
    let session: Parent | null | undefined;
    if (owner === local) {
      if (writes?.isMoving(id)) throw new ParentLookupError('Parent session is moving; retry');
      session = await store.loadSession(id);
      if (writes?.isMoving(id)) throw new ParentLookupError('Parent session is moving; retry');
    }
    else {
      try { session = await remote?.(owner, id); }
      catch (error) { if (error instanceof ParentLookupError) throw error; throw new ParentLookupError('Parent session unavailable'); }
    }
    if (!session || session.id !== id) throw new ParentLookupError('Parent session not found');
    if (session.bridgeId !== owner) throw new ParentLookupError('Parent session belongs to another bridge');
    return session;
  }
  const ancestry: Parent[] = [];
  const seen = new Set<string>();
  for (;;) {
    const key = JSON.stringify([owner, id]);
    if (seen.has(key)) throw new ParentLookupError('Cycle in session ancestry');
    if (ancestry.length >= 32) throw new ParentLookupError('Session nesting is limited to 32 parent links');
    seen.add(key);
    const parent = await load(owner, id);
    ancestry.push(parent);
    if (!parent.parentSessionId) return ancestry;
    id = parent.parentSessionId;
    owner = parent.parentBridgeId ?? owner;
  }
}

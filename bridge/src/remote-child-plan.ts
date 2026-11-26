import { z } from 'zod';
import type { PlanStore } from './coordination/plan.js';
import type { CreatePlanStoreDep } from './create-ftown-session.js';
import type { PeerControl } from './peer-control.js';
import { parseRemoteParent } from './session-parent.js';
import type { Session } from './types.js';

type Peers = Pick<PeerControl, 'http'>;
type Child = Pick<Session, 'id' | 'parentSessionId' | 'parentBridgeId' | 'bridgeId'>;
type Plans = Pick<PlanStore, 'get' | 'startForChild' | 'completeForChild' | 'releaseForChild'>;
export const CHILD_PLAN_PATH = '/api/child-plan';
const id = z.string().regex(/^[A-Za-z0-9_-]{1,200}$/);
const item = z.string().regex(/^p\d{1,6}$/);
const action = z.discriminatedUnion('action', [
  z.object({ action: z.literal('inspect'), parentId: id }).strict(),
  z.object({ action: z.literal('bind'), parentId: id, childId: id, itemId: item }).strict(),
  z.object({ action: z.literal('complete'), parentId: id, childId: id }).strict(),
  z.object({ action: z.literal('release'), parentId: id, childId: id }).strict(),
]);

async function send(peers: Peers, owner: string, body: z.infer<typeof action>, timeoutMs?: number) {
  const reply = await peers.http(owner, 'POST', CHILD_PLAN_PATH, body, timeoutMs);
  if (reply.status !== 200) throw new Error('Parent bridge could not apply the child plan request');
  return reply.body;
}

export function remoteChildPlanStore(peers: Peers, owner: string): CreatePlanStoreDep {
  return {
    async get(parentId) {
      const reply = await send(peers, owner, { action: 'inspect', parentId });
      return z.object({ items: z.array(z.object({ id: item, state: z.enum(['todo', 'started', 'done', 'dropped']) })) }).parse(reply);
    },
    async startForChild(parentId, itemId, childId) {
      await send(peers, owner, { action: 'bind', parentId, childId, itemId });
    },
  };
}

export async function remotePlanBlocksHandoff(peers: Peers, child: Child) {
  if (!child.parentSessionId || !child.parentBridgeId || child.parentBridgeId === child.bridgeId) return false;
  const reply = await peers.http(child.parentBridgeId, 'GET', '/api/sessions/' + encodeURIComponent(child.parentSessionId) + '/plan', undefined, 8_000);
  if (reply.status !== 200) throw new Error('Cannot verify plan assignments on the parent bridge');
  const result = z.object({ items: z.array(z.object({ sessionId: id.optional(), sessionBridgeId: id.optional(), state: z.string() })) }).parse(reply.body);
  return result.items.some(item => item.state === 'started' && item.sessionId === child.id && (!item.sessionBridgeId || item.sessionBridgeId === child.bridgeId));
}

export async function remotePlanForChild(peers: Peers, child: Child, action: 'complete' | 'release') {
  if (!child.parentSessionId || !child.parentBridgeId || child.parentBridgeId === child.bridgeId) return;
  await send(peers, child.parentBridgeId, { action, parentId: child.parentSessionId, childId: child.id }, 8_000);
}

/** The caller bridge identity comes from the authenticated peer endpoint. */
export async function applyRemoteChildPlan(peers: Peers, plans: Plans, local: string, caller: string,
  payload: unknown, revalidate: () => Promise<void>) {
  const body = action.parse(payload);
  if (body.action === 'inspect') {
    const plan = await plans.get(body.parentId);
    return { items: plan?.items.map(({ id, state }) => ({ id, state })) ?? [] };
  }
  if (body.action === 'bind') {
    const reply = await peers.http(caller, 'GET', '/api/sessions/' + body.childId);
    if (reply.status !== 200) throw new Error('Child unavailable');
    const child = parseRemoteParent(reply.body);
    if (child.id !== body.childId || child.bridgeId !== caller || child.parentSessionId !== body.parentId || child.parentBridgeId !== local)
      throw new Error('Child does not belong to this manager');
    await revalidate();
    await plans.startForChild(body.parentId, body.itemId, body.childId, caller);
  } else if (body.action === 'complete') {
    await plans.completeForChild(body.parentId, body.childId, caller);
  } else {
    await plans.releaseForChild(body.parentId, body.childId, caller);
  }
  return { ok: true };
}

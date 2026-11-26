import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import type { PeerControl } from '../peer-control.js';
import { remotePlanForChild } from '../remote-child-plan.js';
import type { Session } from '../types.js';
import { TREE_EVENT_KINDS, type TreeEventInput } from './contract.js';

export const TEAM_EVENT_PATH = '/api/team-event';
const id = z.string().regex(/^[A-Za-z0-9_-]{1,200}$/);
export const teamEvent = z.object({
  manager: id, deliveryId: z.string().uuid(),
  event: z.object({ sessionId: id, sessionName: z.string().max(200), kind: z.enum(TREE_EVENT_KINDS),
    summary: z.string().max(1000), ref: z.string().max(1000).optional() }).strict(),
}).strict();

type Route = Pick<Session, 'id' | 'bridgeId' | 'parentBridgeId' | 'parentSessionId'>;
type Entry = { child: Route; action: 'complete' | 'release' } | { event: z.infer<typeof teamEvent> };

/** Persist the child's ordered manager notifications before attempting network delivery. */
export class PeerTeamOutbox {
  private readonly db: DatabaseSync;
  private readonly drains = new Map<string, Promise<void>>();
  private stopped = false;

  constructor(path: string, private peers: Pick<PeerControl, 'http'>) {
    this.db = new DatabaseSync(path);
    this.db.exec('CREATE TABLE IF NOT EXISTS pending(seq INTEGER PRIMARY KEY, owner TEXT NOT NULL, body TEXT NOT NULL)');
  }

  plan(child: Route, action: 'complete' | 'release'): void {
    if (child.parentBridgeId) {
      const {id, bridgeId, parentSessionId, parentBridgeId} = child;
      this.enqueue(parentBridgeId, {child: {id, bridgeId, parentSessionId, parentBridgeId}, action});
    }
  }

  event(child: Route, event: TreeEventInput): void {
    if (child.parentBridgeId && child.parentSessionId) this.enqueue(child.parentBridgeId, {
      event: {manager: child.parentSessionId, deliveryId: randomUUID(), event: {
        ...event, sessionName: event.sessionName.slice(0, 200), summary: event.summary.slice(0, 1000),
        ...(event.ref ? {ref: event.ref.slice(0, 1000)} : {}),
      }},
    });
  }

  private enqueue(owner: string, entry: Entry): void {
    this.db.prepare('INSERT INTO pending(owner, body) VALUES (?,?)').run(owner, JSON.stringify(entry));
    this.flushOwner(owner);
  }

  async flush(): Promise<void> {
    for (const row of this.db.prepare('SELECT DISTINCT owner FROM pending').all()) this.flushOwner(String(row.owner));
    await Promise.all(this.drains.values());
  }

  private flushOwner(owner: string): void {
    if (this.stopped || this.drains.has(owner)) return;
    const drain = this.drain(owner).catch(() => { /* Retry after reconnect or on the maintenance tick. */ })
      .finally(() => this.drains.delete(owner));
    this.drains.set(owner, drain);
  }

  private async drain(owner: string): Promise<void> {
    while (!this.stopped) {
      const row = this.db.prepare('SELECT seq, body FROM pending WHERE owner=? ORDER BY seq LIMIT 1').get(owner);
      if (!row) return;
      const entry = JSON.parse(String(row.body)) as Entry;
      if ('event' in entry) {
        const response = await this.peers.http(owner, 'POST', TEAM_EVENT_PATH, entry.event, 8_000);
        if (response.status !== 200 && response.status !== 410) return;
      } else await remotePlanForChild(this.peers, entry.child, entry.action);
      this.db.prepare('DELETE FROM pending WHERE seq=?').run(row.seq);
    }
  }

  async close(): Promise<void> {
    this.stopped = true;
    await Promise.all(this.drains.values());
    this.db.close();
  }
}

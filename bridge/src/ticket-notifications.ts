import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { PeerControl } from './peer-control.js';
import type { ProjectBoardStore, TicketNotification } from './project-board-store.js';
import { TICKET_NOTIFICATION_WIRE, ticketNotificationBody, type TicketNotice } from './ticket-notification-protocol.js';

interface ReceivedNotice extends TicketNotice { sequence: number; homeBridgeId: string }

export class TicketNotificationInbox {
  constructor(private readonly path: string, private readonly bridgeId: string) {}

  private withDb<T>(fn: (db: DatabaseSync) => T): T {
    mkdirSync(dirname(this.path), { mode: 0o700, recursive: true });
    const db = new DatabaseSync(this.path);
    try {
      db.exec(`CREATE TABLE IF NOT EXISTS receipts (
        sequence INTEGER PRIMARY KEY, home TEXT NOT NULL, id TEXT NOT NULL, event TEXT NOT NULL,
        UNIQUE (home, id)
      ); CREATE INDEX IF NOT EXISTS receipts_event_id ON receipts(id)`);
      return fn(db);
    } finally { db.close(); }
  }

  receive(homeBridgeId: string, body: unknown): string {
    const event = ticketNotificationBody.parse(body);
    if (event.bridgeId !== this.bridgeId) throw new Error('Incorrect notification recipient');
    const serialized = JSON.stringify(event);
    this.withDb(db => db.prepare(`INSERT OR IGNORE INTO receipts(home,id,event)
      SELECT ?,?,? WHERE NOT EXISTS (SELECT 1 FROM receipts WHERE id=? AND event=?)`)
      .run(homeBridgeId, event.id, serialized, event.id, serialized));
    return event.id;
  }

  list(after: number, limit: number) {
    const notifications: ReceivedNotice[] = [];
    const rows = this.withDb(db => db.prepare('SELECT sequence,home,event FROM receipts WHERE sequence > ? ORDER BY sequence LIMIT ?').all(after, limit));
    let bytes = 0;
    for (const row of rows) {
      const event = String(row.event);
      bytes += Buffer.byteLength(event) + Buffer.byteLength(String(row.home)) + 100;
      if (bytes > 180_000) break;
      notifications.push({ ...JSON.parse(event), sequence: Number(row.sequence), homeBridgeId: String(row.home) });
    }
    return { notifications, nextCursor: notifications.at(-1)?.sequence ?? after };
  }
}

/** An outbox row is removed only after its recipient durably acknowledges that exact event. */
export async function deliverTicketNotifications(projects: ProjectBoardStore, inbox: TicketNotificationInbox, homeBridgeId: string,
  peers: PeerControl, projectId: string) {
  const unreachable = new Set<string>();
  const allowed = new Set((await peers.list()).map(peer => peer.bridgeId));
  let after = 0;
  for (;;) {
    const events = projects.pendingNotifications(projectId, after, 100);
    if (!events.length) break;
    const batches = new Map<string, TicketNotification[]>();
    for (const event of events) {
      after = event.seq;
      const batch = batches.get(event.bridgeId);
      if (batch) batch.push(event);
      else batches.set(event.bridgeId, [event]);
    }
    await Promise.all(Array.from(batches, async ([target, batch]) => {
      if (unreachable.has(target)) return;
      try {
        if (target !== homeBridgeId && (!allowed.has(target) || !await peers.connectDirect(target))) {
          unreachable.add(target);
          return;
        }
        for (const { seq: _seq, ...notice } of batch) {
          if (target === homeBridgeId) inbox.receive(homeBridgeId, notice);
          else {
            const reply = await peers.directHttp(target, TICKET_NOTIFICATION_WIRE, notice);
            if (reply.status !== 200 || (reply.body as { id?: unknown } | null)?.id !== notice.id) {
              unreachable.add(target);
              return;
            }
          }
          projects.acknowledgeNotification(projectId, notice.id);
        }
      } catch { unreachable.add(target); }
    }));
  }
}

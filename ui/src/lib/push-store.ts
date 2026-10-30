import { randomUUID } from "node:crypto";
import { getDb } from "@/lib/db";
import { endpointHash, eventIdentity, genericPushEvent, PushError, type BrowserSubscription, type PushEvent } from "./push";

type Query = (text: string, params: unknown[]) => Promise<Record<string, unknown>[]>;
export interface StoredDelivery { endpointHash: string; subscription: BrowserSubscription; lease: string }
/** All ownership predicates live at the persistence boundary as well as the route. */
export class PushStore {
  constructor(private query: Query = (text, params) => getDb().query(text, params)) {}
  async available(): Promise<boolean> {
    const rows = await this.query("SELECT to_regclass('push_subscriptions') AS subscriptions,to_regclass('push_events') AS events,to_regclass('push_deliveries') AS deliveries", []);
    return !!(rows[0]?.subscriptions && rows[0]?.events && rows[0]?.deliveries);
  }
  async rate(owner: string, scope: string, limit: number): Promise<void> {
    const rows = await this.query(`INSERT INTO rate_limit_attempts(scope,key,failed_count,updated_at) VALUES ($1,$2,1,NOW())
      ON CONFLICT(scope,key) DO UPDATE SET failed_count = CASE WHEN rate_limit_attempts.updated_at < NOW()-INTERVAL '1 minute' THEN 1 ELSE rate_limit_attempts.failed_count+1 END,
      updated_at = CASE WHEN rate_limit_attempts.updated_at < NOW()-INTERVAL '1 minute' THEN NOW() ELSE rate_limit_attempts.updated_at END RETURNING failed_count`, [scope, owner]);
    if (Number(rows[0]?.failed_count) > limit) throw new PushError("rate_limited", 429);
  }
  async subscribe(owner: string, subscription: BrowserSubscription): Promise<void> {
    const rows = await this.query(`WITH slot AS (
      SELECT slot FROM push_subscriptions WHERE endpoint_hash=$2 AND sub=$1
      UNION ALL SELECT n FROM generate_series(1,10) n WHERE NOT EXISTS(
        SELECT 1 FROM push_subscriptions WHERE sub=$1 AND slot=n) LIMIT 1)
      INSERT INTO push_subscriptions(endpoint_hash,sub,endpoint,p256dh,auth,slot)
      SELECT $2,$1,$3,$4,$5,slot FROM slot
      ON CONFLICT(endpoint_hash) DO UPDATE SET p256dh=EXCLUDED.p256dh,auth=EXCLUDED.auth
      WHERE push_subscriptions.sub=EXCLUDED.sub RETURNING endpoint_hash`,
    [owner, endpointHash(subscription.endpoint), subscription.endpoint, subscription.keys.p256dh, subscription.keys.auth]);
    if (!rows.length) throw new PushError("subscription_limit_or_conflict", 409);
  }
  async unsubscribe(owner: string, endpoint: string): Promise<void> {
    await this.query("DELETE FROM push_subscriptions WHERE sub=$1 AND endpoint_hash=$2", [owner, endpointHash(endpoint)]);
  }
  async ingest(owner: string, bridgeId: string, event: PushEvent): Promise<{ id: string; event: PushEvent }> {
    event = genericPushEvent(event);
    const id = eventIdentity(owner, bridgeId, event);
    // Both ID and logical event tuple are unique; concurrent duplicates can conflict on either.
    // Recipient snapshot is part of the same atomic statement as first event creation.
    await this.query(`WITH created AS (
      INSERT INTO push_events(id,sub,bridge_id,session_id,event_key,kind,payload,occurred_at)
      VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8::timestamptz) ON CONFLICT DO NOTHING RETURNING id,sub,occurred_at)
      INSERT INTO push_deliveries(event_id,endpoint_hash)
      SELECT created.id,s.endpoint_hash FROM created JOIN push_subscriptions s ON s.sub=created.sub
      WHERE s.created_at<=created.occurred_at ON CONFLICT DO NOTHING`,
    [id,owner,bridgeId,event.sessionId,event.eventKey,event.kind,JSON.stringify(event),event.occurredAt]);
    const rows = await this.query("SELECT payload FROM push_events WHERE id=$1 AND sub=$2", [id,owner]);
    if (!rows[0]) throw new PushError("push_unavailable",503);
    // Legacy rows are also projected to generic text; their content never re-enters delivery.
    return { id, event: genericPushEvent(rows[0].payload as unknown as PushEvent) };
  }
  async claim(owner: string, id: string): Promise<StoredDelivery[]> {
    const lease = randomUUID();
    const rows = await this.query(`WITH claimed AS (
      UPDATE push_deliveries d SET lease_token=$3,lease_until=NOW()+INTERVAL '25 seconds'
      FROM push_events e WHERE d.event_id=e.id AND e.id=$1 AND e.sub=$2 AND d.sent_at IS NULL
      AND (d.lease_until IS NULL OR d.lease_until<NOW()) RETURNING d.endpoint_hash)
      SELECT s.endpoint_hash,s.endpoint,s.p256dh,s.auth FROM claimed c JOIN push_subscriptions s USING(endpoint_hash) WHERE s.sub=$2 LIMIT 10`,[id,owner,lease]);
    return rows.map((r) => ({ endpointHash: String(r.endpoint_hash), lease, subscription: { endpoint: String(r.endpoint), keys: { p256dh: String(r.p256dh), auth: String(r.auth) } } }));
  }
  async complete(id: string, delivery: StoredDelivery): Promise<void> {
    await this.query("UPDATE push_deliveries SET sent_at=NOW(),lease_until=NULL WHERE event_id=$1 AND endpoint_hash=$2 AND lease_token=$3",[id,delivery.endpointHash,delivery.lease]);
  }
  async release(id: string, delivery: StoredDelivery): Promise<void> {
    await this.query("UPDATE push_deliveries SET lease_until=NULL WHERE event_id=$1 AND endpoint_hash=$2 AND lease_token=$3",[id,delivery.endpointHash,delivery.lease]);
  }
  async remaining(owner: string,id: string): Promise<number> {
    const rows = await this.query("SELECT COUNT(*) AS count FROM push_deliveries d JOIN push_events e ON e.id=d.event_id WHERE e.id=$1 AND e.sub=$2 AND d.sent_at IS NULL",[id,owner]);
    return Number(rows[0]?.count ?? 0);
  }
}

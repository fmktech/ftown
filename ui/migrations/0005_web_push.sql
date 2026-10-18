-- Additive Web Push state. Apply before enabling VAPID; no existing data changes.
CREATE TABLE IF NOT EXISTS push_subscriptions (
  endpoint_hash TEXT PRIMARY KEY,
  sub TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  slot SMALLINT NOT NULL CHECK (slot BETWEEN 1 AND 10),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(sub,slot)
);
CREATE TABLE IF NOT EXISTS push_events (
  id TEXT PRIMARY KEY,
  sub TEXT NOT NULL,
  bridge_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  event_key TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('question','idle')),
  payload JSONB NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(sub,bridge_id,session_id,event_key)
);
CREATE TABLE IF NOT EXISTS push_deliveries (
  event_id TEXT NOT NULL REFERENCES push_events(id) ON DELETE CASCADE,
  endpoint_hash TEXT NOT NULL REFERENCES push_subscriptions(endpoint_hash) ON DELETE CASCADE,
  sent_at TIMESTAMPTZ,
  lease_token TEXT,
  lease_until TIMESTAMPTZ,
  PRIMARY KEY(event_id,endpoint_hash)
);

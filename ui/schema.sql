CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE users (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  email      TEXT        NOT NULL UNIQUE,
  password_hash TEXT     NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_users_email ON users(email);

-- Scope-keyed rate limiter shared by login (scope 'login', key = email) and
-- registration (scope 'register', key = client IP). UNLOGGED: counters are
-- throwaway, so skip WAL for cheap upserts on the hot path (truncated on crash
-- recovery, not replicated — acceptable for this data).
CREATE UNLOGGED TABLE rate_limit_attempts (
  scope        TEXT        NOT NULL,
  key          TEXT        NOT NULL,
  failed_count INTEGER     NOT NULL DEFAULT 0,
  locked_until TIMESTAMPTZ,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (scope, key)
);

-- Per-bridge refresh-token rotation state: the current accepted jti. A refresh
-- token is only honored when its jti matches, and each use rotates it.
-- hostname/last_seen (added by 0002_device_pairing.sql) back the devices list.
CREATE TABLE bridge_refresh (
  bridge_id   TEXT        PRIMARY KEY,
  sub         TEXT        NOT NULL,
  current_jti TEXT        NOT NULL,
  hostname    TEXT,
  last_seen   TIMESTAMPTZ,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Device pairing (bridge onboarding): OAuth-device-authorization-style flow.
-- See docs/plans/device-pairing-contract.md.
CREATE TABLE pairing_requests (
  device_code   TEXT        PRIMARY KEY,
  user_code     TEXT        NOT NULL UNIQUE,
  bridge_id     TEXT        NOT NULL,
  hostname      TEXT,
  platform      TEXT,
  status        TEXT        NOT NULL DEFAULT 'pending',
  sub           TEXT,
  refresh_jti   TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at    TIMESTAMPTZ NOT NULL,
  approved_at   TIMESTAMPTZ
);

CREATE INDEX idx_pairing_user_code ON pairing_requests(user_code);

-- MCP OAuth state is shared across gateway replicas. Token/code keys are SHA-256 hashes.
CREATE TABLE IF NOT EXISTS mcp_oauth_records (
  kind TEXT NOT NULL CHECK (kind IN ('client', 'pending', 'code', 'grant', 'access', 'refresh')),
  key TEXT NOT NULL,
  data JSONB NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (kind, key)
);
CREATE INDEX IF NOT EXISTS mcp_oauth_records_expiry ON mcp_oauth_records(expires_at);

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

-- Additive security state only. Existing user/OAuth/bridge rows are untouched.
-- The migrator runs each file transactionally; bound waiting for DDL locks.

CREATE TABLE IF NOT EXISTS security_endpoint_directory (
  owner_id TEXT NOT NULL,
  endpoint_id TEXT NOT NULL,
  bridge_id TEXT,
  entry JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY(owner_id, endpoint_id)
);
CREATE INDEX IF NOT EXISTS security_endpoint_directory_owner_bridge
  ON security_endpoint_directory(owner_id, bridge_id);

-- The wrapping key remains outside PostgreSQL. envelope authenticates all
-- lookup fields and contains only nonce/ciphertext/key ID + public context.
CREATE TABLE IF NOT EXISTS mcp_endpoint_identities (
  owner_id TEXT NOT NULL,
  request_id TEXT NOT NULL UNIQUE,
  grant_id TEXT NOT NULL UNIQUE,
  endpoint_id TEXT NOT NULL,
  envelope JSONB NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY(owner_id, grant_id)
);
CREATE INDEX IF NOT EXISTS mcp_endpoint_identities_expiry ON mcp_endpoint_identities(expires_at);

CREATE TABLE IF NOT EXISTS mcp_gateway_runs (
  run_id UUID PRIMARY KEY,
  lease_expires_at TIMESTAMPTZ NOT NULL
);
CREATE TABLE IF NOT EXISTS mcp_security_events (
  owner_id TEXT NOT NULL,
  id UUID NOT NULL,
  action_id UUID NOT NULL,
  parent_action_id UUID,
  bridge_id TEXT,
  started_at TIMESTAMPTZ NOT NULL,
  event JSONB NOT NULL,
  run_id UUID NOT NULL,
  PRIMARY KEY(owner_id, id)
);
CREATE INDEX IF NOT EXISTS mcp_security_events_owner_newest
  ON mcp_security_events(owner_id, started_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS mcp_security_events_owner_bridge_newest
  ON mcp_security_events(owner_id, bridge_id, started_at DESC, id DESC);

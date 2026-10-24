-- Additive security state only. Existing user/OAuth/bridge rows are untouched.
-- The migrator runs each file transactionally; bound waiting for DDL locks.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

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

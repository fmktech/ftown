-- MCP OAuth state is shared across gateway replicas. Token/code keys are SHA-256 hashes.
CREATE TABLE IF NOT EXISTS mcp_oauth_records (
  kind TEXT NOT NULL CHECK (kind IN ('client', 'pending', 'code', 'grant', 'access', 'refresh')),
  key TEXT NOT NULL,
  data JSONB NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (kind, key)
);
CREATE INDEX IF NOT EXISTS mcp_oauth_records_expiry ON mcp_oauth_records(expires_at);

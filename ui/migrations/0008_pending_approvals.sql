-- Additive only: no legacy row, constraint or pairing representation changes.
-- Caller owns one transaction for this DDL and its migration tracking row.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
CREATE TABLE IF NOT EXISTS security_pending_approvals (
  request_id TEXT PRIMARY KEY,
  target_sub TEXT NOT NULL,
  owner_id TEXT,
  candidate_token_hash TEXT NOT NULL,
  create_digest TEXT NOT NULL,
  request JSONB NOT NULL,
  state JSONB NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  operations JSONB NOT NULL DEFAULT '{}'::jsonb,
  final_head JSONB,
  pair_device_code TEXT UNIQUE,
  pair_metadata JSONB,
  credential_snapshot JSONB,
  refresh_predecessor JSONB,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  target_slot INTEGER NOT NULL CHECK (target_slot BETWEEN 0 AND 127),
  global_slot INTEGER NOT NULL UNIQUE CHECK (global_slot BETWEEN 0 AND 4095),
  UNIQUE (target_sub, target_slot)
);
CREATE INDEX IF NOT EXISTS security_pending_approvals_target_idx ON security_pending_approvals(target_sub, expires_at);
CREATE INDEX IF NOT EXISTS security_pending_approvals_expiry_idx ON security_pending_approvals(expires_at);

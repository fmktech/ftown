-- Additive account trust delivery only; no legacy row transformation or backfill.
-- New tables are empty. Nullable pairing additions are metadata-only but take
-- a brief ACCESS EXCLUSIVE lock; fail instead of waiting behind busy writers.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

CREATE TABLE IF NOT EXISTS security_account_history (
  owner_id TEXT PRIMARY KEY,
  root_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision BETWEEN 0 AND 1024),
  head TEXT NOT NULL,
  history JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS security_account_enrollments (
  owner_id TEXT NOT NULL,
  request_id TEXT NOT NULL UNIQUE,
  request JSONB NOT NULL,
  bundle JSONB,
  expires_at TIMESTAMPTZ NOT NULL,
  approved_at TIMESTAMPTZ,
  slot SMALLINT NOT NULL CHECK (slot BETWEEN 0 AND 127),
  PRIMARY KEY(owner_id,request_id),
  UNIQUE(owner_id,slot)
);
CREATE INDEX IF NOT EXISTS security_account_enrollments_expiry ON security_account_enrollments(expires_at);

ALTER TABLE pairing_requests ADD COLUMN IF NOT EXISTS enrollment JSONB;
ALTER TABLE pairing_requests ADD COLUMN IF NOT EXISTS account_approval JSONB;

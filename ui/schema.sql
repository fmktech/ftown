CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Fresh-install schema, equivalent to applying migrations/0001..0011 (passkey ledger).
-- Fresh installs apply this file; existing databases use ui/scripts/migrate.mjs.

-- Generic scope-keyed rate limiter (e.g. push, nonce and pair routes). UNLOGGED:
-- counters are throwaway, so skip WAL (truncated on crash recovery, not replicated).
CREATE UNLOGGED TABLE rate_limit_attempts (
  scope        TEXT        NOT NULL,
  key          TEXT        NOT NULL,
  failed_count INTEGER     NOT NULL DEFAULT 0,
  locked_until TIMESTAMPTZ,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (scope, key)
);

CREATE TABLE IF NOT EXISTS accounts (
  account_id TEXT PRIMARY KEY,
  handle TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS account_ledger (
  account_id TEXT PRIMARY KEY REFERENCES accounts(account_id) ON DELETE CASCADE,
  revision INTEGER NOT NULL,
  head TEXT NOT NULL,
  ledger JSONB NOT NULL,
  sticky JSONB NOT NULL DEFAULT '{"deviceIds":[],"bridgeIds":[]}',
  version INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE account_ledger ADD COLUMN IF NOT EXISTS sticky JSONB NOT NULL DEFAULT '{"deviceIds":[],"bridgeIds":[]}';
ALTER TABLE account_ledger ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 0;
CREATE UNIQUE INDEX IF NOT EXISTS accounts_singleton ON accounts ((true));
CREATE TABLE IF NOT EXISTS auth_nonces (
  nonce_hash TEXT PRIMARY KEY,
  purpose TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS auth_nonces_expiry ON auth_nonces(expires_at);
CREATE TABLE IF NOT EXISTS pair_mailbox (
  request_id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
  sealed TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS pair_mailbox_expiry ON pair_mailbox(expires_at);

CREATE TABLE IF NOT EXISTS security_endpoint_directory (
  account_id TEXT NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
  endpoint_id TEXT NOT NULL,
  bridge_id TEXT,
  entry JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY(account_id, endpoint_id)
);
CREATE INDEX IF NOT EXISTS security_endpoint_directory_account_bridge
  ON security_endpoint_directory(account_id, bridge_id);

CREATE TABLE IF NOT EXISTS security_device_display_names (
  account_id TEXT NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('browser', 'bridge')),
  target_id TEXT NOT NULL,
  display_name TEXT NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 80),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY(account_id, kind, target_id)
);

CREATE TABLE IF NOT EXISTS push_subscriptions (
  endpoint_hash TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
  endpoint TEXT NOT NULL,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  slot SMALLINT NOT NULL CHECK (slot BETWEEN 1 AND 10),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(account_id, slot)
);
CREATE TABLE IF NOT EXISTS push_events (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
  bridge_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  event_key TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('question','idle')),
  payload JSONB NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(account_id, bridge_id, session_id, event_key)
);
CREATE TABLE IF NOT EXISTS push_deliveries (
  event_id TEXT NOT NULL REFERENCES push_events(id) ON DELETE CASCADE,
  endpoint_hash TEXT NOT NULL REFERENCES push_subscriptions(endpoint_hash) ON DELETE CASCADE,
  sent_at TIMESTAMPTZ,
  lease_token TEXT,
  lease_until TIMESTAMPTZ,
  PRIMARY KEY(event_id, endpoint_hash)
);


-- Passkey ledger migration. Single-user product: no backward compatibility.
-- Old account data (users, refresh tokens, pairing, account history, pending
-- approvals) is DROPPED, and tables keyed by owner_id/sub are dropped and
-- recreated keyed by account_id (rows are not migrated).
--
-- Idempotent: the destructive rekey steps run only while the old identity
-- column still exists, so a re-run never wipes data written after migration.
-- The migration runner (ui/scripts/migrate.mjs) wraps this file in a single
-- transaction, so this file must NOT open its own BEGIN/COMMIT.
-- schema.sql holds the equivalent fresh-install definitions.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

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

-- Rekey: drop old-shaped tables (and their rows) only if they still carry the
-- old identity column, then recreate with account_id.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema = current_schema() AND table_name = 'security_endpoint_directory' AND column_name = 'owner_id') THEN
    DROP TABLE security_endpoint_directory CASCADE;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema = current_schema() AND table_name = 'security_device_display_names' AND column_name = 'owner_id') THEN
    DROP TABLE security_device_display_names CASCADE;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema = current_schema() AND table_name IN ('push_subscriptions', 'push_events') AND column_name = 'sub') THEN
    DROP TABLE IF EXISTS push_deliveries CASCADE;
    DROP TABLE IF EXISTS push_events CASCADE;
    DROP TABLE IF EXISTS push_subscriptions CASCADE;
  END IF;
END $$;

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

-- Drop the password/refresh/pairing/trust-history machinery. The generic
-- rate_limit_attempts table is KEPT (also used by push and nonce/pair routes);
-- only the login/register-scope rows, used solely by the dropped password flow,
-- are cleared.
DROP TABLE IF EXISTS security_pending_approvals;
DROP TABLE IF EXISTS security_account_enrollments;
DROP TABLE IF EXISTS security_account_history;
DROP TABLE IF EXISTS pairing_requests;
DROP TABLE IF EXISTS bridge_refresh;
DROP TABLE IF EXISTS users;
DELETE FROM rate_limit_attempts WHERE scope IN ('login', 'register');

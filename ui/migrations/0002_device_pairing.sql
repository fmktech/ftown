-- Device pairing (bridge onboarding) migration.
--
-- Adds pairing_requests: the OAuth-device-authorization-style bridge
-- onboarding flow (see docs/plans/device-pairing-contract.md). Also extends
-- bridge_refresh (added by 0001_auth_hardening.sql) with hostname/last_seen
-- so the devices list can show what's paired without another join.
--
-- Apply against an existing database. schema.sql holds the equivalent
-- fresh-install definitions.
--
-- Idempotent: safe to re-run, and safe whether or not bridge_refresh already
-- has these columns. The migration runner (ui/scripts/migrate.mjs) wraps this
-- file in a single transaction, so this file must NOT open its own
-- BEGIN/COMMIT.

CREATE TABLE IF NOT EXISTS pairing_requests (
  device_code   text PRIMARY KEY,          -- high-entropy secret (poll credential)
  user_code     text NOT NULL UNIQUE,      -- human code, XXXX-XXXX
  bridge_id     text NOT NULL,
  hostname      text,
  platform      text,
  status        text NOT NULL DEFAULT 'pending', -- pending|approved|denied|consumed
  sub           text,                       -- set on approve
  refresh_jti   text,                       -- set on approve
  created_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  approved_at   timestamptz
);

CREATE INDEX IF NOT EXISTS idx_pairing_user_code ON pairing_requests(user_code);

ALTER TABLE bridge_refresh ADD COLUMN IF NOT EXISTS hostname  text;
ALTER TABLE bridge_refresh ADD COLUMN IF NOT EXISTS last_seen timestamptz;

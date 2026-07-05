-- Auth hardening migration (audit findings F3 + F4).
--
-- F4: generalize the login-only rate limiter into a scope-keyed table so that
--     registration abuse can reuse the same mechanism without colliding with
--     login counters. Existing login_attempts rows are migrated to scope 'login'.
-- F3: per-bridge refresh-token rotation state (current jti).
--
-- Apply against an existing database. schema.sql holds the equivalent
-- fresh-install definitions.

BEGIN;

CREATE TABLE IF NOT EXISTS rate_limit_attempts (
  scope        TEXT        NOT NULL,
  key          TEXT        NOT NULL,
  failed_count INTEGER     NOT NULL DEFAULT 0,
  locked_until TIMESTAMPTZ,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (scope, key)
);

-- Migrate existing login attempt counters (no-op if login_attempts is absent).
INSERT INTO rate_limit_attempts (scope, key, failed_count, locked_until, updated_at)
SELECT 'login', email, failed_count, locked_until, updated_at
FROM login_attempts
ON CONFLICT (scope, key) DO NOTHING;

DROP TABLE IF EXISTS login_attempts;

CREATE TABLE IF NOT EXISTS bridge_refresh (
  bridge_id   TEXT        PRIMARY KEY,
  sub         TEXT        NOT NULL,
  current_jti TEXT        NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMIT;

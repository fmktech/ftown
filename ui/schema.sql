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

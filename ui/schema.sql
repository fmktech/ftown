CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE users (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  email      TEXT        NOT NULL UNIQUE,
  password_hash TEXT     NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_users_email ON users(email);

-- Scope-keyed rate limiter shared by login (scope 'login', key = email) and
-- registration (scope 'register', key = client IP).
CREATE TABLE rate_limit_attempts (
  scope        TEXT        NOT NULL,
  key          TEXT        NOT NULL,
  failed_count INTEGER     NOT NULL DEFAULT 0,
  locked_until TIMESTAMPTZ,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (scope, key)
);

-- Per-bridge refresh-token rotation state: the current accepted jti. A refresh
-- token is only honored when its jti matches, and each use rotates it.
CREATE TABLE bridge_refresh (
  bridge_id   TEXT        PRIMARY KEY,
  sub         TEXT        NOT NULL,
  current_jti TEXT        NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

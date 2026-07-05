// Create the schema the UI expects. Connects straight to the Postgres container
// over TCP (NOT through the neon shim). Idempotent.
//
// users:               ui/src/app/api/auth/register/route.ts + ui/src/lib/auth.ts
// rate_limit_attempts: ui/src/lib/login-rate-limit.ts (login + register)
// bridge_refresh:      ui/src/app/api/auth/bridge/refresh/route.ts (jti rotation)
// Mirrors ui/schema.sql (kept in sync with the auth-hardening migration).
import pg from "pg";

const { Client } = pg;

const client = new Client({
  host: process.env.PGHOST ?? "localhost",
  port: Number(process.env.PGPORT ?? 5432),
  user: process.env.PGUSER ?? "ftown",
  password: process.env.PGPASSWORD ?? "ftown",
  database: process.env.PGDATABASE ?? "ftown",
});

const DDL = `
CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text UNIQUE NOT NULL,
  password_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS rate_limit_attempts (
  scope text NOT NULL,
  key text NOT NULL,
  failed_count integer NOT NULL DEFAULT 0,
  locked_until timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (scope, key)
);

CREATE TABLE IF NOT EXISTS bridge_refresh (
  bridge_id text PRIMARY KEY,
  sub text NOT NULL,
  current_jti text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
`;

await client.connect();
await client.query(DDL);
await client.end();
console.log("[setup-db] schema ready (users, rate_limit_attempts, bridge_refresh)");

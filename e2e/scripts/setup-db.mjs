// Create the schema the UI expects on the isolated e2e Postgres. Connects
// straight to the Postgres container over TCP (NOT through the neon shim).
//
// It models a PRODUCTION upgrade, not a fresh install: it first creates the
// pre-migration v1 base tables (users, bridge_refresh, pairing_requests, …),
// then applies ui/migrations/0005…0011 in order, each in its own transaction
// exactly like ui/scripts/migrate.mjs does, and finally re-applies 0011 to
// prove it is idempotent. Separately it loads ui/schema.sql (the fresh-install
// definition) into a scratch schema and drops it, so both paths are executed
// against a real PostgreSQL.
//
//   node scripts/setup-db.mjs           # idempotent setup
//   node scripts/setup-db.mjs --reset   # DROP the public schema first (one account per server:
//                                       # every full run needs an empty database)
import pg from "pg";
import { readFile } from "node:fs/promises";

const { Client } = pg;

const host = process.env.PGHOST ?? "localhost";
if (!["localhost", "127.0.0.1", "::1"].includes(host)) throw new Error("E2E setup requires its isolated loopback PostgreSQL instance");
const client = new Client({
  host,
  port: Number(process.env.PGPORT ?? 5432),
  user: process.env.PGUSER ?? "ftown",
  password: process.env.PGPASSWORD ?? "ftown",
  database: process.env.PGDATABASE ?? "ftown",
});

const read = (name) => readFile(new URL(`../../ui/${name}`, import.meta.url), "utf8");
const MIGRATIONS = [
  "0005_web_push.sql",
  "0006_endpoint_security.sql",
  "0007_account_trust.sql",
  "0008_pending_approvals.sql",
  "0009_device_display_names.sql",
  "0010_drop_mcp.sql",
  "0011_passkey_ledger.sql",
];

// v1 base tables that predate the numbered migrations in this harness (as in the old setup).
const BASE_DDL = `
CREATE EXTENSION IF NOT EXISTS pgcrypto;
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
ALTER TABLE bridge_refresh ADD COLUMN IF NOT EXISTS hostname text;
ALTER TABLE bridge_refresh ADD COLUMN IF NOT EXISTS last_seen timestamptz;
CREATE TABLE IF NOT EXISTS pairing_requests (
  device_code text PRIMARY KEY,
  user_code text UNIQUE NOT NULL,
  bridge_id text NOT NULL,
  hostname text,
  platform text,
  status text NOT NULL DEFAULT 'pending',
  sub text,
  refresh_jti text,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  approved_at timestamptz
);
`;

async function inTransaction(label, sql) {
  await client.query("BEGIN");
  try {
    await client.query(sql);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw new Error(`[setup-db] ${label} failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

await client.connect();
try {
  if (process.argv.includes("--reset")) {
    await client.query("DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;");
    console.log("[setup-db] public schema reset");
  }
  const { rows } = await client.query("SELECT to_regclass('public.accounts') AS accounts");
  if (rows[0].accounts === null) {
    await client.query(BASE_DDL);
    // A v1 row that the passkey migration must drop with its table.
    await client.query("INSERT INTO users (email, password_hash) VALUES ('legacy@ftown.test', 'x') ON CONFLICT DO NOTHING");
    for (const name of MIGRATIONS) await inTransaction(name, await read(`migrations/${name}`));
    console.log(`[setup-db] applied ${MIGRATIONS.join(", ")}`);
  } else {
    console.log("[setup-db] passkey schema already present");
  }
  // Re-running the passkey migration must be a no-op (it is documented idempotent).
  await inTransaction("0011_passkey_ledger.sql (re-run)", await read("migrations/0011_passkey_ledger.sql"));
  const legacy = await client.query("SELECT to_regclass('public.users') AS users, to_regclass('public.bridge_refresh') AS refresh");
  if (legacy.rows[0].users !== null || legacy.rows[0].refresh !== null) throw new Error("[setup-db] 0011 left v1 tables behind");

  // Fresh-install path: ui/schema.sql must load on an empty schema.
  const schemaSql = await read("schema.sql");
  await client.query("DROP SCHEMA IF EXISTS e2e_fresh_install CASCADE; CREATE SCHEMA e2e_fresh_install;");
  try {
    await inTransaction("schema.sql (fresh install)", `SET LOCAL search_path TO e2e_fresh_install, public;\n${schemaSql}`);
  } finally {
    await client.query("DROP SCHEMA IF EXISTS e2e_fresh_install CASCADE");
  }
} finally {
  await client.end();
}
console.log("[setup-db] schema ready (passkey ledger, push, endpoint directory, device names); schema.sql verified");

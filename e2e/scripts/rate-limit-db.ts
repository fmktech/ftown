// ROOT EXECUTION ONLY, after isolated DB/resource preflight. From e2e/:
// ../bridge/node_modules/.bin/tsx scripts/rate-limit-db.ts
// DATABASE_URL and MIGRATION_DATABASE_URL must explicitly name the same local fixture DB.
import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import type { PoolClient } from "pg";

interface Config { maxAttempts: number; lockoutMs: number }
interface Result { allowed: boolean; retryAfterMs?: number }
interface Limiter {
  consumeRateLimit(scope: string, key: string, config: Config): Promise<Result>;
  recordAttempt(scope: string, key: string, config: Config): Promise<void>;
}

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const raw = process.env.DATABASE_URL;
assert.ok(raw && process.env.MIGRATION_DATABASE_URL === raw, "Explicit matching fixture database selectors required");
const url = new URL(raw);
assert.ok(["postgres:", "postgresql:"].includes(url.protocol));
assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(url.hostname));
assert.equal(url.port || "5432", "5432");
assert.equal(decodeURIComponent(url.pathname.slice(1)), "ftown");
assert.equal(decodeURIComponent(url.username), "ftown");
assert.equal(url.search, ""); assert.equal(url.hash, "");
for (const [key, expected] of [["PGPORT", "5432"], ["PGDATABASE", "ftown"], ["PGUSER", "ftown"]] as const) {
  if (process.env[key] !== undefined) assert.equal(process.env[key], expected);
}
if (process.env.PGHOST !== undefined) assert.ok(["localhost", "127.0.0.1", "::1"].includes(process.env.PGHOST));
for (const key of ["PGOPTIONS", "PGSERVICE", "PGSERVICEFILE"]) assert.ok(!process.env[key]);

const requireE2e = createRequire(resolve(repo, "e2e/package.json"));
const requireUi = createRequire(resolve(repo, "ui/package.json"));
const pg = requireE2e("./node_modules/pg/lib/index.js") as typeof import("pg");
const ts = requireUi("typescript") as typeof import("typescript");
const schema = `ftown_admission_${randomBytes(10).toString("hex")}`;
assert.match(schema, /^ftown_admission_[a-f0-9]{20}$/);
const connection = {
  host: url.hostname.replace(/^\[|\]$/g, ""), port: 5432, database: "ftown", user: "ftown",
  password: decodeURIComponent(url.password), ssl: false, connectionTimeoutMillis: 5000,
  query_timeout: 10000, statement_timeout: 5000, application_name: "ftown-security-admission-acceptance",
};
const admin = new pg.Client(connection);
const pool = new pg.Pool({ ...connection, max: 24, options: `-c search_path=${schema},pg_catalog -c lock_timeout=5000` });
const activeClient = new AsyncLocalStorage<PoolClient>();
let created = false;
try {
  await admin.connect();
  const selected = await admin.query("SELECT current_database() AS db,current_user AS username");
  assert.deepEqual(selected.rows[0], { db: "ftown", username: "ftown" });
  await admin.query(`CREATE SCHEMA "${schema}"`); created = true;
  assert.equal((await pool.query("SELECT current_schema() AS schema")).rows[0].schema, schema);
  const canonicalSchema = readFileSync(resolve(repo, "ui/schema.sql"), "utf8");
  const table = canonicalSchema.match(/CREATE (?:UNLOGGED )?TABLE(?: IF NOT EXISTS)? rate_limit_attempts\s*\([\s\S]*?\n\);/);
  assert.ok(table, "Canonical rate-limit table must exist");
  await pool.query(table[0]);

  // Execute the real source and SQL. Only the database transport is adapted to
  // schema-scoped pg clients; no query or limiter logic is copied into the test.
  const exported: Record<string, unknown> = {};
  const query = async (text: string, params: unknown[] = []) => {
    const client = activeClient.getStore();
    assert.ok(client, "Every production call must own an independent test DB client");
    return (await client.query(text, params)).rows as Record<string, unknown>[];
  };
  const source = readFileSync(resolve(repo, "ui/src/lib/login-rate-limit.ts"), "utf8");
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } });
  runInNewContext(compiled.outputText, {
    exports: exported,
    require: (specifier: string) => {
      assert.equal(specifier, "@/lib/db", "Unexpected limiter dependency");
      return { getDb: () => ({ query }) };
    },
  }, { filename: "login-rate-limit.acceptance.cjs" });
  assert.equal(typeof exported.consumeRateLimit, "function");
  assert.equal(typeof exported.recordAttempt, "function");
  const limiter = exported as unknown as Limiter;
  const withClient = async <T>(action: () => Promise<T>): Promise<T> => {
    const client = await pool.connect();
    try { return await activeClient.run(client, action); }
    finally { client.release(); }
  };
  const config = { maxAttempts: 7, lockoutMs: 600_000 };
  const clients = await Promise.all(Array.from({ length: 24 }, () => pool.connect()));
  try {
    const backends = await Promise.all(clients.map(async (client) => (await client.query("SELECT pg_backend_pid() AS pid")).rows[0].pid as number));
    assert.equal(new Set(backends).size, 24, "Concurrency must use independent database clients");
    const admitted = await Promise.all(clients.map((client) => activeClient.run(client, () => limiter.consumeRateLimit("concurrent", "shared", config))));
    assert.equal(admitted.filter((result) => result.allowed).length, 7);
    assert.equal(admitted.filter((result) => !result.allowed).length, 17);
    for (const result of admitted.filter((result) => !result.allowed)) {
      assert.ok(Number.isInteger(result.retryAfterMs) && result.retryAfterMs! > 0 && result.retryAfterMs! <= config.lockoutMs);
    }
  } finally { for (const client of clients) client.release(); }

  const before = (await pool.query("SELECT failed_count,locked_until FROM rate_limit_attempts WHERE scope=$1 AND key=$2", ["concurrent", "shared"])).rows[0];
  assert.equal(before.failed_count, 8);
  for (let index = 0; index < 5; index++) {
    assert.equal((await withClient(() => limiter.consumeRateLimit("concurrent", "shared", config))).allowed, false);
  }
  const after = (await pool.query("SELECT failed_count,locked_until FROM rate_limit_attempts WHERE scope=$1 AND key=$2", ["concurrent", "shared"])).rows[0];
  assert.equal(after.failed_count, 8);
  assert.equal(after.locked_until.getTime(), before.locked_until.getTime(), "Denied calls must not extend the window");

  for (const state of ["expired", "legacy-null"]) {
    await pool.query(`INSERT INTO rate_limit_attempts(scope,key,failed_count,locked_until)
      VALUES($1,$2,500,${state === "expired" ? "NOW()-INTERVAL '1 second'" : "NULL"})`, [state, "reset"]);
    assert.equal((await withClient(() => limiter.consumeRateLimit(state, "reset", config))).allowed, true);
    const reset = (await pool.query("SELECT failed_count,locked_until>NOW() AS future FROM rate_limit_attempts WHERE scope=$1 AND key=$2", [state, "reset"])).rows[0];
    assert.deepEqual(reset, { failed_count: 1, future: true });
  }
  assert.equal((await withClient(() => limiter.consumeRateLimit("single", "shared", { maxAttempts: 1, lockoutMs: 600_000 }))).allowed, true);
  assert.equal((await withClient(() => limiter.consumeRateLimit("single", "shared", { maxAttempts: 1, lockoutMs: 600_000 }))).allowed, false);
  assert.equal((await withClient(() => limiter.consumeRateLimit("other-scope", "shared", { maxAttempts: 1, lockoutMs: 600_000 }))).allowed, true);
  await pool.query("INSERT INTO rate_limit_attempts(scope,key,failed_count,locked_until) VALUES($1,$2,500,NOW()-INTERVAL '1 second')", ["legacy-failure", "reset"]);
  await withClient(() => limiter.recordAttempt("legacy-failure", "reset", { maxAttempts: 10, lockoutMs: 3_600_000 }));
  const legacy = (await pool.query("SELECT failed_count,locked_until FROM rate_limit_attempts WHERE scope=$1 AND key=$2", ["legacy-failure", "reset"])).rows[0];
  assert.deepEqual(legacy, { failed_count: 1, locked_until: null });
  console.log("PASS: real PostgreSQL exact concurrent admission, bounded retry, saturation, fixed expiry, legacy reset and scope isolation.");
} finally {
  await pool.end();
  try {
    if (created) {
      await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
      assert.equal((await admin.query("SELECT EXISTS(SELECT 1 FROM pg_namespace WHERE nspname=$1) AS present", [schema])).rows[0].present, false);
      console.log("Verified owned admission-test schema removed.");
    }
  } finally { await admin.end(); }
}

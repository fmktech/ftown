// Root-only DB repro, in the task-owned Linux sandbox after local DB preflight.
// FTOWN_PUSH_REPRO_ALLOW=local-ftown-ci node --experimental-strip-types docs/investigations/update-dialog/push-repro.ts
// Uses real PushStore and migration 0005 in a unique temporary schema; no real account rows or HTTP services.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
const root = process.cwd();
if (process.env.FTOWN_PUSH_REPRO_ALLOW !== "local-ftown-ci") throw new Error("Requires explicit local sandbox preflight sentinel");
const host = process.env.PGHOST ?? "localhost", port = Number(process.env.PGPORT ?? 5432), user = process.env.PGUSER ?? "ftown", database = process.env.PGDATABASE ?? "ftown";
if (!["localhost", "127.0.0.1", "::1"].includes(host) || port !== 5432 || user !== "ftown" || database !== "ftown" || process.env.PGSERVICE || process.env.PGOPTIONS) throw new Error("Unexpected PostgreSQL selector");
for (const key of ["DATABASE_URL", "MIGRATION_DATABASE_URL"]) {
  const value = process.env[key]; if (!value) continue;
  const url = new URL(value);
  if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || (url.port && url.port !== "5432") || url.pathname !== "/ftown" || decodeURIComponent(url.username) !== "ftown") throw new Error(`Unexpected ${key} selector`);
}
const pg = createRequire(resolve(root, "e2e/package.json"))("pg");
const esbuild = createRequire(resolve(root, "bridge/package.json"))("esbuild");
const uiRequire = createRequire(resolve(root, "ui/package.json"));
const bundle = await esbuild.build({ entryPoints: [resolve(root, "ui/src/lib/push-store.ts")], tsconfig: resolve(root, "ui/tsconfig.json"), bundle: true, packages: "external", platform: "node", format: "cjs", write: false });
const module = { exports: {} };
new Function("require", "module", "exports", bundle.outputFiles[0].text)(uiRequire, module, module.exports);
const { PushStore } = module.exports;
const connection = { host, port, user, database, password: process.env.PGPASSWORD ?? "ftown" };
const admin = new pg.Client(connection);
const schema = `push_ci_${randomUUID().replaceAll("-", "")}`;
let pool, created = false;
try {
  await admin.connect();
  const identity = await admin.query("SELECT current_database() AS db, current_user AS usr, inet_server_addr()::text AS addr");
  const row = identity.rows[0];
  if (row.db !== "ftown" || row.usr !== "ftown") throw new Error("Connected database identity is not the local isolated fixture");
  console.log(JSON.stringify({ connectedDatabase: row.db, connectedUser: row.usr, serverAddress: row.addr, clientHost: host }));
  await admin.query(`CREATE SCHEMA "${schema}"`); created = true;
  pool = new pg.Pool({ ...connection, max: 2, options: `-c search_path=${schema},pg_catalog -c lock_timeout=5000` });
  await pool.query(await readFile(resolve(root, "ui/migrations/0005_web_push.sql"), "utf8"));
  const clients = await Promise.all([pool.connect(), pool.connect()]);
  try {
    await clients[0].query("INSERT INTO push_subscriptions(endpoint_hash,sub,endpoint,p256dh,auth,slot,created_at) VALUES($1,$2,$3,$4,$5,1,$6::timestamptz)", ["original-endpoint", "fixture-owner", "https://example.test/original", "p256dh", "auth", "2025-01-01T00:00:00.000Z"]);
    const runs = 50; let uniqueViolations = 0, otherFailures = 0, successfulPairs = 0;
    for (let round = 0; round < runs; round++) {
      let waiting = 0, release;
      const gate = new Promise(resolveGate => { release = resolveGate; });
      const stores = clients.map(client => new PushStore(async (text, params) => {
        if (text.includes("INSERT INTO push_events")) { if (++waiting === 2) release(); await gate; }
        return (await client.query(text, params)).rows;
      }));
      const event = { sessionId: "fixture-session", eventKey: `question:${round}`, kind: "question", occurredAt: "2026-01-01T00:00:00.000Z", sessionName: "FTown", title: "FTown attention", message: "Open FTown to view details." };
      const results = await Promise.allSettled(stores.map(store => store.ingest("fixture-owner", "fixture-bridge", event)));
      if (results.every(result => result.status === "fulfilled")) successfulPairs++;
      for (const result of results) if (result.status === "rejected") {
        if (result.reason?.code === "23505" && result.reason?.constraint === "push_events_sub_bridge_id_session_id_event_key_key") uniqueViolations++;
        else { otherFailures++; console.error(JSON.stringify({ round, code: result.reason?.code, constraint: result.reason?.constraint, message: result.reason?.message })); }
      }
    }
    const counts = await clients[0].query("SELECT (SELECT COUNT(*)::int FROM push_events) AS events,(SELECT COUNT(*)::int FROM push_deliveries) AS deliveries");
    console.log(JSON.stringify({ rounds: runs, successfulPairs, uniqueViolations, otherFailures, counts: counts.rows[0] }));
    const query = async (text, params) => (await clients[0].query(text, params)).rows;
    const store = new PushStore(query);
    const event = { sessionId: "fixture-session", eventKey: "question:0", kind: "question", occurredAt: "2026-01-01T00:00:00.000Z", sessionName: "FTown", title: "FTown attention", message: "Open FTown to view details." };
    await query("INSERT INTO push_subscriptions(endpoint_hash,sub,endpoint,p256dh,auth,slot,created_at) VALUES($1,$2,$3,$4,$5,2,$6::timestamptz)", ["later-endpoint", "fixture-owner", "https://example.test/later", "p256dh", "auth", "2025-01-01T00:00:00.000Z"]);
    const replay = await store.ingest("fixture-owner", "fixture-bridge", { ...event, occurredAt: "2026-02-01T00:00:00.000Z", title: "Changed", message: "Changed" });
    assert.equal(replay.event.occurredAt, event.occurredAt);
    assert.equal(replay.event.title, "FTown attention"); assert.equal(replay.event.message, "Open FTown to view details.");
    const recipients = await query("SELECT endpoint_hash FROM push_deliveries WHERE event_id=$1", [replay.id]);
    assert.deepEqual(recipients.map(row => row.endpoint_hash), ["original-endpoint"]);
    assert.deepEqual(await store.claim("other-owner", replay.id), []);
    assert.equal(await store.remaining("other-owner", replay.id), 0);
    const separate = { ...event, eventKey: "question:separate" };
    const scoped = await Promise.all([store.ingest("fixture-owner", "fixture-bridge", separate), store.ingest("fixture-owner", "other-bridge", separate), store.ingest("other-owner", "fixture-bridge", separate)]);
    assert.equal(new Set(scoped.map(item => item.id)).size, 3);
    const legacy = { ...event, eventKey: "question:legacy" };
    await query("INSERT INTO push_events(id,sub,bridge_id,session_id,event_key,kind,payload,occurred_at) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8::timestamptz)", ["legacy-id", "fixture-owner", "fixture-bridge", legacy.sessionId, legacy.eventKey, legacy.kind, JSON.stringify(legacy), legacy.occurredAt]);
    await assert.rejects(() => store.ingest("fixture-owner", "fixture-bridge", legacy), error => error?.code === "push_unavailable" && error?.status === 503);
    await assert.rejects(() => store.ingest("fixture-owner", "fixture-bridge", { ...event, eventKey: "question:invalid", kind: "invalid" }), error => error?.code === "23514");
    console.log("Edge checks passed: original recipient once, no later recipient backfill, original generic payload, cross-owner claim denied, owner/bridge separation, legacy mismatch fails closed, CHECK violation rejected.");
    if (otherFailures || uniqueViolations || counts.rows[0].events !== runs || counts.rows[0].deliveries !== runs) process.exitCode = 1;
    else console.log("No collision observed in bounded run; absence alone does not prove the race is fixed.");
  } finally { clients.forEach(client => client.release()); }
} finally {
  try { if (pool) await pool.end(); }
  finally { try { if (created) await admin.query(`DROP SCHEMA "${schema}" CASCADE`); } finally { await admin.end(); } }
}

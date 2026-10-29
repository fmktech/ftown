// ROOT EXECUTION ONLY: isolated localhost E2E Postgres after selector/resource preflight.
// From ui/: ../bridge/node_modules/.bin/tsx --tsconfig tsconfig.json ../e2e/scripts/device-display-names-db.ts
// DATABASE_URL and MIGRATION_DATABASE_URL must be identical and explicitly point at ftown/ftown@localhost:5432.
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { DeviceDisplayNameStore } from '../../ui/src/lib/device-display-name-store';
import { AccountTrustStore } from '../../ui/src/lib/account-trust-store';
import { generateEndpoint } from '../../bridge/src/security/crypto';
import { createAccountGenesis, generateAccountSigningIdentity } from '../../bridge/src/security/account-crypto';

// Use the installed runtime file directly: tsx applies the UI tsconfig's
// `pg` type-declaration alias to both import and bare require specifiers.
const pg = createRequire(import.meta.url)('../node_modules/pg/lib/index.js') as typeof import('pg');
const raw = process.env.DATABASE_URL;
assert.ok(raw && process.env.MIGRATION_DATABASE_URL === raw, 'Explicit matching database selectors required');
const url = new URL(raw);
assert.ok(['postgres:', 'postgresql:'].includes(url.protocol) && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname));
assert.equal(url.port || '5432', '5432');
assert.equal(decodeURIComponent(url.pathname.slice(1)), 'ftown');
assert.equal(decodeURIComponent(url.username), 'ftown');
assert.equal(url.search, ''); assert.equal(url.hash, '');
for (const [key, value] of [['PGPORT', '5432'], ['PGDATABASE', 'ftown'], ['PGUSER', 'ftown']] as const) if (process.env[key]) assert.equal(process.env[key], value);
if (process.env.PGHOST) assert.ok(['localhost', '127.0.0.1', '::1'].includes(process.env.PGHOST));
for (const key of ['PGOPTIONS', 'PGSERVICE', 'PGSERVICEFILE']) assert.ok(!process.env[key]);
const schema = `ftown_names_${randomBytes(10).toString('hex')}`;
const client = new pg.Client({ host: url.hostname.replace(/^\[|\]$/g, ''), port: 5432, database: 'ftown', user: 'ftown',
  password: decodeURIComponent(url.password), ssl: false, connectionTimeoutMillis: 5000, query_timeout: 10000, application_name: 'ftown-display-names-acceptance' });
let created = false;
try {
  await client.connect();
  const selected = await client.query('SELECT current_database() AS db,current_user AS username');
  assert.deepEqual(selected.rows[0], { db: 'ftown', username: 'ftown' });
  await client.query(`CREATE SCHEMA "${schema}"`); created = true;
  await client.query(`SET search_path TO "${schema}",pg_catalog`);
  assert.equal((await client.query('SELECT current_schema() AS schema')).rows[0].schema, schema);
  await client.query(`CREATE TABLE users(id uuid PRIMARY KEY,email text UNIQUE NOT NULL);
    CREATE TABLE bridge_refresh(bridge_id text PRIMARY KEY,sub text NOT NULL,current_jti text NOT NULL);
    CREATE TABLE security_account_history(owner_id text PRIMARY KEY,root_id text NOT NULL,revision integer NOT NULL,head text NOT NULL,history jsonb NOT NULL,updated_at timestamptz NOT NULL DEFAULT now())`);
  const first = randomUUID(); const second = randomUUID();
  await client.query('INSERT INTO users(id,email) VALUES($1,$2),($3,$4)', [first, 'first@ftown.test', second, 'second@ftown.test']);
  await client.query('INSERT INTO bridge_refresh(bridge_id,sub,current_jti) VALUES($1,$2,$3)', ['legacy', 'first@ftown.test', 'active']);
  const query = async (text: string, params: unknown[]) => (await client.query(text, params)).rows as Record<string, unknown>[];
  const trust = new AccountTrustStore(query);
  const identity = await generateEndpoint(first, 'browser');
  const signing = await generateAccountSigningIdentity();
  const genesis = await createAccountGenesis(first, identity.endpoint, signing, 'Browser');
  await trust.append(first, { expectedHead: null, record: genesis });
  const before = await query('SELECT root_id,revision,head,history FROM security_account_history WHERE owner_id=$1', [first]);
  const root = resolve(process.cwd(), '..');
  const up = await readFile(resolve(root, 'ui/migrations/0009_device_display_names.sql'), 'utf8');
  const down = await readFile(resolve(root, 'ui/migrations/down/0009_device_display_names.sql'), 'utf8');
  async function migrate(sql: string) { await client.query('BEGIN'); try { await client.query(sql); await client.query('COMMIT'); } catch (error) { await client.query('ROLLBACK'); throw error; } }
  await migrate(up); await migrate(up);
  const store = new DeviceDisplayNameStore(query, trust);
  assert.deepEqual((await store.list(first)).names, []);
  const browser = { kind: 'browser' as const, id: identity.endpoint.id };
  await store.set(first, { ...browser, name: 'Phone' });
  await store.set(first, { kind: 'bridge', id: 'legacy', name: 'Desk' });
  await client.query('INSERT INTO security_device_display_names(owner_id,kind,target_id,display_name) VALUES($1,$2,$3,$4)', [second, 'browser', browser.id, 'Other']);
  await store.set(first, { ...browser, name: null });
  await store.set(first, { ...browser, name: null });
  assert.equal((await client.query('SELECT count(*)::int AS n FROM security_device_display_names WHERE owner_id=$1 AND target_id=$2', [second, browser.id])).rows[0].n, 1);
  await assert.rejects(store.set(second, { ...browser, name: 'No access' }), /unknown_device/);
  await client.query('UPDATE bridge_refresh SET current_jti=$1 WHERE bridge_id=$2', ['revoked', 'legacy']);
  assert.equal((await store.list(first)).names.length, 0);
  await assert.rejects(store.set(first, { kind: 'bridge', id: 'legacy', name: 'No access' }), /unknown_device/);
  assert.deepEqual(await query('SELECT root_id,revision,head,history FROM security_account_history WHERE owner_id=$1', [first]), before);
  assert.equal((await client.query('SELECT count(*)::int AS n FROM users')).rows[0].n, 2);
  await migrate(down); await migrate(up);
  assert.deepEqual((await store.list(first)).names, []);
  assert.deepEqual(await query('SELECT root_id,revision,head,history FROM security_account_history WHERE owner_id=$1', [first]), before);
  console.log('PASS display-name isolated migration, ownership, signed trust, reset and revocation checks');
} finally {
  if (created) await client.query(`DROP SCHEMA "${schema}" CASCADE`);
  await client.end();
}

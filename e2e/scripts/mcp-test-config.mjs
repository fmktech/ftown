// Public routing configuration only. Master/approval secrets never enter this output.
import pg from 'pg';
import { readFile } from 'node:fs/promises';
import { lstatSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
async function main() {
const dir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
if (realpathSync(dir) !== dir || process.env.E2E_DIR !== dir) throw new Error('Canonical E2E directory is required');
const accounts = [
  { email: process.env.E2E_USER_EMAIL, homes: [[process.env.BRIDGE_HOME, '.bridge-home'], [process.env.E2E_SECOND_BRIDGE_HOME, '.bridge-home-2']], label: 'E2E bridge' },
  { email: process.env.E2E_MCP_USER_EMAIL, homes: [[process.env.E2E_MCP_BRIDGE_HOME, '.mcp-bridge-home'], [process.env.E2E_MCP_SECOND_BRIDGE_HOME, '.mcp-bridge-home-2']], label: 'MCP fixture bridge' },
];
if (accounts.some(account => !/^e2e[^@]*@ftown\.test$/.test(account.email ?? '')) || accounts[0].email === accounts[1].email) throw new Error('Distinct run-scoped E2E accounts are required');
for (const account of accounts) {
  account.ids = [];
  for (const [home, name] of account.homes) {
    if (home !== join(dir, name) || realpathSync(home) !== home || lstatSync(home).isSymbolicLink()) throw new Error('Exact isolated bridge homes are required');
    const pointerPath = join(home, '.ftown/bridge.json');
    if (lstatSync(join(home, '.ftown')).isSymbolicLink() || lstatSync(pointerPath).isSymbolicLink()) throw new Error('Bridge pointer must remain in its owned home');
    const pointer = JSON.parse(await readFile(pointerPath, 'utf8'));
    if (typeof pointer.bridgeId !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(pointer.bridgeId)) throw new Error('Authenticated bridge IDs are required');
    account.ids.push(pointer.bridgeId);
  }
}
if (new Set(accounts.flatMap(account => account.ids)).size !== 4) throw new Error('Four independent bridge IDs are required');
const databaseUrl = new URL(process.env.DATABASE_URL);
if (!['postgres:', 'postgresql:'].includes(databaseUrl.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(databaseUrl.hostname)
  || (databaseUrl.port || '5432') !== '5432' || databaseUrl.pathname !== '/ftown' || databaseUrl.username !== 'ftown' || databaseUrl.search || databaseUrl.hash) throw new Error('MCP E2E configuration requires the exact isolated loopback database');
if (process.env.FTOWN_MCP_PUBLIC_URL !== 'https://localhost:8443' || process.env.FTOWN_PUBLIC_URL !== 'https://localhost:8444') throw new Error('Exact isolated TLS API origins are required');
const db = new pg.Client({ connectionString: databaseUrl.href, connectionTimeoutMillis: 5000, query_timeout: 10000, statement_timeout: 5000 });
await db.connect();
try {
  const selector = (await db.query('SELECT current_database() AS database,current_user AS username')).rows[0];
  if (selector.database !== 'ftown' || selector.username !== 'ftown') throw new Error('Unexpected PostgreSQL selector');
  const access = [];
  for (const account of accounts) {
    const result = await db.query("SELECT u.id::text AS id,b.bridge_id FROM users u JOIN bridge_refresh b ON b.sub=u.email WHERE u.email=$1 AND b.bridge_id=ANY($2::text[]) AND b.current_jti<>'revoked'", [account.email, account.ids]);
    if (result.rows.length !== 2 || new Set(result.rows.map(row => row.id)).size !== 1 || result.rows.some(row => !/^[a-f0-9-]{36}$/i.test(row.id))) throw new Error('E2E bridge ownership is unavailable');
    access.push({ subject: result.rows[0].id, machines: account.ids });
  }
  if (access[0].subject === access[1].subject) throw new Error('Dedicated MCP account must have an independent UUID');
  process.stdout.write(JSON.stringify({ publicUrl: process.env.FTOWN_MCP_PUBLIC_URL, loginUrl: process.env.FTOWN_PUBLIC_URL, allowedOrigins: [],
    fleet: { concurrency: 4, timeoutMs: 15000, machines: accounts.flatMap(account => account.ids.map((id, index) => ({ id, label: `${account.label} ${index + 1}`, transport: 'relay', userId: account.email }))) }, access }));
} finally { await db.end(); }
}
main().catch(() => { console.error('MCP E2E configuration unavailable; fixture details suppressed.'); process.exitCode = 1; });

// Public routing configuration only. Master/approval secrets never enter this output.
import pg from 'pg';
import { readFile } from 'node:fs/promises';
const email = process.env.E2E_USER_EMAIL;
const home = process.env.BRIDGE_HOME;
if (!email || !home) throw new Error('E2E user and bridge home are required');
const pointer = JSON.parse(await readFile(`${home}/.ftown/bridge.json`, 'utf8'));
const second = JSON.parse(await readFile(`${process.env.E2E_SECOND_BRIDGE_HOME}/.ftown/bridge.json`, 'utf8'));
const databaseUrl = new URL(process.env.DATABASE_URL);
if (!['localhost', '127.0.0.1', '[::1]'].includes(databaseUrl.hostname)) throw new Error('MCP E2E configuration requires the isolated loopback database');
const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
await db.connect();
try {
  const ids = [pointer.bridgeId, second.bridgeId];
  const result = await db.query("SELECT u.id::text AS id,b.bridge_id FROM users u JOIN bridge_refresh b ON b.sub=u.email WHERE u.email=$1 AND b.bridge_id=ANY($2::text[]) AND b.current_jti<>'revoked'", [email, ids]);
  if (result.rows.length !== 2 || new Set(result.rows.map(row => row.id)).size !== 1 || new Set(ids).size !== 2) throw new Error('E2E bridge ownership is unavailable');
  process.stdout.write(JSON.stringify({ publicUrl: process.env.FTOWN_MCP_PUBLIC_URL, loginUrl: process.env.FTOWN_PUBLIC_URL, allowedOrigins: [], fleet: { concurrency: 4, timeoutMs: 15000, machines: ids.map((id, index) => ({ id, label: `E2E bridge ${index + 1}`, transport: 'relay', userId: email })) }, access: [{ subject: result.rows[0].id, machines: ids }] }));
} finally { await db.end(); }

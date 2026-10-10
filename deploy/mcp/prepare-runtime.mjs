// Run only in the deployment job. Never log the generated secret bundle.
import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
const require = createRequire(new URL('../../bridge/package.json', import.meta.url));
const { Client } = require('pg');

const required = ['DATABASE_URL', 'FTOWN_MCP_APPROVAL_SECRET', 'CENTRIFUGO_TOKEN_SECRET', 'FTOWN_MCP_OWNER_BRIDGE_ID', 'MCP_SECRETS_FILE'];
for (const key of required) if (!process.env[key]) throw new Error(`Missing ${key}`);
const db = new Client({ connectionString: process.env.DATABASE_URL });
await db.connect();
try {
  await db.query('SELECT 1 FROM mcp_oauth_records LIMIT 1');
  const { rows: owners } = await db.query(
    "SELECT u.id, u.email FROM users u JOIN bridge_refresh b ON b.sub=u.email WHERE b.bridge_id=$1 AND b.current_jti <> 'revoked'",
    [process.env.FTOWN_MCP_OWNER_BRIDGE_ID],
  );
  if (owners.length !== 1) throw new Error('Owner bridge must belong to exactly one active account');
  const owner = owners[0];
  const { rows: devices } = await db.query(
    "SELECT bridge_id, hostname FROM bridge_refresh WHERE sub=$1 AND current_jti <> 'revoked' ORDER BY bridge_id",
    [owner.email],
  );
  const config = {
    publicUrl: 'https://ftown-mcp.fly.dev', loginUrl: 'https://ftown.ia.br', allowedOrigins: [],
    fleet: { concurrency: 8, timeoutMs: 15000, machines: devices.map(d => ({
      id: d.bridge_id, label: d.hostname || d.bridge_id, transport: 'relay', userId: owner.email,
    })) },
    access: [{ subject: owner.id, machines: devices.map(d => d.bridge_id) }],
  };
  const secrets = {
    DATABASE_URL: process.env.DATABASE_URL,
    FTOWN_MCP_APPROVAL_SECRET: process.env.FTOWN_MCP_APPROVAL_SECRET,
    CENTRIFUGO_TOKEN_SECRET: process.env.CENTRIFUGO_TOKEN_SECRET,
    CENTRIFUGO_URL: 'wss://ftown-centrifugo.fly.dev/connection/websocket',
    FTOWN_MCP_CONFIG_JSON: JSON.stringify(config),
  };
  for (const value of Object.values(secrets)) if (/[\r\n]/.test(value)) throw new Error('Secret values must be single-line');
  writeFileSync(process.env.MCP_SECRETS_FILE, Object.entries(secrets).map(([k,v]) => `${k}=${v}`).join('\n') + '\n', { mode: 0o600 });
  console.log(`Prepared gateway configuration for ${devices.length} owned computers.`);
} finally {
  await db.end();
}

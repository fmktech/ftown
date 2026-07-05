// Minimal Neon HTTP query protocol shim.
//
// @neondatabase/serverless `neon(url)` (the HTTP driver used by ui/src/lib/db.ts)
// always POSTs to `https://<DATABASE_URL_host>/sql` on port 443 with TLS and the
// headers `Neon-Connection-String`, `Neon-Raw-Text-Output: true`,
// `Neon-Array-Mode: true`. There is no code-free way to redirect that endpoint,
// so for CI/local we stand up a tiny HTTPS server on :443 that speaks the same
// wire protocol and executes queries against a plain Postgres over TCP with `pg`.
//
// Request body: { query, params } (single) or [{ query, params }, ...] (batch).
// Response: { command, rowCount, rowAsArray, fields:[{name,dataTypeID}], rows:[[...]] }
// Raw-text output => every value is returned as its Postgres text representation
// (identity type parser); the driver re-parses client-side using dataTypeID.

import { readFileSync } from 'node:fs';
import { createServer } from 'node:https';
import pg from 'pg';

const { Pool } = pg;

const PORT = Number(process.env.SHIM_PORT ?? 443);
const CERT = process.env.SHIM_CERT ?? '/certs/cert.pem';
const KEY = process.env.SHIM_KEY ?? '/certs/key.pem';

const pool = new Pool({
  host: process.env.PGHOST ?? 'postgres',
  port: Number(process.env.PGPORT ?? 5432),
  user: process.env.PGUSER ?? 'ftown',
  password: process.env.PGPASSWORD ?? 'ftown',
  database: process.env.PGDATABASE ?? 'ftown',
  max: 10,
});

// Identity parser => keep raw Postgres text; the neon driver parses client-side.
const rawTypes = { getTypeParser: () => (val) => val };

async function runOne({ query, params }) {
  const res = await pool.query({
    text: query,
    values: params ?? [],
    rowMode: 'array',
    types: rawTypes,
  });
  return {
    command: res.command,
    rowCount: res.rowCount,
    rowAsArray: true,
    fields: res.fields.map((f) => ({ name: f.name, dataTypeID: f.dataTypeID })),
    rows: res.rows,
  };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const server = createServer(
  { cert: readFileSync(CERT), key: readFileSync(KEY) },
  async (req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200).end('ok');
      return;
    }
    if (req.method !== 'POST') {
      res.writeHead(405).end('method not allowed');
      return;
    }
    try {
      const raw = await readBody(req);
      const payload = raw ? JSON.parse(raw) : {};
      let result;
      if (Array.isArray(payload)) {
        const results = [];
        for (const q of payload) results.push(await runOne(q));
        result = { results };
      } else {
        result = await runOne(payload);
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ message: err.message, code: err.code ?? 'SHIM_ERROR' }));
    }
  },
);

server.listen(PORT, () => {
  console.log(`[neon-http-shim] listening on :${PORT} -> pg ${process.env.PGHOST ?? 'postgres'}`);
});

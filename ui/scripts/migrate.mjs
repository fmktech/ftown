#!/usr/bin/env node
// Idempotent migration runner for the ftown UI database.
//
// Applies every ui/migrations/*.sql (lexicographic order) that has not yet been
// recorded in the schema_migrations tracking table. Each pending migration runs
// inside ONE transaction together with its tracking INSERT, so a file either
// applies fully and is recorded, or rolls back and the runner exits non-zero
// (fail-loud, stops at the first failure). Safe to run repeatedly.
//
// Connection: standard Postgres TCP via `pg` (node-postgres), NOT the serverless
// HTTP driver, for portability/testability. Reads MIGRATION_DATABASE_URL, falling
// back to DATABASE_URL. The URL must be a direct `postgresql://` string.
//
// Invoked by .github/workflows/migrate.yml on push to main.

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const { Client } = pg;

const connectionString =
  process.env.MIGRATION_DATABASE_URL || process.env.DATABASE_URL;

if (!connectionString) {
  console.error(
    'migrate: neither MIGRATION_DATABASE_URL nor DATABASE_URL is set',
  );
  process.exit(1);
}

const migrationsDir = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'migrations',
);

async function main() {
  const client = new Client({ connectionString });
  await client.connect();
  try {
    await client.query(
      'CREATE TABLE IF NOT EXISTS schema_migrations (' +
        'name text PRIMARY KEY, ' +
        'applied_at timestamptz NOT NULL DEFAULT now())',
    );

    const files = readdirSync(migrationsDir)
      .filter((f) => f.endsWith('.sql'))
      .sort();

    const { rows } = await client.query('SELECT name FROM schema_migrations');
    const applied = new Set(rows.map((r) => r.name));

    for (const name of files) {
      if (applied.has(name)) {
        console.log(`skip ${name} (already applied)`);
        continue;
      }

      const sql = readFileSync(join(migrationsDir, name), 'utf8');
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query(
          'INSERT INTO schema_migrations (name) VALUES ($1)',
          [name],
        );
        await client.query('COMMIT');
        console.log(`applied ${name}`);
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        console.error(
          `migrate: failed applying ${name}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        throw err;
      }
    }
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

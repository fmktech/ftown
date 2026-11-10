import pg from "pg";

/**
 * Direct access to the throwaway fixture database (docker-compose postgres, the same selectors env.sh exports), for
 * assertions on server state and for deliberate tampering in security tests. Never point this at anything else.
 */
export async function withDb<T>(use: (db: pg.Client) => Promise<T>): Promise<T> {
  const db = new pg.Client({
    host: process.env.PGHOST ?? "localhost",
    port: Number(process.env.PGPORT ?? 5432),
    user: process.env.PGUSER ?? "ftown",
    password: process.env.PGPASSWORD ?? "ftown",
    database: process.env.PGDATABASE ?? "ftown",
  });
  await db.connect();
  try { return await use(db); } finally { await db.end(); }
}

/** account_ledger's version (one per row write) and sealed checkpoint columns for an account. */
export async function ledgerRow(db: pg.Client, accountId: string): Promise<{ version: number; checkpoint: string | null; checkpoint_mac: string | null }> {
  const { rows } = await db.query("SELECT version, checkpoint, checkpoint_mac FROM account_ledger WHERE account_id=$1", [accountId]);
  if (rows.length !== 1) throw new Error(`expected one account_ledger row for ${accountId}`);
  return rows[0] as { version: number; checkpoint: string | null; checkpoint_mac: string | null };
}

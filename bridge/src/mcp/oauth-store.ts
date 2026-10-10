import { Pool, type PoolClient } from "pg";

export interface OAuthTransaction {
  get<T>(kind: string, key: string): Promise<T | undefined>;
  put(
    kind: string,
    key: string,
    value: unknown,
    expiresAt: number,
  ): Promise<void>;
  take<T>(kind: string, key: string): Promise<T | undefined>;
  lock(key: string): Promise<void>;
  ownedMachines(subject: string): Promise<string[]>;
}
export interface OAuthStore {
  transaction<T>(fn: (tx: OAuthTransaction) => Promise<T>): Promise<T>;
}
class PgTransaction implements OAuthTransaction {
  constructor(private client: PoolClient) {}
  async get<T>(kind: string, key: string): Promise<T | undefined> {
    const result = await this.client.query(
      "SELECT data FROM mcp_oauth_records WHERE kind=$1 AND key=$2 AND expires_at > NOW()",
      [kind, key],
    );
    return result.rows[0]?.data;
  }
  async put(kind: string, key: string, value: unknown, expiresAt: number) {
    await this.client.query(
      "INSERT INTO mcp_oauth_records(kind,key,data,expires_at) VALUES($1,$2,$3,$4) ON CONFLICT(kind,key) DO UPDATE SET data=EXCLUDED.data,expires_at=EXCLUDED.expires_at",
      [kind, key, JSON.stringify(value), new Date(expiresAt * 1000)],
    );
  }
  async take<T>(kind: string, key: string): Promise<T | undefined> {
    const result = await this.client.query(
      "DELETE FROM mcp_oauth_records WHERE kind=$1 AND key=$2 AND expires_at > NOW() RETURNING data",
      [kind, key],
    );
    return result.rows[0]?.data;
  }
  async ownedMachines(subject: string): Promise<string[]> {
    const result = await this.client.query(
      "SELECT b.bridge_id FROM bridge_refresh b JOIN users u ON u.email=b.sub WHERE u.id::text=$1 AND b.current_jti <> 'revoked'",
      [subject],
    );
    return result.rows.map((r) => r.bridge_id);
  }
  async lock(key: string) {
    await this.client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
      [key],
    );
  }
}
export class PostgresOAuthStore implements OAuthStore {
  readonly pool: Pool;
  private lastPrune = 0;
  constructor(connectionString: string) {
    this.pool = new Pool({
      connectionString,
      max: 10,
      connectionTimeoutMillis: 10000,
      statement_timeout: 10000,
    });
  }
  async transaction<T>(fn: (tx: OAuthTransaction) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      if (Date.now() - this.lastPrune > 60000) {
        this.lastPrune = Date.now();
        await client.query(
          "DELETE FROM mcp_oauth_records WHERE (kind,key) IN (SELECT kind,key FROM mcp_oauth_records WHERE expires_at <= NOW() LIMIT 1000)",
        );
      }
      await client.query("BEGIN");
      const result = await fn(new PgTransaction(client));
      await client.query("COMMIT");
      return result;
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  }
}

import pg from "pg";
import { boundedDatabase } from "./capacity.js";
import { z } from "zod";

export interface Sql {
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    text: string, values?: unknown[],
  ): Promise<{ rows: T[] }>;
}
export interface Database extends Sql {
  transaction<T>(work: (tx: Sql) => Promise<T>): Promise<T>;
}
export function postgres(connectionString: string) {
  const max=z.coerce.number().int().min(1).max(100).default(10).parse(process.env.DB_POOL_MAX);
  const waiting=z.coerce.number().int().min(0).max(1000).default(64).parse(process.env.DB_MAX_WAITING);
  const pool = new pg.Pool({ connectionString, max,
    connectionTimeoutMillis: 3_000, statement_timeout: 8_000 });
  const db: Database = {
    query: (text, values) => pool.query(text, values),
    async transaction(work) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const value = await work(client);
        await client.query("COMMIT");
        return value;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally { client.release(); }
    },
  };
  return { ...boundedDatabase(db,max+waiting), close: () => pool.end() };
}

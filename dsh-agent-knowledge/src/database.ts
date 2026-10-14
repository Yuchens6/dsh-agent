import pg from "pg";
import { KnowledgeError } from "./network.js";
export interface Sql {
  query<T extends Record<string, unknown> = Record<string, unknown>>(sql: string, values?: unknown[]): Promise<{ rows: T[] }>;
}
export interface Database extends Sql { transaction<T>(work: (tx: Sql) => Promise<T>): Promise<T> }
export function postgres(connectionString: string, options: { readOnly?: boolean; max?: number; maxWaiting?: number } = {}) {
  const max = options.max ?? 8, capacity = max + (options.maxWaiting ?? 16);
  if (!Number.isInteger(max) || max < 1 || max > 64 || !Number.isInteger(capacity) || capacity < max || capacity > 256) throw new Error("Invalid database capacity");
  const pool = new pg.Pool({ connectionString, max, connectionTimeoutMillis: 3000, statement_timeout: 5000,
    options: options.readOnly === false ? undefined : "-c default_transaction_read_only=on" });
  let active = 0;
  async function admit<T>(work: () => Promise<T>) {
    if (active >= capacity) throw new KnowledgeError(503, "DEPENDENCY_UNAVAILABLE");
    active++;
    try { return await work(); } finally { active--; }
  }
  const db: Database = {
    query: (sql, values) => admit(() => pool.query(sql, values)),
    transaction: work => admit(async () => {
      const client = await pool.connect();
      try {
        await client.query("BEGIN"); const value = await work(client); await client.query("COMMIT"); return value;
      } catch (error) { await client.query("ROLLBACK"); throw error; }
      finally { client.release(); }
    }),
  };
  return { ...db, close: () => pool.end() };
}

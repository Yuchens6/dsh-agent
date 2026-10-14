import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import type { Database } from "../dsh-agent-knowledge/src/database.js";
export async function knowledgeDatabase() {
  const pg = new PGlite(); await pg.exec("CREATE SCHEMA knowledge");
  await pg.exec(await readFile(new URL("../dsh-agent-knowledge/migrations/001_retrieval.sql",import.meta.url),"utf8"));
  const db: Database = { query: (sql,values) => pg.query(sql,values), transaction: work => pg.transaction(tx => work({ query: (sql,values) => tx.query(sql,values) })) };
  return { pg,db };
}

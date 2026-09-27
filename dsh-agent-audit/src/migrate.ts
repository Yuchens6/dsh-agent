import { readFile } from "node:fs/promises";
import { postgres } from "./database.js";
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL required");
const { db, close } = postgres(process.env.DATABASE_URL);
try { await db.transaction(async tx => {
 await tx.query("SELECT pg_advisory_xact_lock(78411206)");
 await tx.query("CREATE TABLE IF NOT EXISTS audit.schema_migrations(version integer PRIMARY KEY)");
 if (!(await tx.query("SELECT version FROM audit.schema_migrations WHERE version=1")).rows.length) {
  await tx.query((await readFile(new URL("../migrations/001_initial.sql", import.meta.url), "utf8")).replace("CREATE TABLE audit.schema_migrations(version integer PRIMARY KEY);", ""));
 }
 if (!(await tx.query("SELECT version FROM audit.schema_migrations WHERE version=2")).rows.length) {
  await tx.query(await readFile(new URL("../migrations/002_producers.sql", import.meta.url), "utf8"));
 }
}); } finally { await close(); }

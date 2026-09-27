import { readFile } from "node:fs/promises";
import { postgres } from "./database.js";
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL required");
const { db, close } = postgres(process.env.DATABASE_URL);
try { await db.transaction(async tx => {
 await tx.query("SELECT pg_advisory_xact_lock(78411205)");
 await tx.query("CREATE TABLE IF NOT EXISTS quota.schema_migrations(version integer PRIMARY KEY)");
 if (!(await tx.query("SELECT version FROM quota.schema_migrations WHERE version=1")).rows.length) {
  await tx.query((await readFile(new URL("../migrations/001_initial.sql", import.meta.url), "utf8")).replace("CREATE TABLE quota.schema_migrations(version integer PRIMARY KEY);", ""));
 }
 if (!(await tx.query("SELECT version FROM quota.schema_migrations WHERE version=2")).rows.length) {
  await tx.query(await readFile(new URL("../migrations/002_usage.sql", import.meta.url), "utf8"));
 }
 if (!(await tx.query("SELECT version FROM quota.schema_migrations WHERE version=3")).rows.length) {
  await tx.query(await readFile(new URL("../migrations/003_points.sql", import.meta.url), "utf8"));
 }
}); } finally { await close(); }

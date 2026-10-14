import { readFile } from "node:fs/promises";
import { postgres } from "./database.js";
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
const { db, close } = postgres(process.env.DATABASE_URL);
try {
  await db.transaction(async tx => {
    await tx.query("SELECT pg_advisory_xact_lock(78411203)");
    await tx.query("CREATE TABLE IF NOT EXISTS catalog.schema_migrations(version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
    const result = await tx.query("SELECT version FROM catalog.schema_migrations WHERE version=1");
    if (!result.rows.length) await tx.query(await readFile(new URL("../migrations/001_initial.sql", import.meta.url), "utf8"));
    const studio = await tx.query("SELECT version FROM catalog.schema_migrations WHERE version=2");
    if (!studio.rows.length) await tx.query(await readFile(new URL("../migrations/002_studio.sql", import.meta.url), "utf8"));
  });
} finally { await close(); }

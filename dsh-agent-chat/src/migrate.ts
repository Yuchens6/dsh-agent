import { readFile } from "node:fs/promises";
import { postgres } from "./database.js";
const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required");
const { db, close } = postgres(url);
try {
  await db.transaction(async tx => {
    await tx.query("SELECT pg_advisory_xact_lock(78411201)");
    await tx.query("CREATE TABLE IF NOT EXISTS chat.schema_migrations (version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
    for (const [version, file] of [[1, "001_initial.sql"], [2, "002_execution.sql"], [3, "003_lifecycle.sql"], [4, "004_audit.sql"], [5, "005_admission.sql"]] as const) {
      const existing = await tx.query("SELECT version FROM chat.schema_migrations WHERE version=$1", [version]);
      if (!existing.rows.length) await tx.query(await readFile(new URL("../migrations/" + file, import.meta.url), "utf8"));
    }
  });
} finally { await close(); }

import { readFile } from "node:fs/promises";
import { postgres } from "./database.js";
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
const { db, close } = postgres(process.env.DATABASE_URL);
try {
  await db.transaction(async tx => {
    await tx.query("SELECT pg_advisory_xact_lock(78411204)");
    await tx.query("CREATE TABLE IF NOT EXISTS run_control.schema_migrations(version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
    for (const [version, file] of [[1, "001_initial.sql"], [2, "002_execution.sql"], [3, "003_support.sql"], [4, "004_usage.sql"], [5, "005_workflow.sql"], [6,"006_dispatch.sql"], [7,"007_progress.sql"]] as const) {
      if (!(await tx.query("SELECT version FROM run_control.schema_migrations WHERE version=$1", [version])).rows.length) {
        await tx.query(await readFile(new URL("../migrations/" + file, import.meta.url), "utf8"));
      }
    }
  });
} finally { await close(); }

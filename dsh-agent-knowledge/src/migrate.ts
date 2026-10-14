import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { postgres } from "./database.js";
const args = parseArgs({ options: { "reader-role": { type: "string", default: "knowledge_reader" } } });
const role = args.values["reader-role"]!;
if (!/^[a-z][a-z0-9_]{0,62}$/.test(role)) throw new Error("Invalid reader role");
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL must specify the knowledge schema owner");
const db = postgres(process.env.DATABASE_URL,{ readOnly: false });
try {
  const migration = await readFile(new URL("../migrations/001_retrieval.sql",import.meta.url),"utf8");
  await db.transaction(async tx => {
    // PostgreSQL checks CREATE privilege on the database even for IF NOT EXISTS.
    // A provisioned schema owner must not need permission to create other schemas.
    const schema = await tx.query("SELECT 1 FROM pg_namespace WHERE nspname='knowledge'");
    if (!schema.rows.length) await tx.query("CREATE SCHEMA knowledge");
    await tx.query(migration);
    await tx.query(`GRANT USAGE ON SCHEMA knowledge TO "${role}"`);
    await tx.query(`GRANT SELECT ON ALL TABLES IN SCHEMA knowledge TO "${role}"`);
    await tx.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA knowledge GRANT SELECT ON TABLES TO "${role}"`);
  });
  console.log("Knowledge schema ready; reader SELECT grants installed");
} catch { console.error("Knowledge migration failed; check owner privileges and existing reader role"); process.exitCode = 1; }
finally { await db.close(); }

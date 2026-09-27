import { parseArgs } from "node:util";
import { postgres } from "./database.js";
import { CatalogRepository } from "./repository.js";
const { values } = parseArgs({ options: { tenant: { type: "string" }, id: { type: "string" }, version: { type: "string" } } });
if (!values.tenant || !values.id || !values.version || !process.env.DATABASE_URL) throw new Error("--tenant, --id, --version and DATABASE_URL required");
const { db, close } = postgres(process.env.DATABASE_URL);
try { await new CatalogRepository(db).revoke(values.tenant, values.id, Number(values.version)); console.log("Tenant definition grant revoked; running snapshots unchanged."); }
finally { await close(); }

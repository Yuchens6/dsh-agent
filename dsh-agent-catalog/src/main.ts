import { z } from "zod";
import { postgres } from "./database.js";
import { CatalogRepository } from "./repository.js";
import { createCatalogApp } from "./app.js";
import { serviceVerifier } from "./auth.js";
const env = z.object({
  DATABASE_URL: z.string().min(1), API_CATALOG_SECRET: z.string().min(32),
  CHAT_CATALOG_SECRET: z.string().min(32), PORT: z.coerce.number().int().default(8080),
  RUN_CONTROL_CATALOG_SECRET: z.string().min(32),
}).parse(process.env);
const { db, close } = postgres(env.DATABASE_URL);
const app = createCatalogApp({
  repository: new CatalogRepository(db),
  authenticate: serviceVerifier({ api: env.API_CATALOG_SECRET, chat: env.CHAT_CATALOG_SECRET, runControl: env.RUN_CONTROL_CATALOG_SECRET }), logger: true,
  ready: async () => {
    const result = await db.query("SELECT version FROM catalog.schema_migrations WHERE version=1");
    if (!result.rows.length) throw new Error("Missing migration");
  },
});
await app.listen({ host: "0.0.0.0", port: env.PORT });
let stopping = false;
async function stop() { if (stopping) return; stopping = true; await app.close(); await close(); }
process.once("SIGTERM", () => void stop());
process.once("SIGINT", () => void stop());

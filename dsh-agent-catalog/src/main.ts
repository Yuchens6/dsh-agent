import { z } from "zod";
import { postgres } from "./database.js";
import { CatalogRepository } from "./repository.js";
import { createCatalogApp } from "./app.js";
import { serviceVerifier } from "./auth.js";
import { StudioRepository } from "./studio.js";
const env = z.object({
  DATABASE_URL: z.string().min(1), API_CATALOG_SECRET: z.string().min(32),
  CHAT_CATALOG_SECRET: z.string().min(32), PORT: z.coerce.number().int().default(8080),
  HOST: z.enum(["127.0.0.1", "0.0.0.0"]).default("0.0.0.0"),
  RUN_CONTROL_CATALOG_SECRET: z.string().min(32),
  CATALOG_STUDIO_DATABASE_URL: z.string().min(1).optional(),
}).parse(process.env);
const { db, close } = postgres(env.DATABASE_URL);
const writer = env.CATALOG_STUDIO_DATABASE_URL ? postgres(env.CATALOG_STUDIO_DATABASE_URL) : undefined;
const credentials = { api: env.API_CATALOG_SECRET, chat: env.CHAT_CATALOG_SECRET, runControl: env.RUN_CONTROL_CATALOG_SECRET };
const app = createCatalogApp({
  repository: new CatalogRepository(db),
  authenticate: serviceVerifier(credentials), logger: true,
  studio: writer ? new StudioRepository(writer.db) : undefined,
  authenticateStudio: serviceVerifier(credentials, ["dsh-agent-api"]),
  ready: async () => {
    const result = await db.query("SELECT version FROM catalog.schema_migrations WHERE version=1");
    if (!result.rows.length) throw new Error("Missing migration");
    if (writer && !(await writer.db.query("SELECT version FROM catalog.schema_migrations WHERE version=2")).rows.length) throw new Error("Missing studio migration");
  },
});
await app.listen({ host: env.HOST, port: env.PORT });
let stopping = false;
async function stop() { if (stopping) return; stopping = true; await app.close(); await close(); await writer?.close(); }
process.once("SIGTERM", () => void stop());
process.once("SIGINT", () => void stop());

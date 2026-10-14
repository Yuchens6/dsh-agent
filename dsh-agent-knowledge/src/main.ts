import { readFile, stat } from "node:fs/promises";
import { z } from "zod";
import { createKnowledgeApp } from "./app.js";
import { knowledgeAuthorizer } from "./auth.js";
import { sourceRegistry } from "./sources.js";
import { postgres } from "./database.js";
const env = z.object({ KNOWLEDGE_SOURCES_FILE: z.string().min(1), RUN_CONTROL_URL: z.url(),
  RUN_CONTROL_KNOWLEDGE_SECRET: z.string().min(32), KNOWLEDGE_RUN_CONTROL_SECRET: z.string().min(32),
  HOST: z.enum(["127.0.0.1", "0.0.0.0"]).default("127.0.0.1"), PORT: z.coerce.number().int().min(1).max(65535).default(8090),
  KNOWLEDGE_MAX_IN_FLIGHT: z.coerce.number().int().min(1).max(128).default(16),
  KNOWLEDGE_DATABASE_URL: z.preprocess(value => value === "" ? undefined : value,z.string().min(1).optional()),
  KNOWLEDGE_DB_POOL_MAX: z.coerce.number().int().min(1).max(64).default(8),
  KNOWLEDGE_DB_MAX_WAITING: z.coerce.number().int().min(0).max(128).default(16),
}).parse(process.env);
if ((await stat(env.KNOWLEDGE_SOURCES_FILE)).size > 1024 * 1024) throw new Error("Sources configuration too large");
const config = await readFile(env.KNOWLEDGE_SOURCES_FILE, "utf8");
if (Buffer.byteLength(config) > 1024 * 1024) throw new Error("Sources configuration too large");
const sources = sourceRegistry(JSON.parse(config));
if (sources.usesPostgres && !env.KNOWLEDGE_DATABASE_URL) throw new Error("Configure KNOWLEDGE_DATABASE_URL for PostgreSQL retrieval");
const database = sources.usesPostgres ? postgres(env.KNOWLEDGE_DATABASE_URL!, { max: env.KNOWLEDGE_DB_POOL_MAX, maxWaiting: env.KNOWLEDGE_DB_MAX_WAITING }) : undefined;
const app = createKnowledgeApp({ sources, database,
  ready: async () => {
    if (database && (await database.query("SELECT id FROM knowledge.corpora WHERE id=ANY($1::text[])",[sources.corpusIds])).rows.length !== sources.corpusIds.length) throw new Error("Corpus unavailable");
  },
  authorize: knowledgeAuthorizer({ capabilitySecret: env.RUN_CONTROL_KNOWLEDGE_SECRET,
    serviceSecret: env.KNOWLEDGE_RUN_CONTROL_SECRET, runControlUrl: env.RUN_CONTROL_URL }),
  maxInFlight: env.KNOWLEDGE_MAX_IN_FLIGHT, logger: true });
try { await app.listen({ host: env.HOST, port: env.PORT }); } catch (error) { await database?.close(); throw error; }
let stopping = false;
async function stop() { if (stopping) return; stopping = true; await app.close(); await database?.close(); }
process.once("SIGTERM", () => void stop()); process.once("SIGINT", () => void stop());

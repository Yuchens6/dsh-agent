import { z } from "zod";
import { postgres } from "./database.js";
import { openStorage } from "./config.js";
import { WorkspaceRepository } from "./repository.js";
import { createWorkspaceApp } from "./app.js";
import { serviceVerifier } from "./auth.js";
import { executionAuthorizer } from "./execution-auth.js";
import { auditClient } from "./audit.js";
const env = z.object({
  DATABASE_URL: z.string().min(1), API_WORKSPACE_SECRET: z.string().min(32),
  CHAT_WORKSPACE_SECRET: z.string().min(32), PORT: z.coerce.number().int().default(8080),
  RUN_CONTROL_WORKSPACE_SECRET: z.string().min(32), WORKSPACE_RUN_CONTROL_SECRET: z.string().min(32), RUN_CONTROL_URL: z.url(),
  AUDIT_URL: z.url(), WORKSPACE_AUDIT_SECRET: z.string().min(32), WORKSPACE_METRICS_SECRET: z.string().min(32),
}).parse(process.env);
if (new Set([env.API_WORKSPACE_SECRET, env.CHAT_WORKSPACE_SECRET, env.RUN_CONTROL_WORKSPACE_SECRET, env.WORKSPACE_RUN_CONTROL_SECRET,
  env.WORKSPACE_AUDIT_SECRET, env.WORKSPACE_METRICS_SECRET]).size !== 6) {
  throw new Error("Distinct service secrets required");
}
const { db, close } = postgres(env.DATABASE_URL);
const storage = openStorage();
const repository = new WorkspaceRepository(db, storage);
const app = createWorkspaceApp({
  repository, metrics: { secret: env.WORKSPACE_METRICS_SECRET, snapshot: () => repository.metrics() },
  authenticate: serviceVerifier({ api: env.API_WORKSPACE_SECRET, chat: env.CHAT_WORKSPACE_SECRET }), logger: true,
  authorizeExecution: executionAuthorizer({ capabilitySecret: env.RUN_CONTROL_WORKSPACE_SECRET,
    serviceSecret: env.WORKSPACE_RUN_CONTROL_SECRET, runControlUrl: env.RUN_CONTROL_URL }),
  ready: async () => {
    const result = await db.query("SELECT version FROM workspace.schema_migrations WHERE version=2");
    if (!result.rows.length) throw new Error("Missing migration");
    await storage.ready();
  },
});
await app.listen({ host: "0.0.0.0", port: env.PORT });
let stopping = false;
const deliverAudit = auditClient(env.AUDIT_URL, env.WORKSPACE_AUDIT_SECRET);
const auditPublisher = (async () => {
  while (!stopping) {
    try { if (await repository.publishAuditBatch(deliverAudit) !== "idle") continue; }
    catch { app.log.warn("Audit transaction failed; durable retry retained"); }
    if (!stopping) await new Promise(resolve => setTimeout(resolve, 500));
  }
})();
async function stop() { if (stopping) return; stopping = true; await app.close(); await auditPublisher; storage.close(); await close(); }
process.once("SIGTERM", () => void stop());
process.once("SIGINT", () => void stop());

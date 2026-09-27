import { z } from "zod";
import { connect } from "@nats-io/transport-node";
import { jetstream } from "@nats-io/jetstream";
import { postgres } from "./database.js";
import { RunRepository } from "./repository.js";
import { createRunControlApp } from "./app.js";
import { authenticators } from "./auth.js";
import { openRequestConsumer, processRequest } from "./consumer.js";
import { executionClient } from "./execution-client.js";
import { workspaceCapabilitySigner, workspaceServiceVerifier } from "./workspace-auth.js";
import { supportClient } from "./support-client.js";
import { backgroundWorkers } from "./background.js";
const env = z.object({
  DATABASE_URL: z.string().min(1), API_RUN_CONTROL_SECRET: z.string().min(32), RUNTIME_RUN_CONTROL_SECRET: z.string().min(32),
  NATS_URL: z.url(), NATS_TOKEN: z.string().min(1), PORT: z.coerce.number().int().default(8080),
  RUN_LEASE_SECONDS: z.coerce.number().int().positive().default(30),
  RUN_TIMEOUT_SECONDS: z.coerce.number().int().positive().max(3600).default(120),
  RUN_MAX_ACTIVE: z.coerce.number().int().positive().max(1000).default(64),
  CHAT_URL: z.url(), CATALOG_URL: z.url(), RUN_CONTROL_CHAT_SECRET: z.string().min(32), RUN_CONTROL_CATALOG_SECRET: z.string().min(32),
  RUN_CONTROL_WORKSPACE_SECRET: z.string().min(32), WORKSPACE_RUN_CONTROL_SECRET: z.string().min(32),
  QUOTA_URL: z.url(), AUDIT_URL: z.url(), RUN_CONTROL_QUOTA_SECRET: z.string().min(32), RUN_CONTROL_AUDIT_SECRET: z.string().min(32),
  RUN_CONTROL_METRICS_SECRET: z.string().min(32),
  RUN_DELIVERY_WORKERS: z.coerce.number().int().min(1).max(8).default(2),
  RUN_USER_ACTIVE: z.coerce.number().int().min(1).max(1000).default(2),
  RUN_TENANT_ACTIVE: z.coerce.number().int().min(1).max(1000).default(32),
  RUN_AGING_SECONDS: z.coerce.number().int().min(1).max(3600).default(60),
}).parse(process.env);
if (new Set([env.API_RUN_CONTROL_SECRET, env.RUNTIME_RUN_CONTROL_SECRET, env.RUN_CONTROL_CHAT_SECRET, env.RUN_CONTROL_CATALOG_SECRET,
  env.RUN_CONTROL_WORKSPACE_SECRET, env.WORKSPACE_RUN_CONTROL_SECRET, env.RUN_CONTROL_QUOTA_SECRET, env.RUN_CONTROL_AUDIT_SECRET, env.RUN_CONTROL_METRICS_SECRET]).size !== 9) {
  throw new Error("Distinct service secrets required");
}
const { db, close, snapshot } = postgres(env.DATABASE_URL);
const nc = await connect({ servers: env.NATS_URL, token: env.NATS_TOKEN, timeout: 3000, maxReconnectAttempts: -1 });
const js = jetstream(nc, { timeout: 3000 });
const repository = new RunRepository(db, { leaseSeconds: env.RUN_LEASE_SECONDS, timeoutSeconds: env.RUN_TIMEOUT_SECONDS, maxActive: env.RUN_MAX_ACTIVE },
  {userActive:env.RUN_USER_ACTIVE,tenantActive:env.RUN_TENANT_ACTIVE,agingSeconds:env.RUN_AGING_SECONDS});
const auth = authenticators(env.API_RUN_CONTROL_SECRET, env.RUNTIME_RUN_CONTROL_SECRET);
const execution = executionClient({ chatUrl: env.CHAT_URL, catalogUrl: env.CATALOG_URL,
  chatSecret: env.RUN_CONTROL_CHAT_SECRET, catalogSecret: env.RUN_CONTROL_CATALOG_SECRET });
const support = supportClient({ quotaUrl: env.QUOTA_URL, auditUrl: env.AUDIT_URL, quotaSecret: env.RUN_CONTROL_QUOTA_SECRET, auditSecret: env.RUN_CONTROL_AUDIT_SECRET });
let stopping = false, consuming = false;
const stopped = new AbortController();
let messages: Awaited<ReturnType<typeof openRequestConsumer>> | undefined;
const app = createRunControlApp({ repository, authenticateApi: auth.api, authenticateWorker: auth.worker, logger: true,
  metrics: { secret: env.RUN_CONTROL_METRICS_SECRET, snapshot: async () => ({...await repository.metrics(),...snapshot()}) },
  resolveInput: execution.resolve,
  reserveQuota: support.reserve,
  signWorkspaceCapability: workspaceCapabilitySigner(env.RUN_CONTROL_WORKSPACE_SECRET),
  authenticateWorkspace: workspaceServiceVerifier(env.WORKSPACE_RUN_CONTROL_SECRET),
  ready: async () => {
    if (!consuming || nc.isClosed()) throw new Error("Consumer unavailable");
    const result = await db.query("SELECT version FROM run_control.schema_migrations WHERE version=6");
    if (!result.rows.length) throw new Error("Missing migration");
    await nc.flush();
  } });
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const consumerTask = (async () => {
  while (!stopping) {
    try {
      messages = await openRequestConsumer(nc);
      if (stopping) { void messages.close().catch(() => undefined); break; }
      consuming = true;
      for await (const message of messages) {
        if (stopping) break;
        try { await processRequest(repository, message); }
        catch { app.log.warn("Run admission failed; request remains retryable"); }
      }
    } catch { if (!stopping) app.log.warn("Run request consumer unavailable; reconnect scheduled"); }
    finally { consuming = false; void messages?.close().catch(() => undefined); messages = undefined; }
    if (!stopping) await pause(2000);
  }
})();
const supportTask = backgroundWorkers(env.RUN_DELIVERY_WORKERS,stopped.signal,async()=>await repository.supportBatch(support.deliver)!=="idle",
  ()=>app.log.warn("Support delivery failed; durable retry retained"));
const projections = backgroundWorkers(env.RUN_DELIVERY_WORKERS,stopped.signal,async()=>await repository.projectBatch(execution.project)!=="idle",
  ()=>app.log.warn("Assistant projection transaction failed; retry scheduled"));
const publisher = backgroundWorkers(1,stopped.signal,async()=>await repository.publishBatch(async(subject,event)=>{
  await js.publish(subject,JSON.stringify(event),{msgID:event.eventId});
})>0,()=>app.log.warn("Run event publish failed; retry scheduled"));
const sweeper = backgroundWorkers(1,stopped.signal,async()=>{await repository.expireBatch();return false;},
  ()=>app.log.warn("Run lease sweep failed; retry scheduled"));
await app.listen({ host: "0.0.0.0", port: env.PORT });
async function stop() {
  if (stopping) return; stopping = true; stopped.abort(); void messages?.close().catch(() => undefined);
  await app.close(); await Promise.all([consumerTask, projections, publisher, sweeper, supportTask]); await nc.drain(); await close();
}
process.once("SIGTERM", () => void stop());
process.once("SIGINT", () => void stop());

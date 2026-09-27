import { connect } from "@nats-io/transport-node";
import { jetstream } from "@nats-io/jetstream";
import { z } from "zod";
import { postgres } from "./database.js";
import { ChatRepository } from "./repository.js";
import { createChatApp } from "./app.js";
import { serviceVerifier, executionVerifier, capabilitySigner } from "./auth.js";
import { bindingResolver } from "./binding-client.js";
import { auditClient } from "./audit.js";
import { backgroundWorkers } from "./background.js";

const env = z.object({
  DATABASE_URL: z.string().min(1), API_CHAT_SECRET: z.string().min(32),
  CHAT_CAPABILITY_SECRET: z.string().min(32), NATS_URL: z.string().url(),
  NATS_TOKEN: z.string().min(1), PORT: z.coerce.number().int().default(8080),
  WORKSPACE_URL: z.url(), CATALOG_URL: z.url(),
  CHAT_WORKSPACE_SECRET: z.string().min(32), CHAT_CATALOG_SECRET: z.string().min(32),
  RUN_CONTROL_CHAT_SECRET: z.string().min(32),
  AUDIT_URL: z.url(), CHAT_AUDIT_SECRET: z.string().min(32), CHAT_METRICS_SECRET: z.string().min(32),
  CHAT_MESSAGES_PER_MINUTE: z.coerce.number().int().min(1).max(1000000).default(120),
  CHAT_PENDING_PER_USER: z.coerce.number().int().min(1).max(1000000).default(1000),
  CHAT_PENDING_PER_SESSION: z.coerce.number().int().min(1).max(1000000).default(100),
  CHAT_PUBLISH_WORKERS: z.coerce.number().int().min(1).max(8).default(2),
}).parse(process.env);
if (new Set([env.RUN_CONTROL_CHAT_SECRET, env.API_CHAT_SECRET, env.CHAT_AUDIT_SECRET, env.CHAT_METRICS_SECRET,
  env.CHAT_CAPABILITY_SECRET, env.CHAT_WORKSPACE_SECRET, env.CHAT_CATALOG_SECRET]).size !== 7) throw new Error("Distinct service secrets required");
const { db, close, snapshot } = postgres(env.DATABASE_URL);
const nc = await connect({ servers: env.NATS_URL, token: env.NATS_TOKEN, timeout: 3000 });
const js = jetstream(nc, { timeout: 3000 });
const repository = new ChatRepository(db, bindingResolver({
  workspaceUrl: env.WORKSPACE_URL, workspaceSecret: env.CHAT_WORKSPACE_SECRET,
  catalogUrl: env.CATALOG_URL, catalogSecret: env.CHAT_CATALOG_SECRET,
}), {messagesPerMinute:env.CHAT_MESSAGES_PER_MINUTE,pendingPerUser:env.CHAT_PENDING_PER_USER,pendingPerSession:env.CHAT_PENDING_PER_SESSION});
const app = createChatApp({ repository, authenticate: serviceVerifier(env.API_CHAT_SECRET),
  metrics: { secret: env.CHAT_METRICS_SECRET, snapshot: async () => ({...await repository.metrics(),...snapshot()}) },
  authenticateExecution: executionVerifier(env.RUN_CONTROL_CHAT_SECRET),
  signCapability: capabilitySigner(env.CHAT_CAPABILITY_SECRET), logger: true,
  ready: async () => {
    const migrated = await db.query("SELECT version FROM chat.schema_migrations WHERE version=5");
    if (!migrated.rows.length) throw new Error("Database migration is missing");
    if (nc.isClosed()) throw new Error();
    await nc.flush();
  } });
let stopping = false;
const stopped = new AbortController();
const deliverAudit = auditClient(env.AUDIT_URL, env.CHAT_AUDIT_SECRET);
const auditPublisher = backgroundWorkers(1,stopped.signal,async()=>await repository.publishAuditBatch(deliverAudit)!=="idle",
  ()=>app.log.warn("Audit transaction failed; durable retry retained"));
// 失败不标记已发送；下一轮重新发布，消息标识支持 JetStream 去重。
const publisher = backgroundWorkers(env.CHAT_PUBLISH_WORKERS,stopped.signal,async()=>await repository.publishBatch(async(subject,event)=>{
  await js.publish(subject,JSON.stringify(event),{msgID:event.eventId});
})>0,()=>app.log.warn("Outbox publish failed; retry scheduled"));
await app.listen({ host: "0.0.0.0", port: env.PORT, backlog: 1024 });
async function stop() {
  if (stopping) return;
  stopping = true; stopped.abort();
  await app.close(); await Promise.all([publisher, auditPublisher]); await nc.drain(); await close();
}
process.once("SIGTERM", () => void stop());
process.once("SIGINT", () => void stop());

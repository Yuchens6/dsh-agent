import Fastify from "fastify";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { IdentityId } from "@dsh-agent/contracts";
import { runtimeClient, serviceOrigin } from "./client.js";
import { processExecutor } from "./executor.js";
import { executeClaim } from "./worker.js";
import { runSlots } from "./slots.js";
const env = z.object({
  RUNTIME_ENABLED: z.enum(["true", "false"]).default("false"),
  RUN_CONTROL_URL: z.url(), WORKSPACE_URL: z.url(), RUNTIME_RUN_CONTROL_SECRET: z.string().min(32),
  WORKER_ID: IdentityId.default("runtime-" + randomUUID()), PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  DEEPSEEK_API_KEY: z.preprocess(value => value === "" ? undefined : value, z.string().min(1).max(4096).optional()),
  DEEPSEEK_BASE_URL: z.url().default("https://api.deepseek.com"),
  RUNTIME_MAX_TOOL_CALLS: z.coerce.number().int().min(1).max(1000).default(100),
  RUNTIME_CONCURRENCY: z.coerce.number().int().min(1).max(16).default(1),
}).parse(process.env);
const base = serviceOrigin(env.DEEPSEEK_BASE_URL);
if (base.protocol !== "https:") throw new Error("Model endpoint requires HTTPS");
if (env.RUNTIME_ENABLED === "true" && !env.DEEPSEEK_API_KEY) throw new Error("Explicit model credentials required when runtime is enabled");
const client = runtimeClient({ runControlUrl: env.RUN_CONTROL_URL, workspaceUrl: env.WORKSPACE_URL,
  workerId: env.WORKER_ID, secret: env.RUNTIME_RUN_CONTROL_SECRET });
const stop = new AbortController();
const app = Fastify({ logger: true });
const healthy = Array.from({length:env.RUNTIME_CONCURRENCY},()=>true);
app.get("/health/live", async () => ({ status: "ok" }));
app.get("/health/ready", async (_req, reply) => reply.code(healthy.every(Boolean) ? 200 : 503).send({ status: healthy.every(Boolean) ? "ok" : "unavailable", enabled: env.RUNTIME_ENABLED === "true", concurrency:env.RUNTIME_CONCURRENCY }));
await app.listen({ host: "0.0.0.0", port: env.PORT });
const loop = (async () => {
  if (env.RUNTIME_ENABLED !== "true") { app.log.info("Runtime disabled; no tasks will be claimed"); return; }
  const execute = processExecutor({ apiKey: env.DEEPSEEK_API_KEY!, baseUrl: base.href, maxToolCalls: env.RUNTIME_MAX_TOOL_CALLS });
  await runSlots({concurrency:env.RUNTIME_CONCURRENCY,signal:stop.signal,claim:signal=>client.claim(signal),
    execute:(claim,signal)=>executeClaim(client,claim,execute,signal,{heartbeatMs:5000,maxToolCalls:env.RUNTIME_MAX_TOOL_CALLS}),
    health:(slot,value)=>{healthy[slot]=value;if(!value)app.log.warn("Run acquisition failed; no execution retry performed");}});
})();
async function shutdown() { if (stop.signal.aborted) return; stop.abort(); await loop; await app.close(); }
process.once("SIGTERM", () => void shutdown()); process.once("SIGINT", () => void shutdown());

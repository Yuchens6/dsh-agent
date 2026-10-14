import Fastify from "fastify";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { KnowledgeToolCall, KnowledgeToolResult, type KnowledgeAuthorization } from "@dsh-agent/contracts";
import type { SourceRegistry } from "./sources.js";
import { retrievalRouter, type Retrieve } from "./retrieval.js";
import type { Database } from "./database.js";
import { KnowledgeError } from "./network.js";
export function createKnowledgeApp(options: {
  authorize: (header: string | undefined, sourceId: string) => Promise<KnowledgeAuthorization>;
  sources: SourceRegistry; database?: Database; retrieve?: Retrieve; ready?: () => Promise<void>; maxInFlight?: number; logger?: boolean;
}) {
  const app = Fastify({ bodyLimit: 16 * 1024, genReqId: () => randomUUID(),
    logger: options.logger ? { redact: ["req.headers.authorization", "req.headers.cookie"] } : false });
  let inFlight = 0;
  const max = options.maxInFlight ?? 16, retrieve = options.retrieve ?? retrievalRouter(options.database);
  const admitted = new WeakSet<object>();
  app.addHook("onRequest", async (req, reply) => {
    if (req.url.split("?", 1)[0] !== "/execution/v1/tools") return;
    if (inFlight >= max) return reply.header("retry-after", "1").code(503).send({ error: { code: "DEPENDENCY_UNAVAILABLE", message: "DEPENDENCY_UNAVAILABLE", requestId: req.id } });
    ++inFlight; admitted.add(req);
  });
  app.addHook("onResponse", async req => { if (admitted.delete(req)) --inFlight; });
  app.setErrorHandler((error, req, reply) => {
    const status = error instanceof KnowledgeError ? error.status : error instanceof z.ZodError ? 400 :
      error instanceof Error && "statusCode" in error && typeof error.statusCode === "number" ? error.statusCode : 500;
    const code = error instanceof KnowledgeError ? error.code : status < 500 ? "INVALID_REQUEST" : "INTERNAL_ERROR";
    if (status === 503) reply.header("retry-after", "1");
    return reply.code(status).send({ error: { code, message: code, requestId: req.id } });
  });
  app.addHook("onSend", async (_req, reply) => { reply.header("cache-control", "no-store"); });
  app.get("/health/live", async () => ({ status: "ok" }));
  app.get("/health/ready", async (_req, reply) => {
    try {
      if (!options.sources.count || (options.sources.usesPostgres && !options.database && !options.retrieve)) throw new Error("Unconfigured");
      await options.ready?.(); return { status: "configured" };
    } catch { return reply.code(503).send({ status: "unavailable" }); }
  });
  app.post("/execution/v1/tools", async (req, reply) => {
    z.object({}).strict().parse(req.query);
    const call = KnowledgeToolCall.parse(req.body);
    const before = await options.authorize(req.headers.authorization, call.arguments.sourceId);
    const source = options.sources.resolve(call.arguments.sourceId, before.actor);
    const canceled = new AbortController();
    const stop = () => canceled.abort();
    reply.raw.once("close", stop);
    try {
      const result = await retrieve(source, call.arguments, canceled.signal);
      const after = await options.authorize(req.headers.authorization, call.arguments.sourceId);
      if (after.runId !== before.runId || after.actor.uid !== before.actor.uid || after.actor.tenantId !== before.actor.tenantId || after.workspaceId !== before.workspaceId) throw new KnowledgeError(403, "FORBIDDEN");
      options.sources.resolve(call.arguments.sourceId, after.actor);
      return KnowledgeToolResult.parse({ tool: call.tool, result });
    } finally { reply.raw.removeListener("close", stop); }
  });
  return app;
}

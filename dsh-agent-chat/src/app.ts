import Fastify from "fastify";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { CreateSession, SendMessage, PageQuery, ResourceId, IdempotencyKey, AssistantResult, type Principal } from "@dsh-agent/contracts";
import { ChatError, type ChatRepository } from "./repository.js";
import { UpdateSession } from "@dsh-agent/contracts";
import { registerMetrics, type MetricsOptions } from "./metrics.js";
import { AdmissionError } from "./admission.js";
import { DatabaseCapacityError } from "./capacity.js";

export function createChatApp(options: {
  repository: ChatRepository;
  authenticate: (header?: string) => Promise<Principal>;
  authenticateExecution?: (header?: string) => Promise<Principal>;
  signCapability: (actor: Principal, sessionId: string) => Promise<unknown>;
  ready: () => Promise<void>;
  logger?: boolean;
  metrics?: MetricsOptions;
}) {
  const app = Fastify({ bodyLimit: 256 * 1024, genReqId: req => {
    const id = req.headers["x-request-id"];
    return typeof id === "string" && ResourceId.safeParse(id).success ? id : randomUUID();
  },
    logger: options.logger ? { redact: ["req.headers.authorization", "req.headers.cookie"] } : false });
  app.setErrorHandler((err, req, reply) => {
    const status = err instanceof ChatError ? err.status : err instanceof z.ZodError ? 400 :
      (err instanceof Error && "statusCode" in err && typeof err.statusCode === "number" ? err.statusCode : 500);
    const code = err instanceof DatabaseCapacityError ? "DEPENDENCY_UNAVAILABLE" : err instanceof AdmissionError ? "QUOTA_EXCEEDED" : err instanceof ChatError ? err.code : status < 500 ? "INVALID_REQUEST" : "INTERNAL_ERROR";
    if (err instanceof AdmissionError) reply.header("retry-after",err.retryAfter);
    if (status===503) reply.header("retry-after",1);
    reply.code(status).send({ error: { code, message: code, requestId: req.id } });
  });
  app.addHook("onSend", async (_req, reply) => { reply.header("cache-control", "no-store"); });
  registerMetrics(app, options.metrics);
  app.get("/health/live", async () => ({ status: "ok" }));
  app.get("/health/ready", async (_req, reply) => {
    try { await options.ready(); return { status: "ok" }; }
    catch { return reply.code(503).send({ status: "unavailable" }); }
  });
  app.register(async routes => {
    const actors = new WeakMap<object, Principal>();
    routes.addHook("onRequest", async req => { actors.set(req, await options.authenticate(req.headers.authorization)); });
    const actor = (req: object) => actors.get(req)!;
    routes.post("/sessions", async (req, reply) => {
      const body = CreateSession.parse(req.body);
      const key = IdempotencyKey.parse(req.headers["idempotency-key"]);
      return reply.code(201).send(await options.repository.create(actor(req), body.title, key, req.id));
    });
    routes.get("/sessions", async req => {
      const page = PageQuery.parse(req.query);
      return options.repository.list(actor(req), page.limit, page.after);
    });
    routes.get("/sessions/:sessionId", async req =>
      options.repository.get(actor(req), ResourceId.parse((req.params as { sessionId: string }).sessionId)));
    routes.patch("/sessions/:sessionId", async req => {
      z.object({}).strict().parse(req.query);
      return options.repository.update(actor(req), ResourceId.parse((req.params as { sessionId: string }).sessionId), UpdateSession.parse(req.body));
    });
    routes.post("/sessions/:sessionId/messages", async (req, reply) => {
      const id = ResourceId.parse((req.params as { sessionId: string }).sessionId);
      const body = SendMessage.parse(req.body);
      const key = IdempotencyKey.parse(req.headers["idempotency-key"]);
      return reply.code(202).send(await options.repository.send(actor(req), id, body.content, key, req.id));
    });
    routes.get("/sessions/:sessionId/history", async req => {
      const id = ResourceId.parse((req.params as { sessionId: string }).sessionId);
      const page = PageQuery.parse(req.query);
      return options.repository.history(actor(req), id, page.limit, page.after);
    });
    routes.post("/sessions/:sessionId/subscription", async req => {
      const id = ResourceId.parse((req.params as { sessionId: string }).sessionId);
      await options.repository.get(actor(req), id);
      return options.signCapability(actor(req), id);
    });
  }, { prefix: "/internal/v1" });
  app.register(async routes => {
    const actors = new WeakMap<object, Principal>();
    routes.addHook("onRequest", async req => {
      if (!options.authenticateExecution) throw new ChatError(401, "UNAUTHENTICATED");
      actors.set(req, await options.authenticateExecution(req.headers.authorization));
      z.object({}).strict().parse(req.query);
    });
    routes.get("/sessions/:sessionId/messages/:messageId/context", async req => {
      const params = z.object({ sessionId: ResourceId, messageId: ResourceId }).strict().parse(req.params);
      return options.repository.executionContext(actors.get(req)!, params.sessionId, params.messageId);
    });
    routes.post("/sessions/:sessionId/assistant-results", async req => {
      const params = z.object({ sessionId: ResourceId }).strict().parse(req.params);
      return options.repository.appendAssistant(actors.get(req)!, params.sessionId, AssistantResult.parse(req.body));
    });
  }, { prefix: "/execution/v1" });
  return app;
}

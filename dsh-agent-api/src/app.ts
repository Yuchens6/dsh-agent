import Fastify from "fastify";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { CreateSession, IdempotencyKey, SendMessage, ResourceId, Session, SessionPage,
  Message, MessagePage, PageQuery, Subscription, Workspace, FileMetadata, TextFile, WriteTextFile,
  FileQuery, DeleteFileQuery, DeleteFileResult, FileListQuery, FilePage, DefinitionPage, AgentDefinition, IdentityId,
  Run, RunPage, RunListQuery, type Principal } from "@dsh-agent/contracts";
import { ApiError, type ChatClient, type CallContext } from "./chat-client.js";
import { Admission } from "./admission.js";
import { QuotaUsage, AuditPage, UpdateSession, ModelUsageQuery, ModelUsageSummary, WorkflowProgress, PointsBalance, PointsLedgerPage } from "@dsh-agent/contracts";

export function createApiApp(options: {
  authenticate: (header?: string) => Promise<Principal>; chat: ChatClient; logger?: boolean;
  workspace?: ChatClient; catalog?: ChatClient; runs?: ChatClient;
  quota?: ChatClient; audit?: ChatClient;
  maxInFlight?: number;
}) {
  const app = Fastify({ bodyLimit: 512 * 1024, requestTimeout:30000, connectionTimeout:15000, genReqId: () => randomUUID(),
    logger: options.logger ? { redact: ["req.headers.authorization", "req.headers.cookie"] } : false });
  app.setErrorHandler((err, req, reply) => {
    const status = err instanceof ApiError ? err.status : err instanceof z.ZodError ? 400 :
      (err instanceof Error && "statusCode" in err && typeof err.statusCode === "number" ? err.statusCode : 500);
    const code = err instanceof ApiError ? err.code : status < 500 ? "INVALID_REQUEST" : "INTERNAL_ERROR";
    if (status === 429 || status === 503) reply.header("retry-after", err instanceof ApiError ? err.retryAfter : 1);
    reply.code(status).send({ error: { code, message: code, requestId: req.id } });
  });
  app.addHook("onSend", async (req, reply) => { reply.header("x-request-id", req.id).header("cache-control", "no-store"); });
  app.get("/health/live", async () => ({ status: "ok" }));
  app.get("/health/ready", async () => ({ status: "ok" }));
  app.register(async routes => {
    const admission = new Admission(options.maxInFlight ?? 128);
    const releases = new WeakMap<object, () => void>();
    // 认证和正文解析前门禁，健康检查不占业务槽位。
    routes.addHook("onRequest", async (req,reply) => {
      const release = admission.enter();
      if (!release) throw new ApiError(503,"DEPENDENCY_UNAVAILABLE");
      releases.set(req,release);
      // 正文接收完毕后的客户端断开不一定触发 onRequestAbort。
      reply.raw.once("close",release);
    });
    routes.addHook("onResponse", async req => { releases.get(req)?.(); releases.delete(req); });
    routes.addHook("onRequestAbort", async req => { releases.get(req)?.(); releases.delete(req); });
    routes.addHook("onTimeout", async req => { releases.get(req)?.(); releases.delete(req); });
    const contexts = new WeakMap<object, CallContext>();
    routes.addHook("onRequest", async (req, reply) => {
      let actor: Principal;
      try { actor = await options.authenticate(req.headers.authorization); }
      catch { throw new ApiError(401, "UNAUTHENTICATED"); }
      if(reply.raw.destroyed) throw new ApiError(503,"DEPENDENCY_UNAVAILABLE");
      const controller = new AbortController();
      req.raw.once("aborted", () => controller.abort());
      reply.raw.once("close", () => { if (!reply.raw.writableEnded) controller.abort(); });
      contexts.set(req, { actor, requestId: req.id, signal: controller.signal });
    });
    const ctx = (req: object) => contexts.get(req)!;
    const sessionPath = (params: unknown) => "/sessions/" +
      ResourceId.parse((params as { sessionId: string }).sessionId);
    const pageQuery = (query: unknown) => {
      const page = PageQuery.parse(query);
      const q = new URLSearchParams({ limit: String(page.limit) });
      if (page.after) q.set("after", page.after);
      return "?" + q;
    };
    routes.get("/me", async req => ctx(req).actor);
    routes.get("/points", async req => {
      z.object({}).strict().parse(req.query);
      if (!options.quota) throw new ApiError(503,"DEPENDENCY_UNAVAILABLE");
      return options.quota(ctx(req),"GET","/points",PointsBalance);
    });
    routes.get("/points/ledger", async req => {
      const query = pageQuery(req.query);
      if (!options.quota) throw new ApiError(503,"DEPENDENCY_UNAVAILABLE");
      return options.quota(ctx(req),"GET","/points/ledger" + query,PointsLedgerPage);
    });
    routes.get("/quota", async req => {
      z.object({}).strict().parse(req.query);
      if (!options.quota) throw new ApiError(503, "DEPENDENCY_UNAVAILABLE");
      return options.quota(ctx(req), "GET", "/quota", QuotaUsage);
    });
    routes.get("/audit", async req => {
      if (!options.audit) throw new ApiError(503, "DEPENDENCY_UNAVAILABLE");
      return options.audit(ctx(req), "GET", "/audit" + pageQuery(req.query), AuditPage);
    });
    routes.get("/usage", async req => {
      const query = ModelUsageQuery.parse(req.query);
      if (!options.quota) throw new ApiError(503, "DEPENDENCY_UNAVAILABLE");
      return options.quota(ctx(req), "GET", "/usage" + (query.day ? "?day=" + query.day : ""), ModelUsageSummary);
    });
    const workspace: ChatClient = (...args) => {
      if (!options.workspace) throw new ApiError(503, "DEPENDENCY_UNAVAILABLE");
      return options.workspace(...args);
    };
    const catalog: ChatClient = (...args) => {
      if (!options.catalog) throw new ApiError(503, "DEPENDENCY_UNAVAILABLE");
      return options.catalog(...args);
    };
    const workspacePath = (params: unknown) => "/workspaces/" +
      ResourceId.parse((params as { workspaceId: string }).workspaceId);
    const queryString = (query: Record<string, unknown>) =>
      "?" + new URLSearchParams(Object.entries(query).filter(([,v]) => v !== undefined).map(([k,v]) => [k, String(v)]));
    const runs: ChatClient = (...args) => {
      if (!options.runs) throw new ApiError(503, "DEPENDENCY_UNAVAILABLE");
      return options.runs(...args);
    };
    const runPath = (params: unknown) => "/runs/" + ResourceId.parse((params as { runId: string }).runId);
    routes.get("/runs", async req => runs(ctx(req), "GET", "/runs" + queryString(RunListQuery.parse(req.query)), RunPage));
    routes.get("/runs/:runId", async req => runs(ctx(req), "GET", runPath(req.params), Run));
    routes.get("/runs/:runId/workflow", async req => {
      z.object({}).strict().parse(req.query);
      return runs(ctx(req), "GET", runPath(req.params) + "/workflow", WorkflowProgress);
    });
    routes.post("/runs/:runId/cancel", async req => {
      z.object({}).strict().optional().parse(req.body);
      return runs(ctx(req), "POST", runPath(req.params) + "/cancel", Run);
    });
    routes.post("/workspaces/ensure", async req => {
      z.object({}).strict().optional().parse(req.body);
      return workspace(ctx(req), "POST", "/workspaces/ensure", Workspace);
    });
    routes.get("/workspaces/:workspaceId", async req => workspace(ctx(req), "GET", workspacePath(req.params), Workspace));
    routes.get("/workspaces/:workspaceId/files", async req =>
      workspace(ctx(req), "GET", workspacePath(req.params) + "/files" + queryString(FileListQuery.parse(req.query)), FilePage));
    routes.get("/workspaces/:workspaceId/file", async req =>
      workspace(ctx(req), "GET", workspacePath(req.params) + "/file" + queryString(FileQuery.parse(req.query)), TextFile));
    routes.put("/workspaces/:workspaceId/file", async req => {
      z.object({}).strict().parse(req.query);
      return workspace(ctx(req), "PUT", workspacePath(req.params) + "/file", FileMetadata, WriteTextFile.parse(req.body));
    });
    routes.delete("/workspaces/:workspaceId/file", async req =>
      workspace(ctx(req), "DELETE", workspacePath(req.params) + "/file" + queryString(DeleteFileQuery.parse(req.query)),
        DeleteFileResult));
    routes.get("/definitions", async req => catalog(ctx(req), "GET", "/definitions", DefinitionPage));
    routes.get("/definitions/:id/versions/:version", async req => {
      const params = z.object({ id: IdentityId, version: z.coerce.number().int().positive() }).parse(req.params);
      return catalog(ctx(req), "GET", "/definitions/" + params.id + "/versions/" + params.version, AgentDefinition);
    });
    routes.post("/sessions", async (req, reply) => {
      const body = CreateSession.parse(req.body);
      const key = IdempotencyKey.parse(req.headers["idempotency-key"]);
      return reply.code(201).send(await options.chat(ctx(req), "POST", "/sessions", Session, body, key));
    });
    routes.get("/sessions", async req =>
      options.chat(ctx(req), "GET", "/sessions" + pageQuery(req.query), SessionPage));
    routes.get("/sessions/:sessionId", async req =>
      options.chat(ctx(req), "GET", sessionPath(req.params), Session));
    routes.patch("/sessions/:sessionId", async req => {
      z.object({}).strict().parse(req.query);
      return options.chat(ctx(req), "PATCH", sessionPath(req.params), Session, UpdateSession.parse(req.body));
    });
    routes.get("/sessions/:sessionId/history", async req =>
      options.chat(ctx(req), "GET", sessionPath(req.params) + "/history" + pageQuery(req.query), MessagePage));
    routes.post("/sessions/:sessionId/messages", async (req, reply) => {
      const body = SendMessage.parse(req.body);
      const key = IdempotencyKey.parse(req.headers["idempotency-key"]);
      return reply.code(202).send(await options.chat(ctx(req), "POST", sessionPath(req.params) + "/messages", Message, body, key));
    });
    routes.post("/sessions/:sessionId/subscription", async req =>
      options.chat(ctx(req), "POST", sessionPath(req.params) + "/subscription", Subscription));
  }, { prefix: "/api/v1" });
  return app;
}

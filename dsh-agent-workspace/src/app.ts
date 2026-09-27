import Fastify from "fastify";
import { registerMetrics, type MetricsOptions } from "./metrics.js";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { ResourceId, FileQuery, DeleteFileQuery, FileListQuery, WriteTextFile, WorkspaceToolCall, type WorkspaceAuthorization } from "@dsh-agent/contracts";
import { WorkspaceError } from "./errors.js";
import type { WorkspaceRepository } from "./repository.js";
import type { Caller } from "./auth.js";
export function createWorkspaceApp(options: {
  metrics?: MetricsOptions;
  repository: WorkspaceRepository; authenticate: (header?: string) => Promise<Caller>;
  authorizeExecution?: (header: string | undefined, tool: WorkspaceToolCall["tool"]) => Promise<WorkspaceAuthorization>;
  ready: () => Promise<void>; logger?: boolean;
}) {
  const app = Fastify({ bodyLimit: 512 * 1024, genReqId: () => randomUUID(),
    logger: options.logger ? { redact: ["req.headers.authorization", "req.headers.cookie"] } : false });
  app.setErrorHandler((err, req, reply) => {
    const status = err instanceof WorkspaceError ? err.status : err instanceof z.ZodError ? 400 :
      err instanceof Error && "statusCode" in err && typeof err.statusCode === "number" ? err.statusCode : 500;
    const code = err instanceof WorkspaceError ? err.code : status < 500 ? "INVALID_REQUEST" : "INTERNAL_ERROR";
    reply.code(status).send({ error: { code, message: code, requestId: req.id } });
  });
  app.addHook("onSend", async (req, reply) => { reply.header("cache-control", "no-store").header("x-request-id", req.id); });
  registerMetrics(app, options.metrics);
  app.get("/health/live", async () => ({ status: "ok" }));
  app.get("/health/ready", async (_req, reply) => {
    try { await options.ready(); return { status: "ok" }; }
    catch { return reply.code(503).send({ status: "unavailable" }); }
  });
  app.register(async routes => {
    const callers = new WeakMap<object, Caller>();
    routes.addHook("onRequest", async req => { callers.set(req, await options.authenticate(req.headers.authorization)); });
    const id = (params: unknown) => ResourceId.parse((params as { workspaceId: string }).workspaceId);
    const apiActor = (req: object) => {
      const caller = callers.get(req)!;
      if (caller.service !== "dsh-agent-api") throw new WorkspaceError(403, "FORBIDDEN");
      return caller.actor;
    };
    routes.post("/workspaces/ensure", async req => {
      z.object({}).strict().optional().parse(req.body);
      return options.repository.ensure(callers.get(req)!.actor);
    });
    routes.get("/workspaces/:workspaceId", async req => options.repository.get(apiActor(req), id(req.params)));
    routes.get("/workspaces/:workspaceId/files", async req =>
      options.repository.list(apiActor(req), id(req.params), FileListQuery.parse(req.query)));
    routes.get("/workspaces/:workspaceId/file", async req =>
      options.repository.read(apiActor(req), id(req.params), FileQuery.parse(req.query).path));
    routes.put("/workspaces/:workspaceId/file", async req => {
      z.object({}).strict().parse(req.query);
      return options.repository.write(apiActor(req), id(req.params), WriteTextFile.parse(req.body));
    });
    routes.delete("/workspaces/:workspaceId/file", async req => {
      const query = DeleteFileQuery.parse(req.query);
      return options.repository.delete(apiActor(req), id(req.params), query.path, query.expectedVersion);
    });
  }, { prefix: "/internal/v1" });
  app.post("/execution/v1/tools", async req => {
    if (!options.authorizeExecution) throw new WorkspaceError(401, "UNAUTHENTICATED");
    z.object({}).strict().parse(req.query);
    const call = WorkspaceToolCall.parse(req.body);
    const scope = await options.authorizeExecution(req.headers.authorization, call.tool);
    const guard = async () => {
      const current = await options.authorizeExecution!(req.headers.authorization, call.tool);
      if (current.workspaceId !== scope.workspaceId || current.actor.uid !== scope.actor.uid ||
        current.actor.tenantId !== scope.actor.tenantId || current.runId !== scope.runId ||
        current.leaseId !== scope.leaseId || current.attempt !== scope.attempt || current.workerId !== scope.workerId || current.tool !== call.tool) {
        throw new WorkspaceError(403, "FORBIDDEN");
      }
    };
    switch (call.tool) {
      case "workspace.list": return { tool: call.tool, result: await options.repository.list(scope.actor, scope.workspaceId, call.arguments, guard) };
      case "workspace.read": return { tool: call.tool, result: await options.repository.read(scope.actor, scope.workspaceId, call.arguments.path, guard) };
      case "workspace.write": return { tool: call.tool, result: await options.repository.write(scope.actor, scope.workspaceId, call.arguments, guard) };
    }
  });
  return app;
}

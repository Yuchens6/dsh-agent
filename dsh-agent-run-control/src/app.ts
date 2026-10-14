import Fastify from "fastify";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { ResourceId, RunListQuery, RunLease, FinishRun, WorkspaceAuthorizationRequest, type WorkspaceRunReference, type WorkspaceCapability, type Principal, type ExecutionInput, type Run } from "@dsh-agent/contracts";
import { RunError, type RunRepository } from "./repository.js";
import { registerMetrics, type MetricsOptions } from "./metrics.js";
import { WorkerUsageReport } from "@dsh-agent/contracts";
import { DatabaseCapacityError } from "./capacity.js";
import { KnowledgeAuthorizationRequest } from "@dsh-agent/contracts";
export function createRunControlApp(options: {
  repository: RunRepository;
  metrics?: MetricsOptions;
  authenticateApi: (header?: string) => Promise<Principal>;
  authenticateWorker: (header?: string) => Promise<string>;
  resolveInput?: (actor: Principal, run: Run) => Promise<ExecutionInput>;
  reserveQuota?: (actor: Principal, input: ExecutionInput, deadlineAt: string) => Promise<void>;
  authenticateWorkspace?: (header?: string) => Promise<void>;
  signWorkspaceCapability?: (reference: WorkspaceRunReference, expiresAt: number) => Promise<WorkspaceCapability>;
  authenticateKnowledge?: (header?: string) => Promise<void>;
  signKnowledgeCapability?: (reference: WorkspaceRunReference, expiresAt: number) => Promise<WorkspaceCapability>;
  ready: () => Promise<void>; logger?: boolean;
}) {
  const app = Fastify({ bodyLimit: 256 * 1024, genReqId: () => randomUUID(),
    logger: options.logger ? { redact: ["req.headers.authorization", "req.headers.cookie"] } : false });
  app.setErrorHandler((err, req, reply) => {
    const status = err instanceof RunError ? err.status : err instanceof z.ZodError ? 400 :
      err instanceof Error && "statusCode" in err && typeof err.statusCode === "number" ? err.statusCode : 500;
    const code = err instanceof DatabaseCapacityError ? "DEPENDENCY_UNAVAILABLE" : err instanceof RunError ? err.code : status < 500 ? "INVALID_REQUEST" : "INTERNAL_ERROR";
    if(status===503) reply.header("retry-after",1);
    reply.code(status).send({ error: { code, message: code, requestId: req.id } });
  });
  app.addHook("onSend", async (req, reply) => { reply.header("cache-control", "no-store").header("x-request-id", req.id); });
  registerMetrics(app, options.metrics);
  app.get("/health/live", async () => ({ status: "ok" }));
  app.get("/health/ready", async (_req, reply) => {
    try { await options.ready(); return { status: "ok" }; }
    catch { return reply.code(503).send({ status: "unavailable" }); }
  });
  const id = (params: unknown) => ResourceId.parse((params as { runId: string }).runId);
  app.register(async routes => {
    const actors = new WeakMap<object, Principal>();
    routes.addHook("onRequest", async req => { actors.set(req, await options.authenticateApi(req.headers.authorization)); });
    routes.get("/runs", async req => options.repository.list(actors.get(req)!, RunListQuery.parse(req.query)));
    routes.get("/runs/:runId", async req => options.repository.get(actors.get(req)!, id(req.params)));
    routes.get("/runs/:runId/workflow", async req => {
      z.object({}).strict().parse(req.query);
      return options.repository.workflowProgress(actors.get(req)!, id(req.params));
    });
    routes.post("/runs/:runId/cancel", async req => {
      z.object({}).strict().optional().parse(req.body);
      return options.repository.cancel(actors.get(req)!, id(req.params));
    });
  }, { prefix: "/internal/v1" });
  app.register(async routes => {
    const workers = new WeakMap<object, string>();
    routes.addHook("onRequest", async req => {
      workers.set(req, await options.authenticateWorker(req.headers.authorization));
      z.object({}).strict().parse(req.query);
    });
    routes.post("/claim", async req => {
      z.object({}).strict().optional().parse(req.body);
      return { claim: await options.repository.claim(workers.get(req)!) };
    });
    routes.post("/runs/:runId/heartbeat", async req =>
      options.repository.heartbeat(workers.get(req)!, id(req.params), RunLease.parse(req.body)));
    routes.post("/runs/:runId/input", async req => {
      if (!options.resolveInput) throw new RunError(503, "DEPENDENCY_UNAVAILABLE");
      return options.repository.input(workers.get(req)!, id(req.params), RunLease.parse(req.body), options.resolveInput, options.reserveQuota);
    });
    routes.post("/runs/:runId/workspace-capability", async req => {
      if (!options.signWorkspaceCapability) throw new RunError(503, "DEPENDENCY_UNAVAILABLE");
      return options.repository.workspaceCapability(workers.get(req)!, id(req.params), RunLease.parse(req.body), options.signWorkspaceCapability);
    });
    routes.post("/runs/:runId/knowledge-capability", async req => {
      if (!options.signKnowledgeCapability) throw new RunError(503, "DEPENDENCY_UNAVAILABLE");
      return options.repository.knowledgeCapability(workers.get(req)!, id(req.params), RunLease.parse(req.body), options.signKnowledgeCapability);
    });
    routes.post("/runs/:runId/result", async req =>
      options.repository.finish(workers.get(req)!, id(req.params), FinishRun.parse(req.body)));
    routes.post("/runs/:runId/usage", async req => {
      const body = WorkerUsageReport.parse(req.body);
      return options.repository.reportUsage(workers.get(req)!, id(req.params), body.lease, body.report);
    });
    routes.post("/runs/:runId/progress", async req => options.repository.reportProgress(workers.get(req)!, id(req.params), req.body));
    routes.post("/runs/:runId/release", async req =>
      options.repository.release(workers.get(req)!, id(req.params), RunLease.parse(req.body)));
  }, { prefix: "/worker/v1" });
  app.register(async routes => {
    routes.addHook("onRequest", async req => {
      if (!options.authenticateWorkspace) throw new RunError(401, "UNAUTHENTICATED");
      await options.authenticateWorkspace(req.headers.authorization);
      z.object({}).strict().parse(req.query);
    });
    routes.post("/workspace", async req => options.repository.authorizeWorkspace(WorkspaceAuthorizationRequest.parse(req.body)));
  }, { prefix: "/authorization/v1" });
  app.post("/authorization/v1/knowledge", { onRequest: async req => {
    if (!options.authenticateKnowledge) throw new RunError(401, "UNAUTHENTICATED");
    await options.authenticateKnowledge(req.headers.authorization);
  } }, async req => {
    z.object({}).strict().parse(req.query);
    return options.repository.authorizeKnowledge(KnowledgeAuthorizationRequest.parse(req.body));
  });
  return app;
}

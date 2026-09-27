import Fastify from "fastify";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { IdentityId, type Principal } from "@dsh-agent/contracts";
import { CatalogError, type CatalogRepository } from "./repository.js";
export function createCatalogApp(options: {
  repository: CatalogRepository; authenticate: (header?: string) => Promise<Principal>;
  ready: () => Promise<void>; logger?: boolean;
}) {
  const app = Fastify({ bodyLimit: 128 * 1024, genReqId: () => randomUUID(),
    logger: options.logger ? { redact: ["req.headers.authorization", "req.headers.cookie"] } : false });
  app.setErrorHandler((err, req, reply) => {
    const status = err instanceof CatalogError ? err.status : err instanceof z.ZodError ? 400 :
      err instanceof Error && "statusCode" in err && typeof err.statusCode === "number" ? err.statusCode : 500;
    const code = err instanceof CatalogError ? err.code : status < 500 ? "INVALID_REQUEST" : "INTERNAL_ERROR";
    reply.code(status).send({ error: { code, message: code, requestId: req.id } });
  });
  app.addHook("onSend", async (req, reply) => { reply.header("cache-control", "no-store").header("x-request-id", req.id); });
  app.get("/health/live", async () => ({ status: "ok" }));
  app.get("/health/ready", async (_req, reply) => {
    try { await options.ready(); return { status: "ok" }; }
    catch { return reply.code(503).send({ status: "unavailable" }); }
  });
  app.register(async routes => {
    const actors = new WeakMap<object, Principal>();
    routes.addHook("onRequest", async req => { actors.set(req, await options.authenticate(req.headers.authorization)); });
    routes.get("/definitions", async req => options.repository.list(actors.get(req)!));
    routes.get("/definitions/default", async req => options.repository.getDefault(actors.get(req)!));
    routes.get("/definitions/:id/versions/:version", async req => {
      const params = z.object({ id: IdentityId, version: z.coerce.number().int().positive() }).parse(req.params);
      return options.repository.get(actors.get(req)!, params.id, params.version);
    });
  }, { prefix: "/internal/v1" });
  return app;
}

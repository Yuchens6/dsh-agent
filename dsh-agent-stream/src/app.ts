import Fastify from "fastify";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { z } from "zod";
import { PublicEvent, ResourceId, type Principal } from "@dsh-agent/contracts";
import { CursorExpired, type EventSource, type Subscription } from "./source.js";

export function createStreamApp(options: {
  authenticate: (header?: string) => Promise<{ actor: Principal; expiresAt: number }>;
  verifyCapability: (token: string, actor: Principal, sessionId: string) => Promise<number>;
  source: EventSource; ready?: () => Promise<void>; heartbeatMs?: number;
  maxConnections?: number; slowConsumerMs?: number; logger?: boolean;
}) {
  const app = Fastify({ genReqId: () => randomUUID(), logger: options.logger ?
    { redact: ["req.headers.authorization", "req.headers.x-session-capability", "req.headers.cookie"] } : false });
  const active = new Set<() => void>();
  app.addHook("preClose", async () => { for (const close of active) close(); });
  app.get("/health/live", async () => ({ status: "ok" }));
  app.get("/health/ready", async (_req, reply) => {
    try { await options.ready?.(); return { status: "ok" }; }
    catch { return reply.code(503).send({ status: "unavailable" }); }
  });
  app.get("/events/v1/sessions/:sessionId", async (req, reply) => {
    const error = (status: number, code: string) =>
      reply.code(status).send({ error: { code, message: code, requestId: req.id } });
    let sessionId: string;
    let after: number | undefined;
    try {
      sessionId = ResourceId.parse((req.params as { sessionId: string }).sessionId);
      z.object({}).strict().parse(req.query);
      const cursor = req.headers["last-event-id"];
      if (cursor !== undefined) {
        if (typeof cursor !== "string") throw new Error();
        const [scope, sequence, ...extra] = cursor.split(":");
        if (scope !== sessionId || extra.length || !/^[1-9][0-9]*$/.test(sequence ?? "")) throw new Error();
        after = Number(sequence);
        if (!Number.isSafeInteger(after)) throw new Error();
      }
    } catch { return error(400, "INVALID_REQUEST"); }
    let actor: Principal, expiresAt: number;
    try {
      const identity = await options.authenticate(req.headers.authorization);
      actor = identity.actor;
      const capability = req.headers["x-session-capability"];
      if (typeof capability !== "string") throw new Error();
      const capabilityExp = await options.verifyCapability(capability, actor, sessionId);
      expiresAt = Math.min(identity.expiresAt, capabilityExp);
      if (expiresAt * 1000 <= Date.now()) throw new Error();
    } catch { return error(401, "UNAUTHENTICATED"); }
    if (active.size >= (options.maxConnections ?? 1000)) return error(429, "TOO_MANY_CONNECTIONS");
    // 在异步打开消费者前预留容量，避免并发请求穿透连接限制。
    let subscription: Subscription | undefined;
    let closed = false;
    const controller = new AbortController();
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let expiry: ReturnType<typeof setTimeout> | undefined;
    const close = () => {
      if (closed) return;
      closed = true;
      controller.abort();
      clearInterval(heartbeat); clearTimeout(expiry);
      active.delete(close);
      void subscription?.close().catch(() => undefined);
      if (!reply.raw.writableEnded) reply.raw.end();
    };
    active.add(close);
    req.raw.once("aborted", close);
    reply.raw.once("close", close);
    try { subscription = await options.source.open(actor, sessionId, after); }
    catch (err) {
      active.delete(close);
      req.raw.off("aborted", close); reply.raw.off("close", close);
      return error(err instanceof CursorExpired ? 409 : 503,
        err instanceof CursorExpired ? "CURSOR_EXPIRED" : "DEPENDENCY_UNAVAILABLE");
    }
    if (closed) { await subscription.close(); return; }
    if (expiresAt * 1000 <= Date.now()) {
      await subscription.close();
      active.delete(close);
      req.raw.off("aborted", close); reply.raw.off("close", close);
      return error(401, "UNAUTHENTICATED");
    }
    reply.hijack();
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store",
      "connection": "keep-alive", "x-accel-buffering": "no", "x-request-id": req.id,
    });
    reply.raw.write("retry: 3000\n\n");
    heartbeat = setInterval(() => {
      if (!reply.raw.writableNeedDrain && !closed) reply.raw.write(": heartbeat\n\n");
    }, options.heartbeatMs ?? 20_000);
    expiry = setTimeout(close, Math.min(expiresAt * 1000 - Date.now(), 60_000));
    let last = after ?? 0;
    try {
      for await (const item of subscription) {
        if (closed || expiresAt * 1000 <= Date.now()) break;
        const parsed = PublicEvent.safeParse(item.event);
        if (!parsed.success || !Number.isSafeInteger(item.sequence) || item.sequence <= last) continue;
        const event = parsed.data;
        if (event.tenantId !== actor.tenantId || event.ownerUid !== actor.uid || event.sessionId !== sessionId) continue;
        last = item.sequence;
        const frame = "id: " + sessionId + ":" + item.sequence + "\nevent: " + event.eventType +
          "\ndata: " + JSON.stringify(event) + "\n\n";
        if (!reply.raw.write(frame)) {
          await once(reply.raw, "drain", { signal: AbortSignal.any([
            controller.signal, AbortSignal.timeout(options.slowConsumerMs ?? 5000),
          ]) });
        }
      }
    } catch {
      // 连接或代理故障：关闭连接，由客户端使用游标恢复。
    } finally { close(); }
  });
  return app;
}

import Fastify from "fastify";
import { readFile } from "node:fs/promises";
import { Readable } from "node:stream";

export function createWebApp(config: { apiUrl: string; streamUrl: string; issuer: string; publicOrigin: string; clientId: string }) {
  const publicUrl = new URL(config.publicOrigin);
  for (const value of [config.apiUrl, config.streamUrl, config.issuer, config.publicOrigin]) {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error("Invalid configured origin");
  }
  const app = Fastify({ bodyLimit: 512 * 1024, logger: false });
  app.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string" }, (_req, body, done) => done(null, body));
  app.addHook("onRequest", async (req, reply) => {
    const host = req.headers.host;
    // Localhost preview also permits the equivalent IPv4 probe address; no arbitrary Host forwarding.
    const hosts = new Set([publicUrl.host, ...(publicUrl.hostname === "localhost" ? [`127.0.0.1:${publicUrl.port}`] : [])]);
    if (!host || !hosts.has(host)) return reply.code(421).send({ error: { code: "INVALID_HOST" } });
    if (req.headers.origin && req.headers.origin !== publicUrl.origin) return reply.code(403).send({ error: { code: "FORBIDDEN" } });
  });
  app.addHook("onSend", async (_req, reply) => {
    reply.header("cache-control", "no-store").header("x-content-type-options", "nosniff").header("referrer-policy", "no-referrer")
      .header("content-security-policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  });
  app.setErrorHandler((_err, _req, reply) => reply.code(502).send({ error: { code: "DEPENDENCY_UNAVAILABLE" } }));
  app.get("/health/ready", async () => ({ status: "ok" }));
  app.get("/config", async () => ({ issuer: config.issuer, clientId: config.clientId, redirectUri: publicUrl.origin + "/callback" }));
  const assets = { "/": ["index.html", "text/html"], "/callback": ["index.html", "text/html"],
    "/app.mjs": ["app.mjs", "text/javascript"], "/model.mjs": ["model.mjs", "text/javascript"], "/style.css": ["style.css", "text/css"] };
  for (const [path, [file, type]] of Object.entries(assets)) app.get(path, async (_req, reply) =>
    reply.type(type! + "; charset=utf-8").send(await readFile(new URL("../public/" + file, import.meta.url))));

  app.route({ method: ["GET", "POST", "PUT", "PATCH", "DELETE"], url: "/api/v1/*", handler: proxy(config.apiUrl, false) });
  app.get("/events/v1/sessions/:id", proxy(config.streamUrl, true));
  app.post("/auth/token", proxy(config.issuer, false, "/protocol/openid-connect/token"));
  function proxy(origin: string, events: boolean, suffix?: string) {
    return async (req: import("fastify").FastifyRequest, reply: import("fastify").FastifyReply) => {
      const controller = new AbortController();
      reply.raw.once("close", () => controller.abort());
      const headers: Record<string, string> = {};
      for (const name of ["authorization", "content-type", "idempotency-key", "x-session-capability", "last-event-id"]) {
        const value = req.headers[name]; if (typeof value === "string") headers[name] = value;
      }
      if (suffix) {
        if (typeof req.body !== "string" || req.body.length > 16000) return reply.code(400).send({ error: { code: "INVALID_REQUEST" } });
        const params = new URLSearchParams(req.body);
        if (params.get("client_id") !== config.clientId || !["authorization_code", "refresh_token"].includes(params.get("grant_type") ?? ""))
          return reply.code(400).send({ error: { code: "INVALID_REQUEST" } });
        if (params.get("grant_type") === "authorization_code" && params.get("redirect_uri") !== publicUrl.origin + "/callback")
          return reply.code(400).send({ error: { code: "INVALID_REQUEST" } });
        delete headers.authorization;
      }
      const upstream = await fetch(suffix ? origin.replace(/\/$/, "") + suffix : origin + req.raw.url, {
        method: req.method, headers, redirect: "error", signal: AbortSignal.any([controller.signal, AbortSignal.timeout(events ? 90000 : 30000)]),
        ...(req.body === undefined ? {} : { body: typeof req.body === "string" ? req.body : JSON.stringify(req.body) }),
      });
      reply.code(upstream.status);
      for (const name of ["content-type", "retry-after", "x-request-id"]) {
        const value = upstream.headers.get(name); if (value) reply.header(name, value);
      }
      if (events) reply.header("x-accel-buffering", "no");
      return upstream.body ? reply.send(Readable.fromWeb(upstream.body as import("node:stream/web").ReadableStream)) : reply.send();
    };
  }
  return app;
}

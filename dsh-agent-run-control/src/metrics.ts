import { createHash, timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";
export interface MetricsOptions { secret: string; snapshot: () => Promise<Record<string, number>> }
export function registerMetrics(app: FastifyInstance, options?: MetricsOptions) {
 if (!options) return;
 if (Buffer.byteLength(options.secret) < 32) throw new Error("Strong metrics credential required");
 const expected = createHash("sha256").update("Bearer " + options.secret).digest();
 let collecting: Promise<Record<string, number>> | undefined;
 app.get("/metrics", async (req, reply) => {
  const actual = createHash("sha256").update(req.headers.authorization ?? "").digest();
  reply.header("cache-control", "no-store");
  if (!timingSafeEqual(expected, actual)) return reply.code(401).send({ error: "UNAUTHENTICATED" });
  // 合并同时抓取，避免监控请求重复扫描业务表；不跨抓取周期缓存结果。
  const pending = collecting ??= Promise.resolve().then(options.snapshot);
  try {
   const values = await pending;
   const lines: string[] = [];
   for (const [key, value] of Object.entries(values)) {
    if (!/^[a-z][a-z0-9_]*$/.test(key) || !Number.isFinite(value) || value < 0) throw new Error("Invalid metric");
    const name = "dsh_run_control_" + key;
    lines.push("# TYPE " + name + (key.endsWith("_total") ? " counter" : " gauge"), name + " " + value);
   }
   return reply.type("text/plain; version=0.0.4; charset=utf-8").send(lines.join("\n") + "\n");
  } catch { return reply.code(503).type("text/plain").send("Metrics unavailable\n"); }
  finally { if (collecting === pending) collecting = undefined; }
 });
}

import { SignJWT } from "jose";
import { z } from "zod";
import { AuditRecord, QuotaClose, QuotaReserve, ModelUsageEvent, type Principal, type ExecutionInput } from "@dsh-agent/contracts";
import { RunError } from "./repository.js";
export function supportClient(config: { quotaUrl: string; auditUrl: string; quotaSecret: string; auditSecret: string }) {
  if (config.quotaSecret === config.auditSecret || [config.quotaSecret, config.auditSecret].some(s => Buffer.byteLength(s) < 32)) throw new Error("Distinct service secrets required");
  for (const value of [config.quotaUrl, config.auditUrl]) {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || url.pathname !== "/" || url.search || url.hash || url.username || url.password) throw new Error("Service origin required");
  }
  async function request(service: "quota" | "audit", path: string, body: unknown, schema: z.ZodType) {
    const token = await new SignJWT({}).setProtectedHeader({ alg: "HS256", typ: "JWT" }).setIssuer("dsh-agent-run-control")
      .setAudience("dsh-agent-" + service).setIssuedAt().setExpirationTime("30s").sign(new TextEncoder().encode(service === "quota" ? config.quotaSecret : config.auditSecret));
    try {
      const response = await fetch(new URL("/control/v1/" + path, service === "quota" ? config.quotaUrl : config.auditUrl), {
        method: "POST", redirect: "error", signal: AbortSignal.timeout(2000), headers: { authorization: "Bearer " + token, "content-type": "application/json" }, body: JSON.stringify(body) });
      if (!response.ok) { await response.body?.cancel(); throw new RunError(response.status === 429 ? 429 : 503, response.status === 429 ? "QUOTA_EXCEEDED" : "DEPENDENCY_UNAVAILABLE"); }
      const reader = response.body?.getReader(); if (!reader) throw new Error();
      const chunks: Uint8Array[] = []; let size = 0;
      try { while (true) { const part = await reader.read(); if (part.done) break; size += part.value.byteLength; if (size > 4096) throw new Error(); chunks.push(part.value); } }
      finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
      schema.parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    } catch (error) { if (error instanceof RunError) throw error; throw new RunError(503, "DEPENDENCY_UNAVAILABLE"); }
  }
  return {
    async reserve(actor: Principal, input: ExecutionInput, deadlineAt: string) {
      await request("quota", "reserve", QuotaReserve.parse({ actor, runId: input.runId,
        outputTokenBudget: input.definition.execution.maxTurns * input.definition.execution.maxOutputTokens,
        billingModel: input.definition.model,
        deadlineAt: new Date(Date.parse(deadlineAt) + 60_000).toISOString() }), z.object({ reserved: z.literal(true) }).strict());
    },
    async deliver(kind: "audit" | "quota-close" | "model-usage", payload: unknown) {
      if (kind === "audit") await request("audit", "records", AuditRecord.parse(payload), z.object({ recorded: z.literal(true) }).strict());
      else if (kind === "model-usage") await request("quota", "usage", ModelUsageEvent.parse(payload), z.object({ recorded: z.literal(true) }).strict());
      else await request("quota", "close", QuotaClose.parse(payload), z.object({ closed: z.literal(true) }).strict());
    },
  };
}

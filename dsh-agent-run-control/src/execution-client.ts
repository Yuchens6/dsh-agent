import { SignJWT } from "jose";
import { z } from "zod";
import { AgentDefinition, ExecutionContext, AssistantMessage, ExecutionInput, type AssistantResult, type Principal, type Run } from "@dsh-agent/contracts";
import { RunError } from "./repository.js";

export function executionClient(config: { chatUrl: string; catalogUrl: string; chatSecret: string; catalogSecret: string }) {
  if (config.chatSecret === config.catalogSecret || [config.chatSecret, config.catalogSecret].some(s => Buffer.byteLength(s) < 32)) {
    throw new Error("Distinct service secrets required");
  }
  for (const value of [config.chatUrl, config.catalogUrl]) {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
      throw new Error("Service URL must be an HTTP origin");
    }
  }
  async function request<T>(service: "chat" | "catalog", actor: Principal, path: string, schema: z.ZodType<T>, body?: unknown): Promise<T> {
    const key = new TextEncoder().encode(service === "chat" ? config.chatSecret : config.catalogSecret);
    const token = await new SignJWT({ actor }).setProtectedHeader({ alg: "HS256", typ: "JWT" })
      .setIssuer("dsh-agent-run-control").setAudience("dsh-agent-" + service).setSubject(actor.uid)
      .setIssuedAt().setExpirationTime("30s").sign(key);
    try {
      const response = await fetch(new URL(path, service === "chat" ? config.chatUrl : config.catalogUrl), {
        method: body === undefined ? "GET" : "POST", redirect: "error", signal: AbortSignal.timeout(5000),
        headers: { authorization: "Bearer " + token, ...(body === undefined ? {} : { "content-type": "application/json" }) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      if (!response.ok) {
        await response.body?.cancel();
        if (response.status === 404) throw new RunError(404, "NOT_FOUND");
        if (response.status === 409) throw new RunError(409, "INVALID_STATE");
        throw new Error("Dependency rejected request");
      }
      // 在读取过程中限制大小，不先把不可信响应全部放入内存。
      const reader = response.body?.getReader();
      if (!reader) throw new Error("Missing body");
      const chunks: Uint8Array[] = []; let size = 0;
      try {
        while (true) {
          const part = await reader.read();
          if (part.done) break;
          size += part.value.byteLength;
          if (size > 1024 * 1024) throw new Error("Oversized dependency response");
          chunks.push(part.value);
        }
      } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
      return schema.parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    } catch (error) {
      if (error instanceof RunError) throw error;
      throw new RunError(503, "DEPENDENCY_UNAVAILABLE");
    }
  }
  return {
    async resolve(actor: Principal, run: Run): Promise<ExecutionInput> {
      const context = await request("chat", actor, `/execution/v1/sessions/${run.sessionId}/messages/${run.messageId}/context`, ExecutionContext);
      const definition = await request("catalog", actor,
        `/internal/v1/definitions/${context.binding.agentDefinitionId}/versions/${context.binding.agentDefinitionVersion}`, AgentDefinition);
      return ExecutionInput.parse({ runId: run.id, context, definition, capturedAt: new Date().toISOString() });
    },
    async project(actor: Principal, sessionId: string, result: AssistantResult) {
      const message = await request("chat", actor, `/execution/v1/sessions/${sessionId}/assistant-results`, AssistantMessage, result);
      if (message.sessionId !== sessionId || message.runId !== result.runId || message.replyToMessageId !== result.messageId || message.content !== result.output) {
        throw new RunError(503, "DEPENDENCY_UNAVAILABLE");
      }
    },
  };
}

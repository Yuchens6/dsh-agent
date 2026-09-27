import { SignJWT } from "jose";
import type { z } from "zod";
import { ErrorEnvelope, type Principal, type ErrorCode } from "@dsh-agent/contracts";

export class ApiError extends Error {
  constructor(public status: number, public code: ErrorCode, public retryAfter = 1) { super(code); }
}
export interface CallContext { actor: Principal; requestId: string; signal: AbortSignal }
export type ChatClient = <T>(context: CallContext, method: string, path: string,
  schema: z.ZodType<T>, body?: unknown, key?: string) => Promise<T>;

export function chatClient(baseUrl: string, secret: string): ChatClient {
  return serviceClient(baseUrl, secret, "dsh-agent-chat");
}
export function serviceClient(baseUrl: string, secret: string,
  audience: "dsh-agent-chat" | "dsh-agent-workspace" | "dsh-agent-catalog" | "dsh-agent-run-control" | "dsh-agent-quota" | "dsh-agent-audit"): ChatClient {
  const serviceKey = new TextEncoder().encode(secret);
  if (serviceKey.length < 32) throw new Error("Service secret requires at least 32 bytes");
  const origin = new URL(baseUrl);
  if (!["http:", "https:"].includes(origin.protocol) || origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash) throw new Error("Service origin required");
  return async (ctx, method, path, schema, body, key) => {
    const token = await new SignJWT({ actor: ctx.actor })
      .setProtectedHeader({ alg: "HS256", typ: "JWT" }).setIssuer("dsh-agent-api")
      .setAudience(audience).setIssuedAt().setExpirationTime("30s").sign(serviceKey);
    try {
      const headers: Record<string, string> = {
        authorization: "Bearer " + token, "x-request-id": ctx.requestId,
      };
      if (body !== undefined) headers["content-type"] = "application/json";
      if (key) headers["idempotency-key"] = key;
      const response = await fetch(new URL("/internal/v1" + path, baseUrl), {
        method, headers, body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(5000)]), redirect: "error",
      });
      const readJson = async () => {
        const reader = response.body?.getReader(); if (!reader) throw new Error("Missing response");
        const chunks: Uint8Array[] = []; let size = 0;
        try { while (true) { const part = await reader.read(); if (part.done) break; size += part.value.byteLength;
          // 一页会话历史最多一百条、每条三万二千字符，需容纳最坏的 UTF-8 编码。
          if (size > (response.ok ? 16 * 1024 * 1024 : 16 * 1024)) throw new Error("Response too large"); chunks.push(part.value);
        } } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
        return JSON.parse(Buffer.concat(chunks).toString("utf8"));
      };
      if (!response.ok) {
        // 只放行明确的公开业务错误，内部消息与未知错误不向客户端透传。
        if (response.status === 409 || response.status === 429) {
          const parsed = ErrorEnvelope.safeParse(await readJson());
          const allowed = response.status === 409 ? ["IDEMPOTENCY_CONFLICT", "VERSION_CONFLICT", "INVALID_STATE"] : ["QUOTA_EXCEEDED"];
          if (parsed.success && allowed.includes(parsed.data.error.code)) {
            const value = Number(response.headers.get("retry-after"));
            throw new ApiError(response.status, parsed.data.error.code, Number.isInteger(value) && value >= 1 && value <= 3600 ? value : 1);
          }
          throw new ApiError(503, "DEPENDENCY_UNAVAILABLE");
        }
        await response.body?.cancel();
        if (response.status === 404) throw new ApiError(404, "NOT_FOUND");
        if (response.status === 400) throw new ApiError(400, "INVALID_REQUEST");
        throw new ApiError(503, "DEPENDENCY_UNAVAILABLE");
      }
      return schema.parse(await readJson());
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError(503, "DEPENDENCY_UNAVAILABLE");
    }
  };
}

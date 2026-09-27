import { jwtVerify, SignJWT } from "jose";
import { WorkspaceRunReference, WorkspaceAuthorization, type WorkspaceToolCall } from "@dsh-agent/contracts";
import { WorkspaceError } from "./errors.js";

export function executionAuthorizer(config: { capabilitySecret: string; serviceSecret: string; runControlUrl: string }) {
  const capabilityKey = new TextEncoder().encode(config.capabilitySecret), serviceKey = new TextEncoder().encode(config.serviceSecret);
  if (capabilityKey.length < 32 || serviceKey.length < 32 || config.capabilitySecret === config.serviceSecret) throw new Error("Distinct service secrets required");
  const base = new URL(config.runControlUrl);
  if (!["http:", "https:"].includes(base.protocol) || base.username || base.password || base.search || base.hash || base.pathname !== "/") {
    throw new Error("Run Control URL must be an HTTP origin");
  }
  async function verify(header?: string) {
    try {
      if (!header?.startsWith("Bearer ")) throw new Error();
      const { payload } = await jwtVerify(header.slice(7), capabilityKey, { algorithms: ["HS256"],
        issuer: "dsh-agent-run-control", audience: "dsh-agent-workspace-execution",
        requiredClaims: ["iat", "exp"], maxTokenAge: "30s" });
      if (payload.scope !== "workspace:execute" || payload.exp! - payload.iat! > 30) throw new Error();
      return WorkspaceRunReference.parse(payload.reference);
    } catch { throw new WorkspaceError(401, "UNAUTHENTICATED"); }
  }
  return async (header: string | undefined, tool: WorkspaceToolCall["tool"]): Promise<WorkspaceAuthorization> => {
    const reference = await verify(header);
    const token = await new SignJWT({ scope: "workspace:authorize" }).setProtectedHeader({ alg: "HS256", typ: "JWT" })
      .setIssuer("dsh-agent-workspace").setAudience("dsh-agent-run-control-authorization")
      .setIssuedAt().setExpirationTime("30s").sign(serviceKey);
    try {
      const response = await fetch(new URL("/authorization/v1/workspace", base), {
        method: "POST", redirect: "error", signal: AbortSignal.timeout(2000),
        headers: { authorization: "Bearer " + token, "content-type": "application/json" }, body: JSON.stringify({ ...reference, tool }),
      });
      if (!response.ok) {
        await response.body?.cancel();
        if (response.status === 403) throw new WorkspaceError(403, "FORBIDDEN");
        if (response.status === 409) throw new WorkspaceError(409, "LEASE_LOST");
        throw new Error("Authorization unavailable");
      }
      const reader = response.body?.getReader();
      if (!reader) throw new Error();
      const chunks: Uint8Array[] = []; let size = 0;
      try {
        while (true) {
          const part = await reader.read(); if (part.done) break;
          size += part.value.byteLength;
          if (size > 16 * 1024) throw new Error("Oversized authorization");
          chunks.push(part.value);
        }
      } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
      const authorized = WorkspaceAuthorization.parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      if (authorized.runId !== reference.runId || authorized.workerId !== reference.workerId ||
        authorized.leaseId !== reference.leaseId || authorized.attempt !== reference.attempt || authorized.tool !== tool) throw new Error("Mismatched authorization");
      await verify(header); // 网络等待期间也可能到期；不缓存肯定授权。
      if (Date.parse(authorized.leaseExpiresAt) <= Date.now()) throw new WorkspaceError(409, "LEASE_LOST");
      return authorized;
    } catch (error) {
      if (error instanceof WorkspaceError) throw error;
      throw new WorkspaceError(503, "DEPENDENCY_UNAVAILABLE");
    }
  };
}

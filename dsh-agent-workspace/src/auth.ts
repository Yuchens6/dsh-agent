import { jwtVerify } from "jose";
import { Principal } from "@dsh-agent/contracts";
import { WorkspaceError } from "./errors.js";
export interface Caller { actor: Principal; service: "dsh-agent-api" | "dsh-agent-chat" }
export function serviceVerifier(secrets: { api: string; chat: string }) {
  const keys = { "dsh-agent-api": new TextEncoder().encode(secrets.api), "dsh-agent-chat": new TextEncoder().encode(secrets.chat) };
  if (Object.values(keys).some(key => key.length < 32) || secrets.api === secrets.chat) throw new Error("Distinct service secrets required");
  return async (header?: string): Promise<Caller> => {
    if (header?.startsWith("Bearer ")) {
      for (const service of ["dsh-agent-api", "dsh-agent-chat"] as const) {
        try {
          const { payload } = await jwtVerify(header.slice(7), keys[service], {
            algorithms: ["HS256"], issuer: service, audience: "dsh-agent-workspace",
            requiredClaims: ["exp", "iat"], maxTokenAge: "60s",
          });
          return { actor: Principal.parse(payload.actor), service };
        } catch {
          // 继续检查另一独立签发者；不从未经验证的载荷授予权限。
        }
      }
    }
    throw new WorkspaceError(401, "UNAUTHENTICATED");
  };
}

import { jwtVerify } from "jose";
import { Principal } from "@dsh-agent/contracts";
import { CatalogError } from "./repository.js";
export function serviceVerifier(secrets: { api: string; chat: string; runControl?: string }, allowedIssuers?: string[]) {
  const entries = [["dsh-agent-api", secrets.api], ["dsh-agent-chat", secrets.chat],
    ...(secrets.runControl === undefined ? [] : [["dsh-agent-run-control", secrets.runControl]])] as Array<[string, string]>;
  if (entries.some(([, key]) => Buffer.byteLength(key) < 32) || new Set(entries.map(([, key]) => key)).size !== entries.length) throw new Error("Distinct service secrets required");
  return async (header?: string): Promise<Principal> => {
    if (header?.startsWith("Bearer ")) for (const [issuer, secret] of entries) {
      if (allowedIssuers && !allowedIssuers.includes(issuer)) continue;
      try {
        const { payload } = await jwtVerify(header.slice(7), new TextEncoder().encode(secret), {
          algorithms: ["HS256"], issuer, audience: "dsh-agent-catalog",
          requiredClaims: ["exp", "iat"], maxTokenAge: "60s",
        });
        return Principal.parse(payload.actor);
      } catch {
        // 不同调用服务使用独立凭据。
      }
    }
    throw new CatalogError(401, "UNAUTHENTICATED");
  };
}

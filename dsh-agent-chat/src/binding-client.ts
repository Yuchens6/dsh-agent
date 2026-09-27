import { SignJWT } from "jose";
import { z } from "zod";
import { AgentDefinition, Workspace, type Principal, type SessionBinding } from "@dsh-agent/contracts";
import { ChatError } from "./repository.js";
export function bindingResolver(config: {
  workspaceUrl: string; workspaceSecret: string; catalogUrl: string; catalogSecret: string;
}): (actor: Principal) => Promise<SessionBinding> {
  if (Buffer.byteLength(config.workspaceSecret) < 32 || Buffer.byteLength(config.catalogSecret) < 32 ||
    config.workspaceSecret === config.catalogSecret) throw new Error("Distinct service secrets required");
  async function call<T>(actor: Principal, url: string, secret: string, audience: string,
    method: string, path: string, schema: z.ZodType<T>) {
    const token = await new SignJWT({ actor }).setProtectedHeader({ alg: "HS256", typ: "JWT" })
      .setIssuer("dsh-agent-chat").setAudience(audience).setIssuedAt().setExpirationTime("30s")
      .sign(new TextEncoder().encode(secret));
    try {
      const response = await fetch(new URL("/internal/v1" + path, url), {
        method, headers: { authorization: "Bearer " + token }, redirect: "error", signal: AbortSignal.timeout(3000),
      });
      if (!response.ok) { await response.body?.cancel(); throw new Error(); }
      return schema.parse(await response.json());
    } catch { throw new ChatError(503, "DEPENDENCY_UNAVAILABLE"); }
  }
  return async actor => {
    const [workspace, definition] = await Promise.all([
      call(actor, config.workspaceUrl, config.workspaceSecret, "dsh-agent-workspace", "POST", "/workspaces/ensure", Workspace),
      call(actor, config.catalogUrl, config.catalogSecret, "dsh-agent-catalog", "GET", "/definitions/default", AgentDefinition),
    ]);
    return { workspaceId: workspace.id, agentDefinitionId: definition.id, agentDefinitionVersion: definition.version };
  };
}

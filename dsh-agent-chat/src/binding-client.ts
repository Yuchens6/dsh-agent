import { SignJWT } from "jose";
import { z } from "zod";
import { AgentDefinition, Workspace, DefinitionReference, type Principal, type SessionBinding } from "@dsh-agent/contracts";
import { ChatError } from "./repository.js";
export function bindingResolver(config: {
  workspaceUrl: string; workspaceSecret: string; catalogUrl: string; catalogSecret: string;
}): (actor: Principal, definition?: DefinitionReference) => Promise<SessionBinding> {
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
      if (!response.ok) {
        await response.body?.cancel();
        if (response.status === 404 && path.startsWith("/definitions/") && path !== "/definitions/default") throw new ChatError(404, "NOT_FOUND");
        throw new Error();
      }
      return schema.parse(await response.json());
    } catch (error) { if (error instanceof ChatError) throw error; throw new ChatError(503, "DEPENDENCY_UNAVAILABLE"); }
  }
  return async (actor, selection) => {
    const definitionRef = selection === undefined ? undefined : DefinitionReference.parse(selection);
    const [workspace, definition] = await Promise.all([
      call(actor, config.workspaceUrl, config.workspaceSecret, "dsh-agent-workspace", "POST", "/workspaces/ensure", Workspace),
      call(actor, config.catalogUrl, config.catalogSecret, "dsh-agent-catalog", "GET", definitionRef ?
        `/definitions/${definitionRef.id}/versions/${definitionRef.version}` : "/definitions/default", AgentDefinition),
    ]);
    return { workspaceId: workspace.id, agentDefinitionId: definition.id, agentDefinitionVersion: definition.version };
  };
}

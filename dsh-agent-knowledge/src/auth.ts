import { jwtVerify, SignJWT } from "jose";
import { WorkspaceRunReference, KnowledgeAuthorization } from "@dsh-agent/contracts";
import { boundedJson, origin, KnowledgeError } from "./network.js";
export function knowledgeAuthorizer(config: { capabilitySecret: string; serviceSecret: string; runControlUrl: string }) {
  const capabilityKey = new TextEncoder().encode(config.capabilitySecret), serviceKey = new TextEncoder().encode(config.serviceSecret);
  if (capabilityKey.length < 32 || serviceKey.length < 32 || config.capabilitySecret === config.serviceSecret) throw new Error("Distinct 32-byte knowledge secrets required");
  const base = origin(config.runControlUrl);
  async function verify(header?: string) {
    try {
      if (!header?.startsWith("Bearer ")) throw new Error();
      const { payload } = await jwtVerify(header.slice(7), capabilityKey, { algorithms: ["HS256"],
        issuer: "dsh-agent-run-control", audience: "dsh-agent-knowledge-execution",
        requiredClaims: ["iat", "exp"], maxTokenAge: "30s" });
      if (payload.scope !== "knowledge:execute" || payload.exp! - payload.iat! > 30) throw new Error();
      return WorkspaceRunReference.parse(payload.reference);
    } catch { throw new KnowledgeError(401, "UNAUTHENTICATED"); }
  }
  return async (header: string | undefined, sourceId: string): Promise<KnowledgeAuthorization> => {
    const reference = await verify(header);
    const token = await new SignJWT({ scope: "knowledge:authorize" }).setProtectedHeader({ alg: "HS256", typ: "JWT" })
      .setIssuer("dsh-agent-knowledge").setAudience("dsh-agent-run-control-authorization").setIssuedAt().setExpirationTime("30s").sign(serviceKey);
    try {
      const response = await fetch(new URL("/authorization/v1/knowledge", base), { method: "POST", redirect: "error", signal: AbortSignal.timeout(2000),
        headers: { authorization: "Bearer " + token, "content-type": "application/json" }, body: JSON.stringify({ ...reference, tool: "knowledge.search", sourceId }) });
      if (!response.ok) {
        await response.body?.cancel();
        if (response.status === 403) throw new KnowledgeError(403, "FORBIDDEN");
        if (response.status === 409) throw new KnowledgeError(409, "LEASE_LOST");
        throw new Error("Authorization unavailable");
      }
      const authorized = KnowledgeAuthorization.parse(await boundedJson(response, 16 * 1024));
      if (authorized.runId !== reference.runId || authorized.workerId !== reference.workerId || authorized.leaseId !== reference.leaseId ||
        authorized.attempt !== reference.attempt || authorized.sourceId !== sourceId) throw new Error("Mismatched authorization");
      await verify(header);
      if (Date.parse(authorized.leaseExpiresAt) <= Date.now()) throw new KnowledgeError(409, "LEASE_LOST");
      return authorized;
    } catch (error) {
      if (error instanceof KnowledgeError) throw error;
      throw new KnowledgeError(503, "DEPENDENCY_UNAVAILABLE");
    }
  };
}

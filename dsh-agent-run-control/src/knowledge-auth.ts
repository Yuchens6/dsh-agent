import { jwtVerify, SignJWT } from "jose";
import { WorkspaceRunReference } from "@dsh-agent/contracts";
import { RunError } from "./repository.js";
export function knowledgeCapabilitySigner(secret: string) {
  const key = new TextEncoder().encode(secret);
  if (key.length < 32) throw new Error("Knowledge capability key requires 32 bytes");
  return async (reference: WorkspaceRunReference, deadline: number) => {
    const now = Math.floor(Date.now() / 1000), expiresAt = Math.min(now + 30, deadline);
    if (expiresAt <= now) throw new RunError(409, "LEASE_LOST");
    const token = await new SignJWT({ scope: "knowledge:execute", reference: WorkspaceRunReference.parse(reference) })
      .setProtectedHeader({ alg: "HS256", typ: "JWT" }).setIssuer("dsh-agent-run-control")
      .setAudience("dsh-agent-knowledge-execution").setIssuedAt(now).setExpirationTime(expiresAt).sign(key);
    return { token, expiresAt };
  };
}
export function knowledgeServiceVerifier(secret: string) {
  const key = new TextEncoder().encode(secret);
  if (key.length < 32) throw new Error("Knowledge authorization key requires 32 bytes");
  return async (header?: string) => {
    try {
      if (!header?.startsWith("Bearer ")) throw new Error();
      const { payload } = await jwtVerify(header.slice(7), key, { algorithms: ["HS256"],
        issuer: "dsh-agent-knowledge", audience: "dsh-agent-run-control-authorization",
        requiredClaims: ["iat", "exp"], maxTokenAge: "30s" });
      if (payload.scope !== "knowledge:authorize" || payload.exp! - payload.iat! > 30) throw new Error();
    } catch { throw new RunError(401, "UNAUTHENTICATED"); }
  };
}

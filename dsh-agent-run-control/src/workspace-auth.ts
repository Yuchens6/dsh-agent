import { jwtVerify, SignJWT } from "jose";
import { WorkspaceRunReference, type WorkspaceCapability } from "@dsh-agent/contracts";
import { RunError } from "./repository.js";
export function workspaceCapabilitySigner(secret: string) {
  const key = new TextEncoder().encode(secret);
  if (key.length < 32) throw new Error("Capability key requires at least 32 bytes");
  return async (reference: WorkspaceRunReference, leaseExpiresAt: number): Promise<WorkspaceCapability> => {
    const data = WorkspaceRunReference.parse(reference);
    const now = Math.floor(Date.now() / 1000), expiresAt = Math.min(now + 30, leaseExpiresAt);
    if (expiresAt <= now) throw new RunError(409, "LEASE_LOST");
    const token = await new SignJWT({ scope: "workspace:execute", reference: data })
      .setProtectedHeader({ alg: "HS256", typ: "JWT" }).setIssuer("dsh-agent-run-control")
      .setAudience("dsh-agent-workspace-execution").setIssuedAt(now).setExpirationTime(expiresAt).sign(key);
    return { token, expiresAt };
  };
}
export function workspaceServiceVerifier(secret: string) {
  const key = new TextEncoder().encode(secret);
  if (key.length < 32) throw new Error("Workspace service key requires at least 32 bytes");
  return async (header?: string) => {
    try {
      if (!header?.startsWith("Bearer ")) throw new Error();
      const { payload } = await jwtVerify(header.slice(7), key, { algorithms: ["HS256"],
        issuer: "dsh-agent-workspace", audience: "dsh-agent-run-control-authorization",
        requiredClaims: ["exp", "iat"], maxTokenAge: "30s" });
      if (payload.scope !== "workspace:authorize") throw new Error();
    } catch { throw new RunError(401, "UNAUTHENTICATED"); }
  };
}

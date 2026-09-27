import { jwtVerify, SignJWT } from "jose";
import { Principal } from "@dsh-agent/contracts";
import { ChatError } from "./repository.js";
const encoder = new TextEncoder();

export function serviceVerifier(apiSecret: string) {
  return verifyService(apiSecret, "dsh-agent-api");
}
export function executionVerifier(secret: string) {
  return verifyService(secret, "dsh-agent-run-control");
}
function verifyService(apiSecret: string, issuer: string) {
  const key = encoder.encode(apiSecret);
  if (key.length < 32) throw new Error("API_CHAT_SECRET requires at least 32 bytes");
  return async (header: string | undefined) => {
    try {
      if (!header?.startsWith("Bearer ")) throw new Error();
      const { payload } = await jwtVerify(header.slice(7), key, {
        algorithms: ["HS256"], issuer, audience: "dsh-agent-chat",
        requiredClaims: ["exp", "iat"], maxTokenAge: "60s",
      });
      return Principal.parse(payload.actor);
    } catch { throw new ChatError(401, "UNAUTHENTICATED"); }
  };
}
export function capabilitySigner(secret: string) {
  const key = encoder.encode(secret);
  if (key.length < 32) throw new Error("CHAT_CAPABILITY_SECRET requires at least 32 bytes");
  return async (actor: Principal, sessionId: string) => {
    const expiresAt = Math.floor(Date.now() / 1000) + 60;
    const token = await new SignJWT({ tenantId: actor.tenantId, sessionId, scope: "session:subscribe" })
      .setProtectedHeader({ alg: "HS256", typ: "JWT" })
      .setIssuer("dsh-agent-chat").setAudience("dsh-agent-stream").setSubject(actor.uid)
      .setIssuedAt().setExpirationTime(expiresAt).sign(key);
    return { token, expiresAt, endpoint: "/events/v1/sessions/" + sessionId };
  };
}

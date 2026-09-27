import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import { Principal } from "@dsh-agent/contracts";

export function identityVerifier(issuer: string, audience: string, key: JWTVerifyGetKey) {
  return async (header?: string) => {
    if (!header?.startsWith("Bearer ")) throw new Error("UNAUTHENTICATED");
    const { payload } = await jwtVerify(header.slice(7), key, {
      algorithms: ["RS256"], issuer, audience, requiredClaims: ["sub", "exp", "iat"],
    });
    return { actor: Principal.parse({ uid: payload.sub, tenantId: payload.tenantId, roles: payload.roles ?? [] }),
      expiresAt: payload.exp! };
  };
}
export function remoteIdentityVerifier(issuer: string, audience: string, jwks: string) {
  if (process.env.NODE_ENV === "production" &&
      (!issuer.startsWith("https://") || !jwks.startsWith("https://"))) throw new Error("Production IAM endpoints require HTTPS");
  return identityVerifier(issuer, audience, createRemoteJWKSet(new URL(jwks), { timeoutDuration: 3000 }));
}
export function capabilityVerifier(secret: string) {
  const key = new TextEncoder().encode(secret);
  if (key.length < 32) throw new Error("CHAT_CAPABILITY_SECRET requires at least 32 bytes");
  return async (token: string, actor: Principal, sessionId: string) => {
    const { payload } = await jwtVerify(token, key, {
      algorithms: ["HS256"], issuer: "dsh-agent-chat", audience: "dsh-agent-stream",
      requiredClaims: ["sub", "exp", "iat"], maxTokenAge: "60s",
    });
    if (payload.sub !== actor.uid || payload.tenantId !== actor.tenantId ||
        payload.sessionId !== sessionId || payload.scope !== "session:subscribe") throw new Error("UNAUTHENTICATED");
    return payload.exp!;
  };
}

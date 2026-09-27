import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import { Principal } from "@dsh-agent/contracts";

export function identityVerifier(issuer: string, audience: string, key: JWTVerifyGetKey) {
  return async (header?: string): Promise<Principal> => {
    if (!header?.startsWith("Bearer ")) throw new Error("UNAUTHENTICATED");
    const { payload } = await jwtVerify(header.slice(7), key, {
      algorithms: ["RS256"], issuer, audience, requiredClaims: ["sub", "exp", "iat"],
    });
    return Principal.parse({ uid: payload.sub, tenantId: payload.tenantId, roles: payload.roles ?? [] });
  };
}
export function remoteIdentityVerifier(issuer: string, audience: string, jwks: string) {
  if (process.env.NODE_ENV === "production" &&
    (!issuer.startsWith("https://") || !jwks.startsWith("https://"))) {
    throw new Error("Production IAM endpoints require HTTPS");
  }
  return identityVerifier(issuer, audience, createRemoteJWKSet(new URL(jwks), { timeoutDuration: 3000 }));
}

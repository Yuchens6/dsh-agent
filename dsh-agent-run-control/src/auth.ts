import { jwtVerify } from "jose";
import { Principal, IdentityId } from "@dsh-agent/contracts";
import { RunError } from "./repository.js";
export function authenticators(apiSecret: string, workerSecret: string) {
  const apiKey = new TextEncoder().encode(apiSecret), workerKey = new TextEncoder().encode(workerSecret);
  if (apiKey.length < 32 || workerKey.length < 32 || apiSecret === workerSecret) throw new Error("Distinct service secrets required");
  async function verify(header: string | undefined, key: Uint8Array, issuer: string) {
    if (!header?.startsWith("Bearer ")) throw new Error();
    return (await jwtVerify(header.slice(7), key, { algorithms: ["HS256"], issuer, audience: "dsh-agent-run-control",
      requiredClaims: ["exp", "iat"], maxTokenAge: "60s" })).payload;
  }
  return {
    async api(header?: string): Promise<Principal> {
      try { return Principal.parse((await verify(header, apiKey, "dsh-agent-api")).actor); }
      catch { throw new RunError(401, "UNAUTHENTICATED"); }
    },
    async worker(header?: string): Promise<string> {
      try { return IdentityId.parse((await verify(header, workerKey, "dsh-agent-runtime-dsh")).sub); }
      catch { throw new RunError(401, "UNAUTHENTICATED"); }
    },
  };
}

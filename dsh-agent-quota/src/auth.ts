import { jwtVerify } from "jose";
import { Principal } from "@dsh-agent/contracts";
import { ServiceError } from "./repository.js";
export function authenticators(apiSecret: string, controlSecret: string) {
 if (apiSecret === controlSecret || [apiSecret,controlSecret].some(s=>Buffer.byteLength(s)<32)) throw new Error("Distinct service secrets required");
 const verify = (key: string, issuer: string) => async (header?: string) => {
  try {
   if (!header?.startsWith("Bearer ")) throw new Error();
   return (await jwtVerify(header.slice(7), new TextEncoder().encode(key), { algorithms:["HS256"],issuer,audience:"dsh-agent-quota",requiredClaims:["exp","iat"],maxTokenAge:"60s" })).payload;
  } catch { throw new ServiceError(401,"UNAUTHENTICATED"); }
 };
 return {
  api: async (header?: string) => { try { return Principal.parse((await verify(apiSecret,"dsh-agent-api")(header)).actor); } catch { throw new ServiceError(401,"UNAUTHENTICATED"); } },
  control: async (header?: string) => { await verify(controlSecret,"dsh-agent-run-control")(header); },
 };
}

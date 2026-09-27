import { jwtVerify } from "jose";
import { Principal, type AuditProducer } from "@dsh-agent/contracts";
import { ServiceError } from "./repository.js";
export function authenticators(apiSecret: string, controlSecret: string, additional?: { chat: string; workspace: string }) {
 const producers: Array<[AuditProducer, string]> = [["dsh-agent-run-control", controlSecret],
  ...(additional ? [["dsh-agent-chat", additional.chat], ["dsh-agent-workspace", additional.workspace]] as Array<[AuditProducer,string]> : [])];
 const keys = [apiSecret, ...producers.map(([,key]) => key)];
 if (new Set(keys).size !== keys.length || keys.some(s=>Buffer.byteLength(s)<32)) throw new Error("Distinct service secrets required");
 const verify = (key: string, issuer: string) => async (header?: string) => {
  try {
   if (!header?.startsWith("Bearer ")) throw new Error();
   return (await jwtVerify(header.slice(7), new TextEncoder().encode(key), { algorithms:["HS256"],issuer,audience:"dsh-agent-audit",requiredClaims:["exp","iat"],maxTokenAge:"60s" })).payload;
  } catch { throw new ServiceError(401,"UNAUTHENTICATED"); }
 };
 return {
  api: async (header?: string) => { try { return Principal.parse((await verify(apiSecret,"dsh-agent-api")(header)).actor); } catch { throw new ServiceError(401,"UNAUTHENTICATED"); } },
  control: async (header?: string) => { await verify(controlSecret,"dsh-agent-run-control")(header); },
  producer: async (header?: string): Promise<AuditProducer> => {
   for (const [issuer,key] of producers) {
    try { await verify(key,issuer)(header); return issuer; } catch { /* 尝试各自独立的生产者凭据，不信任正文声明。 */ }
   }
   throw new ServiceError(401,"UNAUTHENTICATED");
  },
 };
}

import Fastify from "fastify";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { PageQuery, AuditRecord, type AuditProducer, type Principal } from "@dsh-agent/contracts";
import { ServiceError, type AuditRepository } from "./repository.js";
export function createAuditApp(options: { repository: AuditRepository; authenticateApi: (header?: string)=>Promise<Principal>; authenticateControl: (header?: string)=>Promise<void>; authenticateProducer?: (header?: string)=>Promise<AuditProducer>; ready:()=>Promise<void>; logger?:boolean }) {
 const app = Fastify({ bodyLimit:16384, genReqId:()=>randomUUID(), logger:options.logger?{redact:["req.headers.authorization","req.headers.cookie"]}:false });
 app.setErrorHandler((err,req,reply)=>{
  const status=err instanceof ServiceError?err.status:err instanceof z.ZodError?400:500;
  const code=err instanceof ServiceError?err.code:status===400?"INVALID_REQUEST":"INTERNAL_ERROR";
  reply.code(status).send({error:{code,message:code,requestId:req.id}});
 });
 app.addHook("onSend",async(_req,reply)=>{reply.header("cache-control","no-store");});
 app.get("/health/live",async()=>({status:"ok"}));
 app.get("/health/ready",async(_req,reply)=>{try{await options.ready();return {status:"ok"};}catch{return reply.code(503).send({status:"unavailable"});}});
 app.register(async routes=>{
  const producers = new WeakMap<object, AuditProducer>();
  routes.addHook("onRequest",async req=>{
   if (options.authenticateProducer) producers.set(req, await options.authenticateProducer(req.headers.authorization));
   else { await options.authenticateControl(req.headers.authorization); producers.set(req,"dsh-agent-run-control"); }
   z.object({}).strict().parse(req.query);
  });
  routes.post("/records",async req=>{
   const record = AuditRecord.parse(req.body);
   if (record.producer !== producers.get(req)) throw new ServiceError(403,"FORBIDDEN");
   return options.repository.append(record);
  });
 },{prefix:"/control/v1"});
 app.get("/internal/v1/audit",async req=>{
  const actor=await options.authenticateApi(req.headers.authorization);
  return options.repository.list(actor,PageQuery.parse(req.query));
 });
 return app;
}

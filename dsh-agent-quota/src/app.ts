import Fastify from "fastify";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { ModelUsageQuery, PageQuery, type Principal } from "@dsh-agent/contracts";
import type { PointsRepository } from "./points.js";
import { ServiceError, type QuotaRepository } from "./repository.js";
export function createQuotaApp(options: { repository: QuotaRepository; points?: PointsRepository; authenticateApi: (header?: string)=>Promise<Principal>; authenticateControl: (header?: string)=>Promise<void>; ready:()=>Promise<void>; logger?:boolean }) {
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
  routes.addHook("onRequest",async req=>{await options.authenticateControl(req.headers.authorization);z.object({}).strict().parse(req.query);});
  routes.post("/reserve",async req=>options.repository.reserve(req.body));
  routes.post("/close",async req=>options.repository.close(req.body));
  routes.post("/usage",async req=>options.repository.recordModelUsage(req.body));
 },{prefix:"/control/v1"});
 app.get("/internal/v1/quota",async req=>{
  const actor=await options.authenticateApi(req.headers.authorization);
  z.object({}).strict().parse(req.query);return options.repository.usage(actor);
 });
 app.get("/internal/v1/usage",async req=>{
  const actor=await options.authenticateApi(req.headers.authorization);
  return options.repository.modelUsage(actor, ModelUsageQuery.parse(req.query).day);
 });
 app.get("/internal/v1/points",async req=>{
  const actor=await options.authenticateApi(req.headers.authorization);
  z.object({}).strict().parse(req.query);
  if (!options.points) throw new ServiceError(503,"DEPENDENCY_UNAVAILABLE");
  return options.points.balance(actor);
 });
 app.get("/internal/v1/points/ledger",async req=>{
  const actor=await options.authenticateApi(req.headers.authorization);
  const query=PageQuery.parse(req.query);
  if (!options.points) throw new ServiceError(503,"DEPENDENCY_UNAVAILABLE");
  return options.points.ledger(actor,query);
 });
 return app;
}

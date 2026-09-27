// 本机合成负载，只能监听回环地址；不连接外部模型、真实账号或持久数据库。
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { z } from "zod";
import { createApiApp } from "../dsh-agent-api/src/app.js";
import { chatClient } from "../dsh-agent-api/src/chat-client.js";
import { createChatApp } from "../dsh-agent-chat/src/app.js";
import { ChatRepository } from "../dsh-agent-chat/src/repository.js";
import { serviceVerifier,capabilitySigner } from "../dsh-agent-chat/src/auth.js";
import { boundedDatabase } from "../dsh-agent-chat/src/capacity.js";
import { database,testBinding } from "./helpers.js";

const config=z.object({LOAD_USERS:z.coerce.number().int().min(1).max(10000).default(1000),
  LOAD_CONCURRENCY:z.coerce.number().int().min(1).max(2000).default(128),
  LOAD_API_CAPACITY:z.coerce.number().int().min(1).max(1000).default(128),
  LOAD_DB_CAPACITY:z.coerce.number().int().min(1).max(1000).default(74),
}).parse(process.env);
const {db,pg}=await database();
const bounded=boundedDatabase(db,config.LOAD_DB_CAPACITY),repo=new ChatRepository(bounded.db,testBinding);
const key=randomUUID()+randomUUID(),capabilityKey=randomUUID()+randomUUID();
const chat=createChatApp({repository:repo,authenticate:serviceVerifier(key),signCapability:capabilitySigner(capabilityKey),ready:async()=>{}});
const chatUrl=await chat.listen({host:"127.0.0.1",port:0,backlog:1024});
const api=createApiApp({maxInFlight:config.LOAD_API_CAPACITY,authenticate:async header=>{
  const match=/^Bearer load-([0-9]+)$/.exec(header??"");if(!match)throw new Error("local synthetic identity only");
  return {uid:"load-"+match[1],tenantId:"load-company",roles:["user"]};
},chat:chatClient(chatUrl,key)});
try {
  const apiUrl=await api.listen({host:"127.0.0.1",port:0,backlog:1024});
  const sessions=(await db.query("INSERT INTO chat.conversations(id,tenant_id,owner_uid,title,agent_definition_id,agent_definition_version,workspace_id,idempotency_key,request_hash) " +
    "SELECT gen_random_uuid(),'load-company','load-'||n,'synthetic','document-agent',1,$2,'load-key-'||n,repeat('0',64) FROM generate_series(1,$1::integer) n RETURNING id,owner_uid",
    [config.LOAD_USERS,randomUUID()])).rows;
  let next=0;const statuses:Record<string,number>={},transportErrors:Record<string,number>={},latencies:number[]=[];const accepted:typeof sessions=[];
  const send=async(row:typeof sessions[number])=>{
    const response=await fetch(`${apiUrl}/api/v1/sessions/${row.id}/messages`,{method:"POST",headers:{authorization:"Bearer "+row.owner_uid,"content-type":"application/json","idempotency-key":"load-message-001"},body:JSON.stringify({content:"synthetic load test"}),signal:AbortSignal.timeout(30000)});
    await response.arrayBuffer();return response.status;
  };
  const start=performance.now();
  await Promise.all(Array.from({length:Math.min(config.LOAD_CONCURRENCY,sessions.length)},async()=>{
    while(next<sessions.length) {
      const row=sessions[next++]!,sent=performance.now();let status:string;
      try {status=String(await send(row));if(status==="202")accepted.push(row);}catch(error){
        status="transport_error";const cause=error instanceof Error ? error.cause : undefined;
        const code=cause && typeof cause==="object" && "code" in cause ? String(cause.code) : error instanceof Error ? error.name : "unknown";
        transportErrors[code]=(transportErrors[code]??0)+1;
      }
      statuses[status]=(statuses[status]??0)+1;latencies.push(performance.now()-sent);
    }
  }));
  const elapsed=performance.now()-start;latencies.sort((a,b)=>a-b);
  const durable=(await db.query("SELECT count(*)::integer AS n FROM chat.conversation_messages WHERE role='user'")).rows[0]!.n;
  const commands=(await db.query("SELECT count(*)::integer AS n FROM chat.conversation_outbox WHERE subject='agent.commands.run.requested.v1'")).rows[0]!.n;
  let replays=0;
  for(const row of accepted.slice(0,20))if(await send(row)===202)replays++;
  const afterReplay=(await db.query("SELECT count(*)::integer AS n FROM chat.conversation_messages WHERE role='user'")).rows[0]!.n;
  const verified=durable===accepted.length&&commands===accepted.length&&afterReplay===durable&&replays===Math.min(20,accepted.length);
  console.log(JSON.stringify({kind:"local-synthetic-chat-only",config,statuses,transportErrors,elapsedMs:Math.round(elapsed),
    offeredRequestsPerSecond:Math.round(sessions.length/(elapsed/1000)),acceptedRequestsPerSecond:Math.round(accepted.length/(elapsed/1000)),
    latencyMs:{p50:Math.round(latencies[Math.ceil(latencies.length*.5)-1]!),p95:Math.round(latencies[Math.ceil(latencies.length*.95)-1]!),p99:Math.round(latencies[Math.ceil(latencies.length*.99)-1]!)},
    durableMessages:durable,durableRunRequests:commands,replayed:replays,integrityVerified:verified,database:bounded.snapshot(),
    limitations:["PGlite serializes transactions; not native PostgreSQL throughput","synthetic identity; no external IAM","no NATS, scheduler, model or SSE in this benchmark","bounded offered concurrency, not all users simultaneously executing"]},null,2));
  if(!verified||statuses.transport_error||statuses["500"]||accepted.length===0)process.exitCode=1;
} finally {await api.close();await chat.close();await pg.close();}

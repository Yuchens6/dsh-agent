import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as pause } from "node:timers/promises";
import { request } from "node:http";
import { createApiApp } from "../dsh-agent-api/src/app.js";
import { Admission } from "../dsh-agent-api/src/admission.js";
import { ChatRepository } from "../dsh-agent-chat/src/repository.js";
import { createChatApp } from "../dsh-agent-chat/src/app.js";
import { serviceVerifier, capabilitySigner } from "../dsh-agent-chat/src/auth.js";
import { chatClient } from "../dsh-agent-api/src/chat-client.js";
import { boundedDatabase as chatCapacity } from "../dsh-agent-chat/src/capacity.js";
import { boundedDatabase as runCapacity } from "../dsh-agent-run-control/src/capacity.js";
import { backgroundWorkers as chatWorkers } from "../dsh-agent-chat/src/background.js";
import { backgroundWorkers as runWorkers } from "../dsh-agent-run-control/src/background.js";
import { runSlots } from "../dsh-agent-runtime-dsh/src/slots.js";
import { RunRepository } from "../dsh-agent-run-control/src/repository.js";
import { serviceDatabase } from "./workspace-catalog-helpers.js";
import { alice,bob,otherTenant,database,testBinding,secret,capabilitySecret } from "./helpers.js";

test("API 并发门禁：认证前拒绝额外请求，健康探针不占槽，异常后恢复",async t=>{
  const gate=new Admission(1),release=gate.enter()!; assert.equal(gate.enter(),undefined); release();release();assert.equal(gate.inFlight,0);
  let releaseAuth!:()=>void,notify!:()=>void,authCalls=0,blocking=true;
  const entered=new Promise<void>(resolve=>{notify=resolve;}),waiting=new Promise<void>(resolve=>{releaseAuth=resolve;});
  const app=createApiApp({maxInFlight:1,authenticate:async()=>{authCalls++;if(blocking){notify();await waiting;}return alice;},chat:async()=>{throw new Error("broken");}});
  t.after(()=>app.close());
  const first=app.inject("/api/v1/me").then(r=>r); await entered;
  const overload=await app.inject("/api/v1/me"); assert.equal(overload.statusCode,503);assert.equal(overload.headers["retry-after"],"1");assert.equal(authCalls,1);
  assert.equal((await app.inject("/health/live")).statusCode,200);
  releaseAuth();blocking=false;assert.equal((await first).statusCode,200);
  assert.equal((await app.inject("/api/v1/sessions")).statusCode,500);
  assert.equal((await app.inject("/api/v1/me")).statusCode,200);
});

test("消息限流：跨副本共享用户窗口，重试不重复消耗，租户隔离与回滚",async t=>{
  const {db,pg}=await database();t.after(()=>pg.close());
  const policy={messagesPerMinute:2,pendingPerUser:10,pendingPerSession:10};
  const a=new ChatRepository(db,testBinding,policy),b=new ChatRepository(db,testBinding,policy);
  const s1=await a.create(alice,"one","session-key-1","test"),s2=await a.create(alice,"two","session-key-2","test");
  const outcomes=await Promise.allSettled([a.send(alice,s1.id,"a","message-key-1","test"),b.send(alice,s2.id,"b","message-key-2","test"),a.send(alice,s1.id,"c","message-key-3","test")]);
  assert.equal(outcomes.filter(v=>v.status==="fulfilled").length,2);
  await b.send(alice,s1.id,"a","message-key-1","test");
  assert.equal((await db.query("SELECT used FROM chat.message_admission WHERE tenant_id=$1 AND owner_uid=$2",[alice.tenantId,alice.uid])).rows[0]!.used,2);
  const other=await a.create(otherTenant,"other","other-key","test"); await a.send(otherTenant,other.id,"ok","other-msg","test");
  await db.query("UPDATE chat.message_admission SET window_start=clock_timestamp()-interval '61 seconds'");
  await b.send(alice,s1.id,"new window","message-key-4","test");
  const broken=new ChatRepository({...db,transaction:work=>db.transaction(tx=>work({query:(sql,values)=>{
    if(sql.startsWith("INSERT INTO chat.conversation_messages"))throw new Error("write failed"); return tx.query(sql,values);
  }}))},testBinding,policy);
  await assert.rejects(broken.send(alice,s1.id,"rollback","message-key-5","test"),/write failed/);
  assert.equal((await db.query("SELECT used FROM chat.message_admission WHERE tenant_id=$1 AND owner_uid=$2",[alice.tenantId,alice.uid])).rows[0]!.used,1);
});

test("API 客户端中途断开释放槽位，迟到认证不再触发下游调用",async t=>{
  let release!:()=>void,notify!:()=>void,calls=0;
  const waiting=new Promise<void>(r=>{release=r;}),entered=new Promise<void>(r=>{notify=r;});
  const app=createApiApp({maxInFlight:1,authenticate:async header=>{if(header==="wait"){notify();await waiting;}return alice;},chat:async()=>{calls++;throw new Error();}});
  const url=await app.listen({host:"127.0.0.1",port:0});t.after(()=>app.close());
  const pending=request(url+"/api/v1/sessions",{headers:{authorization:"wait"}});pending.on("error",()=>{});pending.end();await entered;
  pending.destroy();
  let result;
  for(let i=0;i<50;i++){result=await app.inject("/api/v1/me");if(result.statusCode===200)break;await pause(10);}
  release();await pause(10);
  assert.equal(result!.statusCode,200);assert.equal(calls,0);
});

test("积压背压 HTTP：确认丢失可重放，拒绝不落新消息，投递恢复后放行",async t=>{
  const {db,pg}=await database();t.after(()=>pg.close());
  const repo=new ChatRepository(db,testBinding,{messagesPerMinute:100,pendingPerUser:2,pendingPerSession:1});
  const s=await repo.create(alice,"one","session-key","test");
  const chat=createChatApp({repository:repo,authenticate:serviceVerifier(secret),signCapability:capabilitySigner(capabilitySecret),ready:async()=>{}});
  const url=await chat.listen({host:"127.0.0.1",port:0});t.after(()=>chat.close());
  const api=createApiApp({authenticate:async()=>alice,chat:chatClient(url,secret)});t.after(()=>api.close());
  const send=(key:string)=>api.inject({method:"POST",url:`/api/v1/sessions/${s.id}/messages`,headers:{"idempotency-key":key},payload:{content:"test"}});
  const first=await send("message-key-1");assert.equal(first.statusCode,202,first.body);
  assert.equal((await send("message-key-1")).json().id,first.json().id);
  const rejected=await send("message-key-2");assert.equal(rejected.statusCode,429);assert.equal(rejected.headers["retry-after"],"5");
  assert.equal((await repo.history(alice,s.id,20)).items.length,1);
  await repo.publishBatch(async()=>{});assert.equal((await send("message-key-2")).statusCode,202);
  const s2=await repo.create(alice,"two","session-key-2","test");await repo.send(alice,s2.id,"two","message-key-3","test");
  const s3=await repo.create(alice,"three","session-key-3","test");await assert.rejects(repo.send(alice,s3.id,"full","message-key-4","test"),/QUOTA_EXCEEDED/);
});

test("数据库背压：查询/事务共用有界入口，满载不进入底层，失败释放",async()=>{
  for(const wrap of [chatCapacity,runCapacity]) {
    let calls=0,release!:()=>void;const wait=new Promise<void>(resolve=>{release=resolve;});
    const {db,snapshot}=wrap({query:async()=>{calls++;await wait;return {rows:[]};},transaction:async()=>{throw new Error("failed transaction");}},2);
    const a=db.query("a"),b=db.query("b");await assert.rejects(db.query("c"),/DEPENDENCY_UNAVAILABLE/);
    await assert.rejects(db.transaction(async()=>{}),/DEPENDENCY_UNAVAILABLE/);assert.equal(calls,2);assert.equal(snapshot().db_operations,2);
    release();await Promise.all([a,b]);await assert.rejects(db.transaction(async()=>{}),/failed transaction/);
    assert.equal(snapshot().db_operations,0);assert.equal(snapshot().db_rejected_total,2);
  }
});

test("后台并行：固定在途数，持续处理积压，停止时等待在途且不再领取",async()=>{
  for(const workers of [chatWorkers,runWorkers]) {
    const stop=new AbortController();let active=0,peak=0,count=0;
    const pending=workers(3,stop.signal,async()=>{active++;peak=Math.max(peak,active);await pause(2);active--;if(++count>=12)stop.abort();return true;},()=>assert.fail("unexpected error"));
    await pending;assert.equal(peak,3);assert.equal(active,0);assert.ok(count>=12&&count<=14);
    let errors=0;const failed=new AbortController();
    await workers(1,failed.signal,async()=>{throw new Error();},()=>{errors++;failed.abort();},1);assert.equal(errors,1);
  }
});

test("执行槽位：无预取、并发不超限、执行异常不重跑、停止清理所有槽位",async()=>{
  const stop=new AbortController();let claimed=0,active=0,peak=0,executed=0;
  await runSlots({concurrency:3,signal:stop.signal,idleMs:1,claim:async()=>++claimed,
    execute:async(_claim,signal)=>{active++;peak=Math.max(peak,active);executed++;try{await pause(3,undefined,{signal});}catch{}finally{active--;}
      if(executed>=12)stop.abort();},health:()=>{}});
  assert.equal(peak,3);assert.equal(active,0);assert.equal(claimed,executed);
  const failed=new AbortController();let calls=0;
  await runSlots({concurrency:1,signal:failed.signal,claim:async()=>++calls,execute:async()=>{throw new Error();},health:(_s,ok)=>{if(!ok)failed.abort();}});
  assert.equal(calls,1);
});

test("调度容量：公司/个人满载继续排队，跨公司推进，等待老化与取消占位",async t=>{
  const {db,pg}=await serviceDatabase("run_control");t.after(()=>pg.close());
  const repo=new RunRepository(db,{leaseSeconds:30,timeoutSeconds:120,maxActive:8},{userActive:1,tenantActive:2,agingSeconds:60});
  const enqueue=async(actor=alice)=>{const id=randomUUID();return repo.accept({eventId:randomUUID(),eventType:"conversation.message.accepted.v1",producer:"dsh-agent-chat",
    tenantId:actor.tenantId,ownerUid:actor.uid,sessionId:randomUUID(),subjectId:id,payload:{messageId:id},occurredAt:new Date().toISOString(),traceId:"load"});};
  const a=await enqueue(),a2=await enqueue(),b=await enqueue(bob),c=await enqueue({...alice,uid:"c"}),d=await enqueue(otherTenant);
  const first=(await repo.claim("w1"))!;assert.equal(first.run.id,a.id);
  // 老化任务优先，但仍不能突破主体并发上限。
  await db.query("UPDATE run_control.runs SET created_at=clock_timestamp()-interval '2 minutes' WHERE id=$1",[b.id]);
  assert.equal((await repo.claim("w2"))!.run.id,b.id);assert.equal((await repo.claim("w3"))!.run.id,d.id);
  assert.equal(await repo.claim("w4"),null);assert.equal((await repo.get(alice,a2.id)).state,"queued");assert.equal((await repo.get({...alice,uid:"c"},c.id)).state,"queued");
  await repo.cancel(alice,a.id);assert.equal(await repo.claim("w4"),null);await repo.release("w1",a.id,first.lease);
  assert.equal((await repo.claim("w4"))!.run.id,a2.id);
});

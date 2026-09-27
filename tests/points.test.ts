import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PricingPolicy, type Principal } from "@dsh-agent/contracts";
import { PointsRepository, micro, decimal, priceTokens } from "../dsh-agent-quota/src/points.js";
import { QuotaRepository } from "../dsh-agent-quota/src/repository.js";
import { serviceDatabase } from "./workspace-catalog-helpers.js";
import { alice, bob, otherTenant } from "./helpers.js";

const policy = () => PricingPolicy.parse({ id:randomUUID(),provider:"deepseek-official",model:"test-model",currency:"CNY",
  inputPerMillion:"1",cacheReadPerMillion:"0.5",outputPerMillion:"2",pointsPerYuan:"100",reservePointsPerRun:"1" });
const command = (kind:"grant"|"allocate", points:string, uid=alice.uid) => ({kind,id:randomUUID(),tenantId:alice.tenantId,points,operator:"test-admin",reason:"test",...(kind==="allocate"?{uid}:{})});
async function fund(points:PointsRepository, value="20", uid=alice.uid) {
  await points.command(command("grant",value)); await points.command(command("allocate",value,uid));
}
const reservation = (actor:Principal=alice) => ({actor,runId:randomUUID(),outputTokenBudget:5000,
  deadlineAt:new Date(Date.now()+60_000).toISOString(),billingModel:{provider:"deepseek-official",name:"test-model"}});
const usage = (runId:string, tokens:unknown, call=1) => ({eventId:randomUUID(),runId,actor:alice,attempt:1,provider:"deepseek-official",model:"test-model",
  startedAt:"2026-09-26T00:00:00.000Z",report:{call,phase:"finished",tokens}});
const tokens = {inputTokens:1000,cacheReadTokens:200,outputTokens:500,reasoningTokens:100};

test("积分精度：人民币到积分定点换算、缓存互斥、推理不重复、逐次向上取整",()=>{
  assert.equal(micro("0.000001"),1n); assert.equal(decimal(-1n),"-0.000001");
  assert.deepEqual(priceTokens(policy(),tokens),{amount:2100n,points:210000n});
  assert.equal(priceTokens(policy(),{inputTokens:1000,outputTokens:500}),null);
  assert.deepEqual(priceTokens({...policy(),cacheReadPerMillion:"1"},{inputTokens:1000,outputTokens:500}),{amount:2000n,points:200000n});
  assert.deepEqual(priceTokens({...policy(),inputPerMillion:"0.000001",pointsPerYuan:"0.000001"},{inputTokens:1,cacheReadTokens:0,outputTokens:0}),{amount:1n,points:1n});
  assert.equal(priceTokens({...policy(),inputPerMillion:"999999999999"},{inputTokens:1_000_000_000,cacheReadTokens:0,outputTokens:0})!.amount,999999999999000000000n);
  for (const invalid of ["-1","1e3","0.0000001","01","NaN"]) assert.throws(()=>micro(invalid));
  assert.equal(PricingPolicy.safeParse({...policy(),pointsPerYuan:"0"}).success,false);
});

test("公司积分：100 分硬分配五人各 20，幂等操作、跨租户隔离、不可改账",async t=>{
  const {db,pg}=await serviceDatabase("quota"); t.after(()=>pg.close()); const points=new PointsRepository(db,true);
  const grant=command("grant","100"); await points.command(grant); await points.command(grant);
  await assert.rejects(points.command({...grant,points:"101"}),/IDEMPOTENCY_CONFLICT/);
  for (const uid of ["alice","bob","c","d","e"]) { const allocation=command("allocate","20",uid); await points.command(allocation); await points.command(allocation); }
  await assert.rejects(points.command(command("allocate","1")),/QUOTA_EXCEEDED/);
  for (const uid of ["alice","bob","c","d","e"]) assert.equal((await points.balance({...alice,uid})).available,"20.000000");
  assert.equal((await points.balance(otherTenant)).balance,"0.000000");
  assert.equal((await points.ledger(otherTenant,{limit:20})).items.length,0);
  assert.equal((await points.ledger(alice,{limit:20})).items.length,1);
  assert.equal((await db.query("SELECT balance FROM quota.points_accounts WHERE owner_uid=''")).rows[0]!.balance,"0");
  for (const table of ["points_ledger","points_operations"]) await assert.rejects(db.query(`DELETE FROM quota.${table}`),/append-only/);
  assert.equal((await db.query("SELECT count(*) AS n FROM quota.points_operations")).rows[0]!.n,6);
});

test("积分预留：缺价/余额不足不启动，重放不重复冻结，计价快照不随改价变化",async t=>{
  const {db,pg}=await serviceDatabase("quota"); t.after(()=>pg.close()); const points=new PointsRepository(db,true),quota=new QuotaRepository(db,undefined,true);
  const r=reservation(),p=policy();
  await assert.rejects(quota.reserve(r),/DEPENDENCY_UNAVAILABLE/);
  await points.command({kind:"price",policy:p}); await assert.rejects(quota.reserve(r),/QUOTA_EXCEEDED/);
  assert.equal((await db.query("SELECT * FROM quota.reservations")).rows.length,0);
  await fund(points); await quota.reserve(r); await quota.reserve(r);
  assert.equal((await points.balance(alice)).held,"1.000000");
  await assert.rejects(quota.reserve({...r,billingModel:{...r.billingModel,name:"changed"}}),/IDEMPOTENCY_CONFLICT/);
  await assert.rejects(points.command({kind:"price",policy:{...p,pointsPerYuan:"200"}}),/VERSION_CONFLICT/);
  await points.command({kind:"price",policy:{...p,id:randomUUID(),pointsPerYuan:"200"}});
  const e=usage(r.runId,tokens); await quota.recordModelUsage(e); await quota.recordModelUsage(e);
  await quota.close({actor:alice,runId:r.runId,expectedCalls:1});
  assert.deepEqual(await points.balance(alice),{balance:"19.790000",held:"0.000000",available:"19.790000",billingEnabled:true,pendingRuns:0});
  const ledger=await points.ledger(alice,{limit:1}); assert.equal(ledger.items[0]!.pricingId,p.id); assert.equal(ledger.items[0]!.amountCny,"0.002100");
  assert.equal(ledger.items[0]!.delta,"-0.210000"); assert.ok(ledger.nextCursor);
  assert.equal((await points.ledger(alice,{limit:1,after:ledger.nextCursor!})).items[0]!.kind,"allocate");
  await assert.rejects(db.query("UPDATE quota.points_prices SET document='{}'"),/append-only/);
});

test("积分结算：关闭先于计量不释放，终报先到去重，缺失用量不作零",async t=>{
  const {db,pg}=await serviceDatabase("quota"); t.after(()=>pg.close()); const points=new PointsRepository(db,true),quota=new QuotaRepository(db,undefined,true);
  await points.command({kind:"price",policy:policy()}); await fund(points);
  const r=reservation(); await quota.reserve(r); await quota.close({actor:alice,runId:r.runId,expectedCalls:1});
  assert.equal((await points.balance(alice)).held,"1.000000"); assert.equal((await points.balance(alice)).pendingRuns,1);
  await assert.rejects(quota.reserve(reservation()),/QUOTA_EXCEEDED/);
  const e=usage(r.runId,tokens); await quota.recordModelUsage(e);
  await quota.recordModelUsage({...e,report:{phase:"started",call:1}}); await quota.recordModelUsage(e);
  assert.equal((await points.balance(alice)).held,"0.000000"); assert.equal((await points.balance(alice)).balance,"19.790000");
  await assert.rejects(quota.close({actor:alice,runId:r.runId,expectedCalls:2}),/IDEMPOTENCY_CONFLICT/);
  await assert.rejects(quota.recordModelUsage(usage(r.runId,tokens,2)),/INVALID_STATE/);
  const missing=reservation(); await quota.reserve(missing); await quota.recordModelUsage(usage(missing.runId,null));
  await quota.close({actor:alice,runId:missing.runId,expectedCalls:1}); await points.command({kind:"reconcile",runId:missing.runId});
  assert.equal((await points.balance(alice)).held,"1.000000"); assert.equal((await points.balance(alice)).pendingRuns,1);
  assert.equal((await points.balance(alice)).balance,"19.790000");
  await assert.rejects(quota.reserve(reservation()),/QUOTA_EXCEEDED/);
});

test("积分不足：不可借公司/员工/其他运行冻结额，补分后幂等补结算",async t=>{
  const {db,pg}=await serviceDatabase("quota"); t.after(()=>pg.close()); const points=new PointsRepository(db,true),quota=new QuotaRepository(db,undefined,true);
  await points.command({kind:"price",policy:policy()}); await fund(points,"2"); await fund(points,"20",bob.uid); await points.command(command("grant","50"));
  const r=reservation(),other=reservation(); await quota.reserve(r); await quota.reserve(other);
  const expensive=usage(r.runId,{inputTokens:15000,cacheReadTokens:0,outputTokens:0}); // 1.5 points, only 1 unencumbered point
  await quota.recordModelUsage(expensive); await quota.close({actor:alice,runId:r.runId,expectedCalls:1});
  assert.equal((await points.balance(alice)).balance,"2.000000"); assert.equal((await points.balance(alice)).held,"2.000000");
  assert.equal((await points.balance(bob)).balance,"20.000000");
  assert.equal((await db.query("SELECT status FROM quota.points_charges")).rows[0]!.status,"pending_balance");
  await assert.rejects(quota.reserve(reservation()),/QUOTA_EXCEEDED/);
  await points.command(command("allocate","1"));
  await points.command({kind:"reconcile",runId:r.runId}); await points.command({kind:"reconcile",runId:r.runId}); await quota.recordModelUsage(expensive);
  assert.equal((await points.balance(alice)).balance,"1.500000"); assert.equal((await points.balance(alice)).held,"1.000000");
  await quota.close({actor:alice,runId:other.runId,expectedCalls:0});
  assert.equal((await points.balance(alice)).available,"1.500000"); assert.equal((await points.balance(alice)).pendingRuns,0);
  assert.equal((await points.ledger(alice,{limit:100})).items.filter(i=>i.kind==="charge").length,1);
});

test("积分事务：账本失败回滚计量与余额，关闭开关不影响旧运行结算，不追收旧用量",async t=>{
  const {db,pg}=await serviceDatabase("quota"); t.after(()=>pg.close()); const points=new PointsRepository(db,true),quota=new QuotaRepository(db,undefined,true);
  await points.command({kind:"price",policy:policy()}); await fund(points);
  const r=reservation(); await quota.reserve(r);
  const broken=new QuotaRepository({...db,transaction:work=>db.transaction(tx=>work({query:(sql,values)=>{
    if (sql.includes("INSERT INTO quota.points_ledger")) throw new Error("ledger offline"); return tx.query(sql,values);
  }}))});
  await assert.rejects(broken.recordModelUsage(usage(r.runId,tokens)),/ledger offline/);
  assert.equal((await db.query("SELECT * FROM quota.model_calls")).rows.length,0);
  assert.equal((await db.query("SELECT * FROM quota.points_charges")).rows.length,0);
  assert.equal((await points.balance(alice)).balance,"20.000000");
  const disabled=new QuotaRepository(db); await disabled.recordModelUsage(usage(r.runId,tokens));
  await disabled.close({actor:alice,runId:r.runId,expectedCalls:1}); assert.equal((await points.balance(alice)).balance,"19.790000");
  const legacy=reservation(); await disabled.reserve(legacy); await disabled.recordModelUsage(usage(legacy.runId,tokens));
  await disabled.close({actor:alice,runId:legacy.runId,expectedCalls:1}); assert.equal((await points.balance(alice)).balance,"19.790000");
});

test("积分计量边界：主体、模型、金额不得伪造，缺缓存细分保留待结算",async t=>{
  const {db,pg}=await serviceDatabase("quota"); t.after(()=>pg.close()); const points=new PointsRepository(db,true),quota=new QuotaRepository(db,undefined,true);
  await points.command({kind:"price",policy:policy()}); await fund(points); const r=reservation(); await quota.reserve(r);
  const e=usage(r.runId,tokens);
  await assert.rejects(quota.recordModelUsage({...e,actor:bob}),/INVALID_STATE/);
  await assert.rejects(quota.recordModelUsage({...e,model:"forged"}),/INVALID_STATE/);
  await assert.rejects(quota.recordModelUsage({...e,amountCny:"0"}));
  assert.equal((await db.query("SELECT * FROM quota.model_calls")).rows.length,0);
  await quota.recordModelUsage(usage(r.runId,{inputTokens:1000,outputTokens:500}));
  await quota.close({actor:alice,runId:r.runId,expectedCalls:1});
  assert.equal((await db.query("SELECT status FROM quota.points_charges")).rows[0]!.status,"pending_usage");
  assert.equal((await points.balance(alice)).balance,"20.000000"); assert.equal((await points.balance(alice)).held,"1.000000");
  assert.equal((await points.ledger(alice,{limit:20})).items.filter(i=>i.kind==="charge").length,0);
});

import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { StreamChunk } from "@deepseek-ai/dsh-llm";
import { ExecutionInput, ModelCallReport, ModelTokens, type Principal } from "@dsh-agent/contracts";
import { meterStream } from "../dsh-agent-runtime-dsh/src/usage.js";
import { RunRepository } from "../dsh-agent-run-control/src/repository.js";
import { QuotaRepository } from "../dsh-agent-quota/src/repository.js";
import { PointsRepository } from "../dsh-agent-quota/src/points.js";
import { supportClient } from "../dsh-agent-run-control/src/support-client.js";
import { createRunControlApp } from "../dsh-agent-run-control/src/app.js";
import { authenticators as runAuth } from "../dsh-agent-run-control/src/auth.js";
import { createQuotaApp } from "../dsh-agent-quota/src/app.js";
import { authenticators as quotaAuth } from "../dsh-agent-quota/src/auth.js";
import { createApiApp } from "../dsh-agent-api/src/app.js";
import { serviceClient } from "../dsh-agent-api/src/chat-client.js";
import { runtimeClient } from "../dsh-agent-runtime-dsh/src/client.js";
import { definition, serviceDatabase } from "./workspace-catalog-helpers.js";
import { alice, bob, otherTenant, secret } from "./helpers.js";

async function admitted(runs: RunRepository) {
  const messageId = randomUUID(), sessionId = randomUUID();
  const run = await runs.accept({ eventId: randomUUID(), eventType: "conversation.message.accepted.v1", producer: "dsh-agent-chat",
    tenantId: alice.tenantId, ownerUid: alice.uid, sessionId, subjectId: messageId, payload: { messageId }, occurredAt: new Date().toISOString(), traceId: "test" });
  const claim = (await runs.claim("worker"))!;
  const input = ExecutionInput.parse({ runId: run.id, capturedAt: new Date().toISOString(), definition,
    context: { sessionId, messageId, binding: { workspaceId: randomUUID(), agentDefinitionId: definition.id, agentDefinitionVersion: 1 }, truncated: false,
      messages: [{ id: messageId, sessionId, role: "user", content: "private prompt", createdAt: new Date().toISOString() }] } });
  return { run, claim, input };
}
const tokens = { inputTokens: 7, outputTokens: 5, cacheReadTokens: 3, reasoningTokens: 2 };
test("模型计量流：先持久化开始，累计快照不重复相加，缺失/异常不是零", async () => {
  const reports: ModelCallReport[] = [];
  let opened = 0;
  const source = async function* (): AsyncIterable<StreamChunk> {
    opened++; yield { type: "usage", usage: { inputTokens: 1, outputTokens: 1 } };
    yield { type: "usage", usage: tokens }; yield { type: "finish", reason: { kind: "stop" } };
  };
  await assert.rejects(async () => { for await (const _ of meterStream(source, 1, async () => { throw new Error("offline"); })) {} });
  assert.equal(opened, 0);
  for await (const _ of meterStream(source, 1, async report => { reports.push(report); })) {}
  assert.deepEqual(reports, [{ call: 1, phase: "started" }, { call: 1, phase: "finished", tokens }]);
  for (const usage of [undefined, { inputTokens: -1, outputTokens: 5 }, { inputTokens: 7, outputTokens: NaN }]) {
    reports.length = 0;
    const missing = async function* (): AsyncIterable<StreamChunk> {
      if (usage) yield { type: "usage", usage };
      yield { type: "finish", reason: { kind: "stop" } };
    };
    for await (const _ of meterStream(missing, 2, async report => { reports.push(report); })) {}
    assert.deepEqual(reports[1], { call: 2, phase: "finished", tokens: null });
  }
  reports.length = 0;
  await assert.rejects(async () => { for await (const _ of meterStream(async function* () { throw new Error("broken stream"); }, 3, async report => { reports.push(report); })) {} });
  assert.deepEqual(reports[1], { call: 3, phase: "finished", tokens: null });
  assert.equal(ModelTokens.safeParse({ ...tokens, reasoningTokens: 6 }).success, false);
  assert.equal(ModelTokens.safeParse({ ...tokens, prompt: "secret" }).success, false);
});

test("运行计量：身份/租约/序号边界，取消后只补记既有调用，发件箱失败回滚", async t => {
  const { pg, db } = await serviceDatabase("run_control"); t.after(() => pg.close());
  let failOutbox = false;
  const runs = new RunRepository({ ...db, transaction: work => db.transaction(tx => work({ query: (sql, values) => {
    if (failOutbox && sql.includes("INSERT INTO run_control.support_outbox") && sql.includes("model-usage")) throw new Error("outbox unavailable");
    return tx.query(sql, values);
  } })) });
  const { run, claim, input } = await admitted(runs);
  const report = (value: unknown, worker = "worker") => runs.reportUsage(worker, run.id, claim.lease, value);
  await assert.rejects(report({ call: 1, phase: "started" }), /INVALID_STATE/);
  await runs.input("worker", run.id, claim.lease, async () => input);
  await assert.rejects(report({ call: 1, phase: "started" }, "other"), /LEASE_LOST/);
  await assert.rejects(report({ call: 1, phase: "started", actor: bob }));
  await assert.rejects(report({ call: 2, phase: "started" }), /INVALID_STATE/);
  await assert.rejects(report({ call: 6, phase: "started" }), /INVALID_STATE/);
  await assert.rejects(report({ call: 1, phase: "finished", tokens }), /INVALID_STATE/);
  failOutbox = true; await assert.rejects(report({ call: 1, phase: "started" }), /outbox unavailable/);
  assert.equal((await db.query("SELECT * FROM run_control.model_calls")).rows.length, 0);
  failOutbox = false;
  await report({ call: 1, phase: "started" }); await report({ call: 1, phase: "started" });
  failOutbox = true; await assert.rejects(report({ call: 1, phase: "finished", tokens }), /outbox unavailable/);
  assert.equal((await db.query("SELECT final_report FROM run_control.model_calls")).rows[0]!.final_report, null);
  failOutbox = false;
  await runs.cancel(alice, run.id);
  await db.query("UPDATE run_control.runs SET lease_expires_at=clock_timestamp()-interval '1 minute' WHERE id=$1", [run.id]);
  await assert.rejects(report({ call: 1, phase: "started" }), /LEASE_LOST/);
  await report({ call: 1, phase: "finished", tokens }); await report({ call: 1, phase: "finished", tokens });
  await assert.rejects(report({ call: 1, phase: "finished", tokens: null }), /IDEMPOTENCY_CONFLICT/);
  await assert.rejects(report({ call: 2, phase: "started" }), /LEASE_LOST/);
  const events = (await db.query("SELECT payload FROM run_control.support_outbox WHERE kind='model-usage'")).rows;
  assert.equal(events.length, 2); assert.doesNotMatch(JSON.stringify(events), /private prompt|leaseId|worker/);
  assert.equal((await runs.get(alice, run.id)).state, "canceled");
  assert.equal(((await db.query("SELECT payload FROM run_control.support_outbox WHERE kind='quota-close'")).rows[0]!.payload as {expectedCalls:number}).expectedCalls,1);
});

test("用量统计：乱序去重、主体与日期隔离、未知与待报分开、不退保守预算", async t => {
  const { pg, db } = await serviceDatabase("quota"); t.after(() => pg.close());
  const quota = new QuotaRepository(db), runId = randomUUID(), day = "2026-09-21";
  const event = (call: number, report: Record<string, unknown>, actor: Principal = alice) => ({ eventId: randomUUID(), runId, actor, attempt: 1,
    provider: "deepseek-official", model: "test-model", startedAt: day + "T23:59:59.000Z", report: { call, ...report } });
  const first = event(1, { phase: "finished", tokens });
  await assert.rejects(quota.recordModelUsage(first), /INVALID_STATE/);
  await quota.reserve({ runId, actor: alice, outputTokenBudget: 5000, deadlineAt: new Date(Date.now() + 60_000).toISOString() });
  await quota.close({ runId, actor: alice });
  await quota.recordModelUsage(first); await quota.recordModelUsage(first);
  await quota.recordModelUsage(event(1, { phase: "started" }));
  await assert.rejects(quota.recordModelUsage(event(1, { phase: "finished", tokens: null })), /IDEMPOTENCY_CONFLICT/);
  await assert.rejects(quota.recordModelUsage({ ...first, model: "other" }), /IDEMPOTENCY_CONFLICT/);
  await assert.rejects(quota.recordModelUsage(event(1, { phase: "finished", tokens }, bob)), /INVALID_STATE/);
  await quota.recordModelUsage(event(2, { phase: "finished", tokens: null }));
  await quota.recordModelUsage(event(3, { phase: "started" }));
  assert.deepEqual(await quota.modelUsage(alice, day), { day, accounting: "provider-reported", startedCalls: 3, reportedCalls: 1,
    unknownCalls: 1, pendingCalls: 1, inputTokens: "7", outputTokens: "5", cacheReadTokens: "3", reasoningTokens: "2", cacheReadReportedCalls: 1, reasoningReportedCalls: 1 });
  for (const actor of [bob, otherTenant]) assert.equal((await quota.modelUsage(actor, day)).startedCalls, 0);
  assert.equal((await quota.modelUsage(alice, "2026-09-22")).startedCalls, 0);
  assert.equal((await quota.usage(alice)).reservedOutputTokensToday, 5000);
});

test("用量 HTTP：执行凭据绑定、可靠转发确认丢失重传、聚合接口仅查本人", async t => {
  const qdb = await serviceDatabase("quota"), rdb = await serviceDatabase("run_control");
  t.after(async () => { await qdb.pg.close(); await rdb.pg.close(); });
  const quota = new QuotaRepository(qdb.db,undefined,true), runs = new RunRepository(rdb.db), points = new PointsRepository(qdb.db,true);
  await points.command({kind:"price",policy:{id:randomUUID(),provider:"deepseek-official",model:"test-model",currency:"CNY",
    inputPerMillion:"1",cacheReadPerMillion:"1",outputPerMillion:"2",pointsPerYuan:"100",reservePointsPerRun:"1"}});
  await points.command({kind:"grant",id:randomUUID(),tenantId:alice.tenantId,points:"20",operator:"admin",reason:"test"});
  await points.command({kind:"allocate",id:randomUUID(),tenantId:alice.tenantId,uid:alice.uid,points:"20",operator:"admin",reason:"test"});
  const controlKey = "test-only-usage-quota-control-key-32", workerKey = "test-only-usage-runtime-worker-key-32";
  const qa = quotaAuth(secret, controlKey), ra = runAuth(secret, workerKey);
  const qapp = createQuotaApp({ repository: quota, points, authenticateApi: qa.api, authenticateControl: qa.control, ready: async () => {} });
  t.after(() => qapp.close());
  const quotaUrl = await qapp.listen({ host: "127.0.0.1", port: 0 });
  const support = supportClient({ quotaUrl, quotaSecret: controlKey, auditUrl: quotaUrl, auditSecret: "test-only-unused-audit-key-32-bytes" });
  const { run, claim, input } = await admitted(runs);
  const rapp = createRunControlApp({ repository: runs, authenticateApi: ra.api, authenticateWorker: ra.worker, resolveInput: async () => input, reserveQuota: support.reserve, ready: async () => {} });
  t.after(() => rapp.close());
  const runControlUrl = await rapp.listen({ host: "127.0.0.1", port: 0 });
  const client = runtimeClient({ runControlUrl, workspaceUrl: quotaUrl, workerId: "worker", secret: workerKey });
  await client.input(claim, new AbortController().signal);
  assert.equal((await points.balance(alice)).held,"1.000000");
  await client.usage(claim, { call: 1, phase: "started" });
  await client.usage(claim, { call: 1, phase: "finished", tokens });
  assert.equal((await rapp.inject({ method: "POST", url: `/worker/v1/runs/${run.id}/usage`, payload: { lease: claim.lease, report: { call: 2, phase: "started" } } })).statusCode, 401);
  const deliver = async (kind: "audit" | "quota-close" | "model-usage", payload: unknown) => { if (kind === "model-usage") await support.deliver(kind, payload); };
  // 将无关事件先标记完成，使测试明确命中用量确认丢失。
  await rdb.db.query("UPDATE run_control.support_outbox SET delivered_at=clock_timestamp() WHERE kind<>'model-usage'");
  assert.equal(await runs.supportBatch(async (kind, payload) => { await deliver(kind, payload); throw new Error("ack lost"); }), "retry");
  await rdb.db.query("UPDATE run_control.support_outbox SET next_attempt_at=clock_timestamp()");
  while (await runs.supportBatch(deliver) !== "idle") {}
  const api = createApiApp({ authenticate: async h => h === "bob" ? bob : alice, chat: async () => { throw new Error(); }, quota: serviceClient(quotaUrl, secret, "dsh-agent-quota") });
  t.after(() => api.close());
  const result = await api.inject("/api/v1/usage");
  assert.equal(result.statusCode, 200, result.body); assert.equal(result.json().reportedCalls, 1); assert.equal(result.json().inputTokens, "7");
  assert.equal((await api.inject({ url: "/api/v1/usage", headers: { authorization: "bob" } })).json().startedCalls, 0);
  for (const query of ["?day=2026-02-30", "?tenantId=forged", "?day=2026-09-21&day=2026-09-22"]) assert.equal((await api.inject("/api/v1/usage" + query)).statusCode, 400);
  assert.doesNotMatch(result.body, /private|leaseId|tenantId|model|actor/);
  assert.equal((await qapp.inject({ method: "POST", url: "/control/v1/usage", payload: {} })).statusCode, 401);
  assert.equal((await api.inject("/api/v1/points")).json().balance,"19.998000");
  const ledger=await api.inject("/api/v1/points/ledger?limit=1");
  assert.equal(ledger.statusCode,200,ledger.body); assert.equal(ledger.json().items[0].delta,"-0.002000");
  assert.equal((await api.inject({url:"/api/v1/points",headers:{authorization:"bob"}})).json().balance,"0.000000");
  for (const url of ["/api/v1/points?uid=bob","/api/v1/points/ledger?tenantId=forged","/api/v1/points/ledger?limit=101"]) assert.equal((await api.inject(url)).statusCode,400);
  assert.equal((await qapp.inject("/internal/v1/points")).statusCode,401);
  assert.equal((await api.inject({method:"POST",url:"/api/v1/points",payload:{points:"1000"}})).statusCode,404);
  assert.equal((await qapp.inject({method:"POST",url:"/control/v1/points",payload:{kind:"grant",points:"1000"}})).statusCode,404);
  await runs.cancel(alice,run.id);
  await rdb.db.query("UPDATE run_control.support_outbox SET next_attempt_at=clock_timestamp() WHERE kind='quota-close'");
  while(await runs.supportBatch(async(kind,payload)=>{if(kind!=="audit") await support.deliver(kind,payload);})!=="idle") {}
  assert.equal((await api.inject("/api/v1/points")).json().held,"0.000000");
});

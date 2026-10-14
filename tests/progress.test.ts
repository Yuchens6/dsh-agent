import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import { setTimeout as pause } from "node:timers/promises";
import { ExecutionInput, PublicEvent, type PublicEvent as Event, type RunProgress } from "@dsh-agent/contracts";
import type { StreamChunk } from "@deepseek-ai/dsh-llm";
import { RunRepository } from "../dsh-agent-run-control/src/repository.js";
import { previewStream } from "../dsh-agent-runtime-dsh/src/progress.js";
import { processExecutor } from "../dsh-agent-runtime-dsh/src/executor.js";
import { createRunControlApp } from "../dsh-agent-run-control/src/app.js";
import { runtimeClient } from "../dsh-agent-runtime-dsh/src/client.js";
import { authenticators } from "../dsh-agent-run-control/src/auth.js";
import { createStreamApp } from "../dsh-agent-stream/src/app.js";
import { serviceDatabase, definition } from "./workspace-catalog-helpers.js";
import { alice, bob, secret } from "./helpers.js";

async function fixture(preset: unknown = definition) {
  const { db, pg } = await serviceDatabase("run_control"), repo = new RunRepository(db);
  const sessionId = randomUUID(), messageId = randomUUID();
  const request = { eventId: randomUUID(), eventType: "conversation.message.accepted.v1", producer: "dsh-agent-chat",
    tenantId: alice.tenantId, ownerUid: alice.uid, sessionId, subjectId: messageId, occurredAt: new Date().toISOString(), traceId: "test", payload: { messageId } };
  const run = await repo.accept(request), claim = (await repo.claim("worker"))!;
  const input = ExecutionInput.parse({ runId: run.id, capturedAt: new Date().toISOString(), definition: preset,
    context: { sessionId, messageId, binding: { workspaceId: randomUUID(), agentDefinitionId: definition.id, agentDefinitionVersion: 1 }, truncated: false,
      messages: [{ id: messageId, sessionId, role: "user", content: "Say hello", createdAt: new Date().toISOString() }] } });
  await repo.input("worker", run.id, claim.lease, async () => input);
  return { db, pg, repo, claim, run, input, request };
}

test("原生技能进度：冻结定义校验、幂等、租约检查及公开白名单", async t => {
  const denied = await fixture(); t.after(() => denied.pg.close());
  await assert.rejects(denied.repo.reportProgress("worker", denied.run.id, {
    lease: denied.claim.lease, sequence: 1, report: { kind: "tool", tool: "skill" },
  }), /FORBIDDEN/);
  const f = await fixture({ ...definition, skills: [{ id: "brief", version: 1, instructions: "PRIVATE_BODY" }] }); t.after(() => f.pg.close());
  const report = { lease: f.claim.lease, sequence: 1, report: { kind: "tool", tool: "skill" } };
  await f.repo.reportProgress("worker", f.run.id, report);
  await f.repo.reportProgress("worker", f.run.id, report);
  const events: Event[] = [];
  await f.repo.publishBatch(async (_s, e) => { events.push(PublicEvent.parse(e)); });
  assert.equal(events.filter(e => e.eventType === "run.status.v1" && e.payload.tool === "skill").length, 1);
  assert.doesNotMatch(JSON.stringify(events), /PRIVATE_BODY|instructions|resourceBase/);
  await f.repo.cancel(alice, f.run.id);
  await assert.rejects(f.repo.reportProgress("worker", f.run.id, report), /LEASE_LOST/);
});

test("重试状态：已结束的最新调用、剩余预算、幂等及失效租约检查", async t => {
  const f = await fixture(); t.after(() => f.pg.close());
  const data = { lease: f.claim.lease, sequence: 1, report: { kind: "retry", call: 1, retry: 1, maxRetries: 2, delayMs: 500 } };
  await assert.rejects(f.repo.reportProgress("worker", f.run.id, data), /INVALID_STATE/);
  await f.repo.reportUsage("worker", f.run.id, f.claim.lease, { phase: "started", call: 1 });
  await assert.rejects(f.repo.reportProgress("worker", f.run.id, data), /INVALID_STATE/);
  await f.repo.reportUsage("worker", f.run.id, f.claim.lease, { phase: "finished", call: 1, tokens: null });
  await f.repo.reportProgress("worker", f.run.id, data);
  await f.repo.reportProgress("worker", f.run.id, data);
  const events: Event[] = [];
  await f.repo.publishBatch(async (_s, e) => { events.push(PublicEvent.parse(e)); });
  const retries = events.filter(e => e.eventType === "run.status.v1" && e.payload.phase === "retrying_model");
  assert.equal(retries.length, 1);
  const retry = retries[0]!; assert.equal(retry.eventType, "run.status.v1");
  if (retry.eventType !== "run.status.v1") throw new Error("Expected status");
  assert.equal(retry.payload.call, 1); assert.equal(retry.payload.delayMs, 500);
  await f.repo.reportUsage("worker", f.run.id, f.claim.lease, { phase: "started", call: 2 });
  await assert.rejects(f.repo.reportProgress("worker", f.run.id, { ...data, sequence: 2 }), /INVALID_STATE/);
  await f.repo.cancel(alice, f.run.id);
  await assert.rejects(f.repo.reportProgress("worker", f.run.id, data), /LEASE_LOST/);
});

test("实时进度：接收/领取状态、持久化去重、序号、身份、取消与最终覆盖", async t => {
  const f = await fixture(); t.after(() => f.pg.close());
  await f.repo.accept(f.request);
  await f.repo.reportUsage("worker", f.run.id, f.claim.lease, { phase: "started", call: 1 });
  await f.repo.reportUsage("worker", f.run.id, f.claim.lease, { phase: "started", call: 1 });
  const data = { lease: f.claim.lease, sequence: 1, report: { kind: "text", call: 1, text: "你😀" } };
  await f.repo.reportProgress("worker", f.run.id, data);
  await f.repo.reportProgress("worker", f.run.id, data);
  await assert.rejects(f.repo.reportProgress("other", f.run.id, data), /LEASE_LOST/);
  await assert.rejects(f.repo.reportProgress("worker", f.run.id, { ...data, lease: { ...f.claim.lease, attempt: 2 } }), /LEASE_LOST/);
  await assert.rejects(f.repo.reportProgress("worker", f.run.id, { ...data, report: { ...data.report, text: "different" } }), /IDEMPOTENCY_CONFLICT/);
  await assert.rejects(f.repo.reportProgress("worker", f.run.id, { ...data, sequence: 3 }), /INVALID_STATE/);
  await assert.rejects(f.repo.reportProgress("worker", f.run.id, { ...data, sequence: 2, report: { ...data.report, call: 2 } }), /INVALID_STATE/);
  await assert.rejects(f.repo.reportProgress("worker", f.run.id, { ...data, sequence: 4097 }));
  await assert.rejects(f.repo.get(bob, f.run.id), /NOT_FOUND/);
  const events: Event[] = [];
  await f.repo.publishBatch(async (_subject, event) => { events.push(PublicEvent.parse(event)); });
  assert.deepEqual(events.filter(e => e.eventType === "run.status.v1").map(e => e.payload.phase), ["queued", "preparing", "waiting_model"]);
  assert.equal(events.filter(e => e.eventType === "run.output.preview.v1").length, 1);
  assert.equal((await f.repo.get(alice, f.run.id)).state, "running");
  await f.repo.reportUsage("worker", f.run.id, f.claim.lease, { phase: "finished", call: 1, tokens: null });
  await assert.rejects(f.repo.reportProgress("worker", f.run.id, { ...data, sequence: 2 }), /INVALID_STATE/);
  await f.repo.finish("worker", f.run.id, { ...f.claim.lease, state: "succeeded", output: "最终答案" });
  assert.equal(await f.repo.publishBatch(async () => {}), 0, "完成事件仍等待会话投影");
  await f.repo.projectBatch(async () => {});
  await f.repo.publishBatch(async (_subject, event) => { events.push(PublicEvent.parse(event)); });
  assert.equal(events.find(e => e.eventType === "run.output.snapshot.v1")?.payload.text, "最终答案");
  assert.equal(events.at(-1)?.eventType, "run.completed.v1");
  await assert.rejects(f.repo.reportProgress("worker", f.run.id, data), /LEASE_LOST/);
});

test("实时进度：取消后拒绝重放，累计容量与事务失败不消耗序号", async t => {
  const f = await fixture(); t.after(() => f.pg.close());
  await f.repo.reportUsage("worker", f.run.id, f.claim.lease, { phase: "started", call: 1 });
  const data = { lease: f.claim.lease, sequence: 1, report: { kind: "text", call: 1, text: "hello" } };
  const broken = new RunRepository({ ...f.db, transaction: work => f.db.transaction(tx => work({ query: async (sql, args) => {
    if (sql.startsWith("INSERT INTO run_control.outbox")) throw new Error("outbox unavailable");
    return tx.query(sql, args);
  } })) });
  await assert.rejects(broken.reportProgress("worker", f.run.id, data), /outbox unavailable/);
  assert.equal((await f.db.query("SELECT progress_sequence FROM run_control.runs")).rows[0]!.progress_sequence, 0);
  await f.db.query("UPDATE run_control.runs SET progress_bytes=1048576");
  await assert.rejects(f.repo.reportProgress("worker", f.run.id, data), /QUOTA_EXCEEDED/);
  await f.db.query("UPDATE run_control.runs SET progress_bytes=0");
  await f.repo.reportProgress("worker", f.run.id, data);
  await f.repo.cancel(alice, f.run.id);
  await assert.rejects(f.repo.reportProgress("worker", f.run.id, data), /LEASE_LOST/);
});

test("事件发布：持续输出按运行轮转，超大 JSON 快照可由授权查询恢复", async t => {
  const f = await fixture(); t.after(() => f.pg.close());
  await f.repo.publishBatch(async () => {});
  const secondMessage = randomUUID();
  const second = await f.repo.accept({ ...f.request, eventId: randomUUID(), subjectId: secondMessage, payload: { messageId: secondMessage } });
  await f.repo.reportUsage("worker", f.run.id, f.claim.lease, { phase: "started", call: 1 });
  const turns: Event[] = [];
  await f.repo.publishBatch(async (_subject, event) => { turns.push(event); });
  assert.equal(turns[0]!.subjectId, second.id, "新任务提示不被持续输出的旧任务抢占");
  await f.repo.publishBatch(async () => {});
  const output = "\u0001".repeat(32_000);
  await f.repo.finish("worker", f.run.id, { ...f.claim.lease, state: "succeeded", output });
  await f.repo.projectBatch(async () => {});
  const final: Event[] = [];
  await f.repo.publishBatch(async (_subject, event) => { final.push(PublicEvent.parse(event)); });
  assert.equal(final.find(e => e.eventType === "run.output.snapshot.v1")?.payload.text, null);
  assert.ok(final.every(event => Buffer.byteLength(JSON.stringify(event)) < 131072));
  assert.equal((await f.repo.get(alice, f.run.id)).output, output);
  await assert.rejects(f.repo.get(bob, f.run.id), /NOT_FOUND/);
});

test("模型流：首片即时、停顿时定时刷新、过滤推理和工具参数", async () => {
  const release = Promise.withResolvers<void>(), arrived = Promise.withResolvers<void>();
  const reports: RunProgress[] = [];
  async function* source(): AsyncIterable<StreamChunk> {
    yield { type: "text-delta", index: 0, text: "首" };
    assert.equal(reports.length, 1);
    yield { type: "reasoning-delta", index: 1, text: "private-reasoning" };
    yield { type: "text-delta", index: 0, text: "后" };
    await release.promise;
  }
  const consume = (async () => { for await (const _ of previewStream(source, 1, async value => {
    reports.push(value); if (reports.length === 2) arrived.resolve();
  }, AbortSignal.timeout(5000), 20)) { /* consume */ } })();
  try {
    await Promise.race([arrived.promise, pause(2000).then(() => { throw new Error("No timed flush"); })]);
    assert.deepEqual(reports, [{ kind: "text", call: 1, text: "首" }, { kind: "text", call: 1, text: "后" }]);
  } finally { release.resolve(); await consume; }
});

test("模型流：跨片段代理对、块大小和背压保持有界", async () => {
  const reports: RunProgress[] = [];
  async function* source(): AsyncIterable<StreamChunk> {
    yield { type: "text-delta", index: 0, text: "\ud83d" };
    yield { type: "text-delta", index: 0, text: "\ude00" + "界".repeat(5000) };
  }
  for await (const _ of previewStream(source, 1, async report => { await pause(1); reports.push(report); }, AbortSignal.timeout(5000))) { /* consume */ }
  const texts = reports.filter(r => r.kind === "text").map(r => r.text);
  assert.ok(texts.every(text => text.length <= 2048 && text.isWellFormed()));
  assert.equal(texts.join(""), "😀" + "界".repeat(5000));
});

test("真实 DSH 子进程→认证 HTTP→持久事件：模型完成前已收到正文", async t => {
  const f = await fixture(); t.after(() => f.pg.close());
  const auth = authenticators(secret, secret + "worker");
  const app = createRunControlApp({ repository: f.repo, authenticateApi: auth.api, authenticateWorker: auth.worker, ready: async () => {} });
  const url = await app.listen({ host: "127.0.0.1", port: 0 }); t.after(() => app.close());
  const client = runtimeClient({ runControlUrl: url, workspaceUrl: url, workerId: "worker", secret: secret + "worker" });
  const release = Promise.withResolvers<void>(), arrived = Promise.withResolvers<void>();
  let ended = false, sequence = 0;
  const model = createServer(async (req, res) => {
    for await (const _ of req) { /* discard test prompt */ }
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write('data: {"choices":[{"index":0,"delta":{"role":"assistant","content":"实时"},"finish_reason":null}]}\n\n');
    await release.promise;
    res.end('data: {"choices":[{"index":0,"delta":{"content":"回答"},"finish_reason":null}]}\n\ndata: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}}\n\ndata: [DONE]\n\n');
    ended = true;
  });
  model.listen(0, "127.0.0.1"); await once(model, "listening");
  t.after(async () => { release.resolve(); model.closeAllConnections(); await new Promise<void>(resolve => model.close(() => resolve())); });
  const execute = processExecutor({ apiKey: "test-key", baseUrl: "http://127.0.0.1:" + (model.address() as { port: number }).port, maxToolCalls: 5 });
  const signal = AbortSignal.timeout(15_000);
  const running = execute(f.input, async () => { throw new Error("Unexpected tool"); }, signal,
    report => client.usage(f.claim, report, signal).then(() => {}),
    async report => { await client.progress(f.claim, ++sequence, report, signal); arrived.resolve(); });
  try {
    await Promise.race([arrived.promise, running.then(() => { throw new Error("Missing early preview"); }), pause(10_000).then(() => { throw new Error("Preview timeout"); })]);
    assert.equal(ended, false);
    const events: Event[] = [];
    await f.repo.publishBatch(async (_subject, event) => { events.push(event); });
    assert.ok(events.some(e => e.eventType === "run.output.preview.v1" && e.payload.text === "实时"));
    const stream = createStreamApp({ authenticate: async () => ({ actor: alice, expiresAt: Date.now() / 1000 + 60 }),
      verifyCapability: async () => Date.now() / 1000 + 60,
      source: { async open() { return { close: async () => {}, async *[Symbol.asyncIterator]() {
        for (const [i,event] of events.entries()) yield { sequence: i + 1, event };
      } }; } } });
    const streamUrl = await stream.listen({ host: "127.0.0.1", port: 0 });
    try {
      const response = await fetch(streamUrl + "/events/v1/sessions/" + f.run.sessionId,
        { headers: { "x-session-capability": "fixture" }, signal });
      assert.match(await response.text(), /run.output.preview.v1[\s\S]*实时/);
      assert.equal(ended, false, "正文必须在供应商结束之前通过 SSE 到达客户端");
    } finally { await stream.close(); }
  } finally { release.resolve(); }
  assert.equal(await running, "实时回答");
});

test("SSE：新增状态和预览可重放，过滤跨用户及私有字段", async t => {
  const f = await fixture(); t.after(() => f.pg.close());
  const rows = (await f.db.query("SELECT envelope FROM run_control.outbox ORDER BY sequence")).rows;
  const app = createStreamApp({ authenticate: async () => ({ actor: alice, expiresAt: Date.now() / 1000 + 60 }),
    verifyCapability: async () => Date.now() / 1000 + 60,
    source: { async open(_actor, _session, after) {
      assert.equal(after, 1);
      return { close: async () => {}, async *[Symbol.asyncIterator]() {
        yield { sequence: 1, event: rows[0]!.envelope };
        yield { sequence: 2, event: { ...rows[1]!.envelope as object, ownerUid: bob.uid } };
        const event = rows[1]!.envelope as Event;
        yield { sequence: 3, event: { ...event, payload: { ...event.payload, apiKey: "private-key", arguments: "private-path" } } };
      } };
    } } });
  const url = await app.listen({ host: "127.0.0.1", port: 0 }); t.after(() => app.close());
  const res = await fetch(url + "/events/v1/sessions/" + f.run.sessionId, { headers: {
    "x-session-capability": "test", "last-event-id": f.run.sessionId + ":1",
  }, signal: AbortSignal.timeout(5000) });
  const body = await res.text();
  assert.equal(res.status, 200); assert.equal((body.match(/\ndata:/g) ?? []).length, 1);
  assert.match(body, /run.status.v1/); assert.match(body, /preparing/); assert.doesNotMatch(body, /private-key|private-path/);
});

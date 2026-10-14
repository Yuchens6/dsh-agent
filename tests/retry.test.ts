import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import { setTimeout as pause } from "node:timers/promises";
import { ExecutionInput, type ModelCallReport, type RunProgress } from "@dsh-agent/contracts";
import { runEngine } from "../dsh-agent-runtime-dsh/src/engine.js";
import { deepseekProvider } from "../dsh-agent-runtime-dsh/src/provider.js";
import { processExecutor } from "../dsh-agent-runtime-dsh/src/executor.js";
import { ModelRetry } from "../dsh-agent-runtime-dsh/src/retry.js";
import { definition, serviceDatabase } from "./workspace-catalog-helpers.js";
import { alice, secret } from "./helpers.js";
import { RunRepository } from "../dsh-agent-run-control/src/repository.js";
import { createRunControlApp } from "../dsh-agent-run-control/src/app.js";
import { authenticators } from "../dsh-agent-run-control/src/auth.js";
import { runtimeClient } from "../dsh-agent-runtime-dsh/src/client.js";
import { executeClaim } from "../dsh-agent-runtime-dsh/src/worker.js";

function input(maxTurns = 5) {
  const sessionId = randomUUID(), messageId = randomUUID();
  return ExecutionInput.parse({ runId: randomUUID(), capturedAt: new Date().toISOString(),
    definition: { ...definition, execution: { ...definition.execution, maxTurns } },
    context: { sessionId, messageId, binding: { workspaceId: randomUUID(), agentDefinitionId: definition.id, agentDefinitionVersion: 1 }, truncated: false,
      messages: [{ id: messageId, sessionId, role: "user", content: "Review", createdAt: new Date().toISOString() }] } });
}
type Response = { status: number; retryAfter?: string } | { text: string } | { partial: string } | { tool: true };
async function server(responses: Response[]) {
  const requests: unknown[] = [];
  const app = createServer(async (req, res) => {
    const parts: Buffer[] = []; for await (const part of req) parts.push(Buffer.from(part));
    requests.push(JSON.parse(Buffer.concat(parts).toString()));
    const response = responses[Math.min(requests.length - 1, responses.length - 1)]!;
    if ("status" in response) {
      res.writeHead(response.status, { "content-type": "application/json", ...(response.retryAfter ? { "retry-after": response.retryAfter } : {}) });
      res.end(JSON.stringify({ error: { message: "upstream-private-detail", type: "test" } })); return;
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    const delta = "tool" in response ? { tool_calls: [{ index: 0, id: "call_write", type: "function",
      function: { name: "workspace_write", arguments: JSON.stringify({ path: "note.txt", content: "saved", expectedVersion: null }) } }] }
      : { content: "partial" in response ? response.partial : response.text };
    res.write("data: " + JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] }) + "\n\n");
    if ("partial" in response) { setTimeout(() => res.destroy(), 100); return; }
    res.write("data: " + JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "tool" in response ? "tool_calls" : "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } }) + "\n\n");
    res.end("data: [DONE]\n\n");
  });
  app.listen(0, "127.0.0.1"); await once(app, "listening");
  return { requests, url: "http://127.0.0.1:" + (app.address() as { port: number }).port,
    close: async () => { app.closeAllConnections(); await new Promise<void>(resolve => app.close(() => resolve())); } };
}
const fast = { maxRetries: 2, initialDelayMs: 5, maxDelayMs: 20 };
const noTool = async (): Promise<never> => { throw new Error("Unexpected tool"); };

test("DSH 原生重试：500 后成功，每次请求独立计量并报告重试状态", async t => {
  const model = await server([{ status: 500 }, { text: "recovered" }]); t.after(model.close);
  const usage: ModelCallReport[] = [], progress: RunProgress[] = [];
  const output = await runEngine(input(), deepseekProvider("test-key", model.url, fast), noTool, AbortSignal.timeout(5000), 5,
    async r => { usage.push(r); }, async r => { progress.push(r); });
  assert.equal(output, "recovered"); assert.equal(model.requests.length, 2);
  assert.deepEqual(usage.map(r => [r.call, r.phase]), [[1,"started"],[1,"finished"],[2,"started"],[2,"finished"]]);
  assert.equal(usage[1]!.phase === "finished" && usage[1]!.tokens, null, "不把失败调用用量猜成零");
  assert.equal(progress.filter(r => r.kind === "retry").length, 1);
  assert.doesNotMatch(JSON.stringify(progress), /upstream-private-detail/);
});

test("DSH 原生重试：次数耗尽、关闭、总调用预算和永久错误均有限终止", async t => {
  for (const [status, maxRetries, maxTurns, expected] of [[500,2,5,3],[500,0,5,1],[500,5,2,2],[401,2,5,1],[400,2,5,1]]) {
    const model = await server([{ status: status! }]); t.after(model.close);
    await assert.rejects(runEngine(input(maxTurns!), deepseekProvider("test-key", model.url, { ...fast, maxRetries: maxRetries! }),
      noTool, AbortSignal.timeout(5000), 5));
    assert.equal(model.requests.length, expected, JSON.stringify({ status, maxRetries, maxTurns }));
  }
});

test("DSH 原生重试：遵守 Retry-After 上限，退避期间取消不产生新请求", async t => {
  const over = await server([{ status: 429, retryAfter: "1" }]); t.after(over.close);
  await assert.rejects(runEngine(input(), deepseekProvider("test-key", over.url, fast), noTool, AbortSignal.timeout(5000), 5));
  assert.equal(over.requests.length, 1, "供应商要求的等待超过策略上限时不提前重试");
  const model = await server([{ status: 500 }]); t.after(model.close);
  const canceled = new AbortController();
  await assert.rejects(runEngine(input(), deepseekProvider("test-key", model.url, { ...fast, initialDelayMs: 1000, maxDelayMs: 1000 }),
    noTool, canceled.signal, 5, async () => {}, async r => { if (r.kind === "retry") canceled.abort(); }));
  await pause(30); assert.equal(model.requests.length, 1);
});

test("DSH 原生重试：成功写入不重做，断流预览不混入恢复后的上下文", async t => {
  const model = await server([{ tool: true }, { partial: "discard-this-draft" }, { text: "final answer" }]); t.after(model.close);
  let writes = 0;
  const progress: RunProgress[] = [];
  const output = await runEngine(input(), deepseekProvider("test-key", model.url, fast), async call => {
    assert.equal(call.tool, "workspace.write"); writes++;
    return { tool: "workspace.write", result: { path: "note.txt", version: randomUUID(), sizeBytes: 5, updatedAt: new Date().toISOString() } };
  }, AbortSignal.timeout(5000), 5, async () => {}, async r => { progress.push(r); });
  assert.equal(output, "final answer"); assert.equal(writes, 1); assert.equal(model.requests.length, 3);
  assert.match(JSON.stringify(model.requests[2]), /call_write/);
  assert.doesNotMatch(JSON.stringify(model.requests[2]), /discard-this-draft/);
  assert.ok(progress.some(r => r.kind === "text" && r.call === 2));
  assert.ok(progress.some(r => r.kind === "retry" && r.call === 2));
  assert.ok(progress.some(r => r.kind === "text" && r.call === 3));
});

test("DSH 原生重试：进度或计量确认失败不重试供应商", async t => {
  for (const broken of ["retry", "usage", "text"] as const) {
    const model = await server(broken === "text" ? [{ text: "hello" }] : [{ status: 500 }]); t.after(model.close);
    await assert.rejects(runEngine(input(), deepseekProvider("test-key", model.url, fast), noTool, AbortSignal.timeout(5000), 5,
      async r => { if (broken === "usage" && r.phase === "finished") throw new Error("No usage ACK"); },
      async r => { if (r.kind === broken) throw new Error("No progress ACK"); }));
    assert.equal(model.requests.length, 1);
  }
});

test("DSH 原生重试：真实子进程 IPC 与有限配置", async t => {
  assert.throws(() => ModelRetry.parse({ maxRetries: 6 }));
  assert.throws(() => ModelRetry.parse({ initialDelayMs: 100, maxDelayMs: 10 }));
  const model = await server([{ status: 503 }, { text: "child recovered" }]); t.after(model.close);
  const progress: RunProgress[] = [], usage: ModelCallReport[] = [];
  const output = await processExecutor({ apiKey: "test-key", baseUrl: model.url, maxToolCalls: 5, modelRetry: fast })(
    input(), noTool, AbortSignal.timeout(10_000), async r => { usage.push(r); }, async r => { progress.push(r); });
  assert.equal(output, "child recovered"); assert.equal(model.requests.length, 2);
  assert.equal(usage.length, 4); assert.equal(progress.filter(r => r.kind === "retry").length, 1);
});

test("原生重试集成：工作流调用全局编号、持久状态、完成投影与用量票据", async t => {
  const { db, pg } = await serviceDatabase("run_control"); t.after(() => pg.close());
  const repo = new RunRepository(db), data = input();
  data.definition.workflow = { steps: [
    { id: "draft", instructions: "Draft", maxTurns: 1, tools: [] },
    { id: "review", instructions: "Review", maxTurns: 3, tools: [] },
  ] };
  const run = await repo.accept({ eventId: randomUUID(), eventType: "conversation.message.accepted.v1", producer: "dsh-agent-chat",
    tenantId: alice.tenantId, ownerUid: alice.uid, sessionId: data.context.sessionId, subjectId: data.context.messageId,
    payload: { messageId: data.context.messageId }, occurredAt: new Date().toISOString(), traceId: "retry-test" });
  data.runId = run.id;
  const workerKey = "retry-test-worker-key-at-least-32-characters", auth = authenticators(secret, workerKey);
  const app = createRunControlApp({ repository: repo, authenticateApi: auth.api, authenticateWorker: auth.worker,
    resolveInput: async () => data, reserveQuota: async () => {}, ready: async () => {} });
  t.after(() => app.close());
  const url = await app.listen({ host: "127.0.0.1", port: 0 });
  const client = runtimeClient({ runControlUrl: url, workspaceUrl: url, workerId: "retry-worker", secret: workerKey });
  const model = await server([{ text: "draft" }, { status: 500 }, { text: "reviewed" }]); t.after(model.close);
  const claim = (await client.claim())!;
  await executeClaim(client, claim, processExecutor({ apiKey: "test-key", baseUrl: model.url, maxToolCalls: 5, modelRetry: fast }), AbortSignal.timeout(15_000));
  assert.equal((await repo.get(alice, run.id)).state, "succeeded");
  assert.deepEqual((await db.query("SELECT call,step_id FROM run_control.model_calls ORDER BY call")).rows,
    [{ call: 1, step_id: "draft" }, { call: 2, step_id: "review" }, { call: 3, step_id: "review" }]);
  const statuses = (await db.query("SELECT envelope->'payload' AS payload FROM run_control.outbox WHERE envelope->'payload'->>'phase'='retrying_model'")).rows;
  assert.equal(statuses.length, 1);
  assert.equal((statuses[0]!.payload as { call: number }).call, 2);
  assert.equal((statuses[0]!.payload as { stepId: string }).stepId, "review");
  assert.equal((await db.query("SELECT count(*) AS n FROM run_control.support_outbox WHERE kind='model-usage'")).rows[0]!.n, 6);
  assert.equal(await repo.publishBatch(async () => {}), 0);
  await repo.projectBatch(async (_actor, _session, result) => { assert.equal(result.output, "reviewed"); });
  assert.ok(await repo.publishBatch(async () => {}) > 0);
});

test("原生重试集成：退避消耗原总时限，不在超时后再次请求模型", async t => {
  const model = await server([{ status: 500 }]); t.after(model.close);
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  t.after(() => clearTimeout(timer));
  await assert.rejects(runEngine(input(), deepseekProvider("test-key", model.url, { maxRetries: 2, initialDelayMs: 1000, maxDelayMs: 1000 }),
    noTool, controller.signal, 5, async () => {}, async r => {
      if (r.kind === "retry") timer = setTimeout(() => controller.abort(new Error("deadline")), 30);
    }));
  assert.equal(model.requests.length, 1);
});

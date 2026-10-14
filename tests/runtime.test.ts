import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import { setTimeout as pause } from "node:timers/promises";
import { ExecutionInput, type ClaimedRun, type ModelCallReport, type RunProgress } from "@dsh-agent/contracts";
import { runEngine } from "../dsh-agent-runtime-dsh/src/engine.js";
import { deepseekProvider } from "../dsh-agent-runtime-dsh/src/provider.js";
import { processExecutor } from "../dsh-agent-runtime-dsh/src/executor.js";
import { executeClaim } from "../dsh-agent-runtime-dsh/src/worker.js";
import { RuntimeError, runtimeClient, type RuntimeClient } from "../dsh-agent-runtime-dsh/src/client.js";
import { definition, serviceDatabase, MemoryBlobs, serviceSecrets } from "./workspace-catalog-helpers.js";
import { alice, bob, secret } from "./helpers.js";
import { RunRepository } from "../dsh-agent-run-control/src/repository.js";
import { createRunControlApp } from "../dsh-agent-run-control/src/app.js";
import { authenticators } from "../dsh-agent-run-control/src/auth.js";
import { executionClient } from "../dsh-agent-run-control/src/execution-client.js";
import { workspaceCapabilitySigner, workspaceServiceVerifier } from "../dsh-agent-run-control/src/workspace-auth.js";
import { WorkspaceRepository } from "../dsh-agent-workspace/src/repository.js";
import { createWorkspaceApp } from "../dsh-agent-workspace/src/app.js";
import { serviceVerifier as workspaceVerifier } from "../dsh-agent-workspace/src/auth.js";
import { executionAuthorizer } from "../dsh-agent-workspace/src/execution-auth.js";
import { ChatRepository } from "../dsh-agent-chat/src/repository.js";
import { createChatApp } from "../dsh-agent-chat/src/app.js";
import { executionVerifier, serviceVerifier as chatVerifier } from "../dsh-agent-chat/src/auth.js";
import { CatalogRepository } from "../dsh-agent-catalog/src/repository.js";
import { createCatalogApp } from "../dsh-agent-catalog/src/app.js";
import { serviceVerifier as catalogVerifier } from "../dsh-agent-catalog/src/auth.js";
function input() {
  const sessionId = randomUUID(), messageId = randomUUID();
  return ExecutionInput.parse({ runId: randomUUID(), capturedAt: new Date().toISOString(), definition,
    context: { sessionId, messageId, binding: { workspaceId: randomUUID(), agentDefinitionId: definition.id, agentDefinitionVersion: 1 }, truncated: false,
      messages: [{ id: messageId, sessionId, role: "user", content: "Read notes.txt", createdAt: new Date().toISOString() }] } });
}
async function modelServer(responses: Array<{ text: string } | { tool: string; args: unknown } | "hang" | "length" | "overflow">,
  usage: Record<string, unknown> = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }) {
  const requests: Array<Record<string, any>> = []; // 测试夹具捕获第三方 JSON 线协议，断言前按字段检查。
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString()); requests.push(body);
    assert.equal(req.url, "/chat/completions"); assert.equal(req.headers.authorization, "Bearer test-key");
    const response = responses[Math.min(requests.length - 1, responses.length - 1)]!;
    if (response === "overflow") {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "maximum context length exceeded" } })); return;
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    if (response === "hang") { res.write(":waiting\n\n"); return; }
    const delta = typeof response === "object" && "tool" in response ? {
      role: "assistant", tool_calls: [{ index: 0, id: "call_" + requests.length, type: "function", function: { name: response.tool, arguments: JSON.stringify(response.args) } }],
    } : { role: "assistant", content: response === "length" ? "incomplete" : (response as { text: string }).text };
    const reason = response === "length" ? "length" : typeof response === "object" && "tool" in response ? "tool_calls" : "stop";
    res.write("data: " + JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] }) + "\n\n");
    res.write("data: " + JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: reason }], usage }) + "\n\n");
    res.end("data: [DONE]\n\n");
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const url = "http://127.0.0.1:" + (server.address() as { port: number }).port;
  return { url, requests, close: async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}
test("真实 DSH 核心：官方适配器、受限工具循环、历史和技能，不挂载本地工具", async t => {
  const model = await modelServer([{ tool: "skill", args: { name: "brief" } }, { tool: "workspace_read", args: { path: "notes.txt" } }, { text: "File reviewed." }],
    { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, prompt_cache_hit_tokens: 3, completion_tokens_details: { reasoning_tokens: 2 } }); t.after(model.close);
  const data = input();
  data.definition.systemPrompt = "Approved literal {{not_interpolated}}";
  data.definition.skills = [{ id: "brief", version: 1, description: "For concise responses", instructions: "Answer briefly." }];
  data.context.messages.unshift({ ...data.context.messages[0]!, id: randomUUID(), role: "assistant", content: "Previous answer" });
  let calls = 0;
  const reports: ModelCallReport[] = [];
  const output = await runEngine(data, deepseekProvider("test-key", model.url), async call => {
    assert.deepEqual(call, { tool: "workspace.read", arguments: { path: "notes.txt" } }); calls++;
    return { tool: "workspace.read", result: { path: "notes.txt", content: "safe text", version: randomUUID(), sizeBytes: 9, updatedAt: new Date().toISOString() } };
  }, new AbortController().signal, 5, async report => { reports.push(report); });
  assert.equal(output, "File reviewed."); assert.equal(calls, 1); assert.equal(model.requests.length, 3);
  assert.deepEqual(reports, [1,2,3].flatMap(call => [{ call, phase: "started" }, { call, phase: "finished", tokens: { inputTokens: 7, outputTokens: 5, cacheReadTokens: 3, reasoningTokens: 2 } }]));
  assert.equal(model.requests[0]!.max_tokens, data.definition.execution.maxOutputTokens);
  assert.deepEqual(model.requests[0]!.tools.map((item: any) => item.function.name).sort(), ["skill", "workspace_list", "workspace_read", "workspace_write"]);
  assert.match(JSON.stringify(model.requests[0]), /For concise responses/);
  assert.doesNotMatch(JSON.stringify(model.requests[0]), /Answer briefly/);
  assert.ok(model.requests[1]!.messages.some((m: { role: string; content: string }) => m.role === "tool" && m.content.includes('<skill_content name="brief">') && m.content.includes("Answer briefly.")));
  const wire = JSON.stringify(model.requests);
  assert.match(wire, /not_interpolated/); assert.match(wire, /Answer briefly/); assert.match(wire, /Previous answer/); assert.match(wire, /safe text/);
  assert.doesNotMatch(wire, /RUN_CONTROL_SECRET|run_code|bash|agent_instructions/);
  assert.ok(model.requests[0]!.messages.some((m: { role: string; content: string }) => m.role === "assistant" && m.content === "Previous answer"));
  assert.doesNotMatch(wire, /Previous conversation records/);
});

test("DSH 原生压缩：超过旧历史限制，由词元压力触发摘要，摘要计量但不公开为回答", async t => {
  const summary = "INTERNAL_CHECKPOINT_ONLY: reviewed old conversation.";
  const model = await modelServer([{ tool: "workspace_list",args: {} },{ text: summary },{ text: "final after compaction" }]); t.after(model.close);
  const data = input();
  data.context.messages.unshift(...Array.from({ length: 48 }, (_,i) => ({
    id: randomUUID(),sessionId: data.context.sessionId,role: i % 2 ? "assistant" as const : "user" as const,
    content: ("old-history-" + i + " ").padEnd(16_000,"x"),createdAt: new Date().toISOString(),
  })));
  const usage: ModelCallReport[] = [], progress: RunProgress[] = [];
  const result = await runEngine(data,deepseekProvider("test-key",model.url),async () => ({
    tool: "workspace.list",result: { items: [],nextCursor: null },
  }),AbortSignal.timeout(10_000),5,async report => { usage.push(report); },async report => { progress.push(report); });
  assert.equal(result,"final after compaction"); assert.equal(model.requests.length,3);
  assert.ok(JSON.stringify(model.requests[0]).length > 64_000);
  assert.match(JSON.stringify(model.requests[1]),/compaction engine/);
  assert.match(JSON.stringify(model.requests[2]),/compacted-summary/);
  assert.match(JSON.stringify(model.requests[2]),/INTERNAL_CHECKPOINT_ONLY/);
  assert.match(JSON.stringify(model.requests[2]),/Read notes.txt/);
  assert.ok(JSON.stringify(model.requests[2]).length < JSON.stringify(model.requests[0]).length);
  assert.deepEqual(usage.map(r => [r.call,r.phase]),[1,2,3].flatMap(call => [[call,"started"],[call,"finished"]]));
  assert.doesNotMatch(JSON.stringify(progress),/INTERNAL_CHECKPOINT_ONLY/);
  assert.deepEqual(progress.filter(r => r.kind === "text").map(r => r.call),[3]);
});

function contextInput(maxTurns = 5) {
  const data = input(); data.definition.execution.maxTurns = maxTurns;
  data.context.messages.unshift(...Array.from({ length: 8 }, (_,i) => ({
    id: randomUUID(),sessionId: data.context.sessionId,role: i % 2 ? "assistant" as const : "user" as const,
    content: ("archived-" + i).padEnd(2000,"x"),createdAt: new Date().toISOString(),
  })));
  return data;
}

test("DSH 原生上下文溢出恢复：摘要后重建请求；无可压缩历史时不无限重试", async t => {
  const model = await modelServer(["overflow",{ text: "Condensed history." },{ text: "Recovered context." }]); t.after(model.close);
  const usage: ModelCallReport[] = [], progress: RunProgress[] = [];
  const execute = processExecutor({ apiKey: "test-key",baseUrl: model.url,maxToolCalls: 1 });
  assert.equal(await execute(contextInput(3),async () => { throw new Error(); },AbortSignal.timeout(10_000),
    async report => { usage.push(report); },async report => { progress.push(report); }),"Recovered context.");
  assert.equal(model.requests.length,3);
  assert.match(JSON.stringify(model.requests[1]),/compaction engine/);
  assert.match(JSON.stringify(model.requests[2]),/compacted-summary/);
  assert.deepEqual(usage.filter(r => r.phase === "started").map(r => r.call),[1,2,3]);
  assert.doesNotMatch(JSON.stringify(progress),/Condensed history/);
  const indivisible = await modelServer(["overflow"]); t.after(indivisible.close);
  await assert.rejects(processExecutor({ apiKey: "test-key",baseUrl: indivisible.url,maxToolCalls: 1 })(
    input(),async () => { throw new Error(); },AbortSignal.timeout(10_000)),/EXECUTION_FAILED/);
  assert.equal(indivisible.requests.length,1);
});

test("DSH 原生摘要：调用预算与计量故障仍失败关闭，旧裁剪快照不静默执行", async t => {
  const budget = await modelServer(["overflow",{ text: "Condensed history." },{ text: "must not run" }]); t.after(budget.close);
  await assert.rejects(processExecutor({ apiKey: "test-key",baseUrl: budget.url,maxToolCalls: 1 })(
    contextInput(2),async () => { throw new Error(); },AbortSignal.timeout(10_000)),/EXECUTION_FAILED/);
  assert.equal(budget.requests.length,2);
  const metering = await modelServer(["overflow",{ text: "must not run" }]); t.after(metering.close);
  const execute = processExecutor({ apiKey: "test-key",baseUrl: metering.url,maxToolCalls: 1 });
  await assert.rejects(execute(contextInput(),async () => { throw new Error(); },AbortSignal.timeout(10_000),async report => {
    if (report.phase === "started" && report.call === 2) throw new Error("Accounting unavailable");
  }),/EXECUTION_FAILED/);
  assert.equal(metering.requests.length,1);
  const legacy = contextInput(); legacy.context.truncated = true;
  await assert.rejects(execute(legacy,async () => { throw new Error(); },AbortSignal.timeout(10_000)),/EXECUTION_FAILED/);
  assert.equal(metering.requests.length,1);
});
test("真实 DSH 子进程：完成输出、模型步骤上限和输出截断不误报成功", async t => {
  const model = await modelServer([{ text: "child answer" }]); t.after(model.close);
  const execute = processExecutor({ apiKey: "test-key", baseUrl: model.url, maxToolCalls: 5 });
  assert.equal(await execute(input(), async () => { throw new Error("Unexpected tool"); }, AbortSignal.timeout(10_000)), "child answer");
  const loop = await modelServer([{ tool: "workspace_list", args: {} }]); t.after(loop.close);
  const data = input(); data.definition.execution.maxTurns = 2;
  await assert.rejects(processExecutor({ apiKey: "test-key", baseUrl: loop.url, maxToolCalls: 5 })(data,
    async () => ({ tool: "workspace.list", result: { items: [], nextCursor: null } }), AbortSignal.timeout(10_000)), /EXECUTION_FAILED/);
  assert.equal(loop.requests.length, 2);
  const truncated = await modelServer(["length"]); t.after(truncated.close);
  await assert.rejects(processExecutor({ apiKey: "test-key", baseUrl: truncated.url, maxToolCalls: 5 })(input(),
    async () => { throw new Error(); }, AbortSignal.timeout(10_000)), /EXECUTION_FAILED/);
});
test("真实 DSH 子进程：取消挂起的模型请求并等待子进程退出", async t => {
  const model = await modelServer(["hang"]); t.after(model.close);
  const controller = new AbortController();
  const reports: ModelCallReport[] = [];
  const running = processExecutor({ apiKey: "test-key", baseUrl: model.url, maxToolCalls: 1 })(input(), async () => { throw new Error(); }, controller.signal, async report => { reports.push(report); });
  const rejected = assert.rejects(running, /EXECUTION_FAILED/);
  for (let i = 0; i < 200 && !model.requests.length; i++) await pause(20);
  assert.equal(model.requests.length, 1); controller.abort();
  await rejected;
  assert.deepEqual(reports[0], { call: 1, phase: "started" });
  // 子进程已被取消时终态 IPC 不保证送达；开始记录仍可标识待报。
  assert.ok(reports.filter(report => report.phase === "finished").every(report => report.tokens === null));
});
function fakeClient(data: ExecutionInput) {
  const now = new Date().toISOString();
  const claim: ClaimedRun = { run: { id: data.runId, sessionId: data.context.sessionId, messageId: data.context.messageId,
    state: "running", attempt: 1, output: null, failureCode: null, createdAt: now, updatedAt: now },
    actor: alice, lease: { leaseId: randomUUID(), attempt: 1 }, leaseExpiresAt: new Date(Date.now() + 30_000).toISOString(), deadlineAt: new Date(Date.now() + 120_000).toISOString() };
  const results: unknown[] = [];
  const client: RuntimeClient = { claim: async () => claim, input: async () => data,
    usage: async () => ({ recorded: true }),
    progress: async () => ({ recorded: true }),
    heartbeat: async () => ({ leaseExpiresAt: claim.leaseExpiresAt }), release: async () => { throw new Error("Must not acknowledge remote quiescence"); },
    finish: async (_c, result) => { results.push(result); return { ...claim.run, state: result.state }; },
    tool: async () => ({ tool: "workspace.list", result: { items: [], nextCursor: null } }) };
  return { client, claim, results };
}
test("运行工作进程：续租丢失终止、定义超时、终态重传不重跑模型", async () => {
  const data = input(), lost = fakeClient(data);
  let aborted = false;
  lost.client.heartbeat = async () => { await pause(30); throw new RuntimeError("LEASE_LOST", 409); };
  await executeClaim(lost.client, lost.claim, async (_input, _tool, signal) => new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => { aborted = true; reject(new Error()); }, { once: true });
  }), new AbortController().signal);
  assert.equal(aborted, true); assert.equal(lost.results.length, 0);
  const timeout = fakeClient(data); data.definition.execution.timeoutSeconds = 1;
  await executeClaim(timeout.client, timeout.claim, async (_input, _tool, signal) => {
    await pause(5000, undefined, { signal }); return "late";
  }, new AbortController().signal);
  assert.equal((timeout.results[0] as { failureCode: string }).failureCode, "TIMEOUT");
  const success = fakeClient(input()); let attempts = 0, executions = 0;
  const finish = success.client.finish;
  success.client.finish = async (claim, result) => { if (++attempts < 3) throw new RuntimeError("DEPENDENCY_UNAVAILABLE"); return finish(claim, result); };
  await executeClaim(success.client, success.claim, async () => { executions++; return "success"; }, new AbortController().signal);
  assert.equal(attempts, 3); assert.equal(executions, 1); assert.equal(success.results.length, 1);
  const expired = fakeClient(input()); expired.claim.deadlineAt = new Date(Date.now() - 1).toISOString();
  let expiredExecutions = 0;
  await executeClaim(expired.client, expired.claim, async () => { expiredExecutions++; return "Must not execute"; }, new AbortController().signal);
  assert.equal(expiredExecutions, 0);
  assert.equal(expired.results.length, 0);
  const denied = fakeClient(input()); let deniedExecutions = 0;
  denied.client.input = async () => { throw new RuntimeError("REQUEST_FAILED", 429); };
  await executeClaim(denied.client, denied.claim, async () => { deniedExecutions++; return "must not execute"; }, new AbortController().signal);
  assert.equal(deniedExecutions, 0);
  assert.equal((denied.results[0] as { failureCode: string }).failureCode, "QUOTA_EXCEEDED");
});

test("运行器跨服务闭环：真实 DSH 子进程经能力授权写读文件，终态投影到会话", async t => {
  // 分开数据库实例，避免测试夹具把跨服务事务错误地串行化成同一连接。
  const chatDb = await serviceDatabase("chat", "catalog"), runDb = await serviceDatabase("run_control"), workspaceDb = await serviceDatabase("workspace");
  t.after(async () => { await chatDb.pg.close(); await runDb.pg.close(); await workspaceDb.pg.close(); });
  const workspace = new WorkspaceRepository(workspaceDb.db, new MemoryBlobs());
  const owned = await workspace.ensure(alice), foreign = await workspace.ensure(bob);
  await workspace.write(bob, foreign.id, { path: "notes.txt", content: "private", expectedVersion: null });
  const catalog = new CatalogRepository(chatDb.db); await catalog.publish(definition, alice.tenantId, true);
  const chat = new ChatRepository(chatDb.db, async () => ({ workspaceId: owned.id, agentDefinitionId: definition.id, agentDefinitionVersion: 1 }));
  const chatKey = "test-only-runtime-e2e-run-chat-secret-32", catalogKey = "test-only-runtime-e2e-run-catalog-secret-32";
  const workerKey = "test-only-runtime-e2e-worker-secret-32", capKey = "test-only-runtime-e2e-capability-secret-32", authKey = "test-only-runtime-e2e-authorization-secret-32";
  const chatApp = createChatApp({ repository: chat, authenticate: chatVerifier(secret), authenticateExecution: executionVerifier(chatKey),
    signCapability: async () => { throw new Error("Not used"); }, ready: async () => {} });
  const catalogApp = createCatalogApp({ repository: catalog, authenticate: catalogVerifier({ api: serviceSecrets.apiCatalog, chat: serviceSecrets.chatCatalog, runControl: catalogKey }), ready: async () => {} });
  t.after(async () => { await chatApp.close(); await catalogApp.close(); });
  const resolver = executionClient({ chatUrl: await chatApp.listen({ host: "127.0.0.1", port: 0 }),
    catalogUrl: await catalogApp.listen({ host: "127.0.0.1", port: 0 }), chatSecret: chatKey, catalogSecret: catalogKey });
  const runs = new RunRepository(runDb.db), auth = authenticators(secret, workerKey);
  const runApp = createRunControlApp({ repository: runs, authenticateApi: auth.api, authenticateWorker: auth.worker, resolveInput: resolver.resolve,
    signWorkspaceCapability: workspaceCapabilitySigner(capKey), authenticateWorkspace: workspaceServiceVerifier(authKey), ready: async () => {} });
  t.after(() => runApp.close());
  const runControlUrl = await runApp.listen({ host: "127.0.0.1", port: 0 });
  const workspaceApp = createWorkspaceApp({ repository: workspace, authenticate: workspaceVerifier({ api: serviceSecrets.apiWorkspace, chat: serviceSecrets.chatWorkspace }),
    authorizeExecution: executionAuthorizer({ capabilitySecret: capKey, serviceSecret: authKey, runControlUrl }), ready: async () => {} });
  t.after(() => workspaceApp.close());
  const client = runtimeClient({ runControlUrl, workspaceUrl: await workspaceApp.listen({ host: "127.0.0.1", port: 0 }), workerId: "worker-e2e", secret: workerKey });
  const session = await chat.create(alice, "runtime integration", "runtime-session-key", "test");
  const message = await chat.send(alice, session.id, "Write notes.txt and read it back", "runtime-message-key", "test");
  const run = await runs.accept({ eventId: randomUUID(), eventType: "conversation.message.accepted.v1", producer: "dsh-agent-chat",
    tenantId: alice.tenantId, ownerUid: alice.uid, sessionId: session.id, subjectId: message.id, payload: { messageId: message.id }, occurredAt: new Date().toISOString(), traceId: "test" });
  const model = await modelServer([{ tool: "workspace_write", args: { path: "notes.txt", content: "my notes", expectedVersion: null } },
    { tool: "workspace_read", args: { path: "notes.txt" } }, { text: "Notes saved and verified." }]); t.after(model.close);
  const claim = await client.claim(new AbortController().signal); assert.ok(claim);
  await executeClaim(client, claim, processExecutor({ apiKey: "test-key", baseUrl: model.url, maxToolCalls: 5 }), AbortSignal.timeout(15_000));
  assert.equal((await runs.get(alice, run.id)).state, "succeeded");
  assert.equal((await workspace.read(alice, owned.id, "notes.txt")).content, "my notes");
  assert.equal((await workspace.read(bob, foreign.id, "notes.txt")).content, "private");
  assert.equal(await runs.projectBatch(resolver.project), "projected");
  const history = (await chat.history(alice, session.id, 10)).items;
  assert.equal(history.length, 2); assert.equal(history[1]!.role, "assistant");
  assert.equal(history[1]!.content, "Notes saved and verified.");
  assert.equal(model.requests.length, 3);
  const measured = (await runDb.db.query("SELECT final_report FROM run_control.model_calls WHERE run_id=$1 ORDER BY call", [run.id])).rows;
  assert.equal(measured.length, 3);
  assert.deepEqual(measured.map(row => (row.final_report as { tokens: unknown }).tokens), Array(3).fill({ inputTokens: 10, outputTokens: 5 }));
  const wire = JSON.stringify(model.requests);
  assert.doesNotMatch(wire, /private|runtime-e2e|Bearer/);
  await assert.rejects(client.tool(claim, { tool: "workspace.list", arguments: { limit: 20 } }, new AbortController().signal), /LEASE_LOST/);
});

test("真实 DSH 子进程：用量开始确认失败不调用模型，失败输出仍保留用量", async t => {
  const model = await modelServer(["length"]); t.after(model.close);
  const execute = processExecutor({ apiKey: "test-key", baseUrl: model.url, maxToolCalls: 1 });
  await assert.rejects(execute(input(), async () => { throw new Error(); }, AbortSignal.timeout(10_000), async () => { throw new Error("usage unavailable"); }));
  assert.equal(model.requests.length, 0);
  const reports: ModelCallReport[] = [];
  await assert.rejects(execute(input(), async () => { throw new Error(); }, AbortSignal.timeout(10_000), async report => { reports.push(report); }));
  assert.equal(model.requests.length, 1);
  assert.deepEqual(reports, [{ call: 1, phase: "started" }, { call: 1, phase: "finished", tokens: { inputTokens: 10, outputTokens: 5 } }]);
});

test("真实 DSH 原生 Workflow：worker-thread 条件跳过、全局用量编号与进度确认丢失重传", async t => {
  const { db,pg } = await serviceDatabase("run_control"); t.after(() => pg.close());
  const runs = new RunRepository(db), data = input();
  data.definition.skills = [{ id: "brief", version: 1, instructions: "APPROVED_WORKFLOW_SKILL" }];
  data.definition.workflow = { steps: [
    { id: "draft",instructions: "Create a DRAFT",maxTurns: 2,tools: [] },
    { id: "skip",instructions: "Never invoked",maxTurns: 1,tools: [],whenPreviousContains: "REWRITE" },
    { id: "review",instructions: "Review the prior draft",maxTurns: 1,tools: [],whenPreviousContains: "DRAFT" },
  ] };
  const run = await runs.accept({ eventId: randomUUID(),eventType: "conversation.message.accepted.v1",producer: "dsh-agent-chat",
    tenantId: alice.tenantId,ownerUid: alice.uid,sessionId: data.context.sessionId,subjectId: data.context.messageId,payload: { messageId: data.context.messageId },occurredAt: new Date().toISOString(),traceId: "test" });
  data.runId = run.id;
  const workerKey = "test-workflow-runtime-worker-secret-32", auth = authenticators(secret,workerKey);
  let reserved = 0;
  const app = createRunControlApp({ repository: runs,authenticateApi: auth.api,authenticateWorker: auth.worker,
    resolveInput: async () => data,reserveQuota: async (_actor, snapshot) => { reserved += snapshot.definition.execution.maxTurns * snapshot.definition.execution.maxOutputTokens; },ready: async () => {} });
  t.after(() => app.close());
  const url = await app.listen({ host: "127.0.0.1",port: 0 });
  const client = runtimeClient({ runControlUrl: url,workspaceUrl: url,workerId: "workflow-worker",secret: workerKey });
  const progress = client.progress, lost = new Set<string>();
  client.progress = async (...args) => {
    const ack = await progress(...args), report = args[2];
    if (report.kind === "workflow" && !lost.has(report.state)) { lost.add(report.state); throw new RuntimeError("ACK_LOST"); }
    return ack;
  };
  const model = await modelServer([{ tool: "skill", args: { name: "brief" } }, { text: 'DRAFT content"; throw new Error("not executable"); //' },{ text: "Final reviewed answer" }]); t.after(model.close);
  const claim = (await client.claim())!;
  await executeClaim(client,claim,processExecutor({ apiKey: "test-key",baseUrl: model.url,maxToolCalls: 5 }),AbortSignal.timeout(15_000));
  assert.equal((await runs.get(alice,run.id)).state,"succeeded");
  assert.equal((await runs.get(alice,run.id)).output,"Final reviewed answer");
  assert.equal(model.requests.length,3); assert.equal(reserved,5000);
  assert.deepEqual((await runs.workflowProgress(alice,run.id)).steps.map(step => step.state),["succeeded","skipped","succeeded"]);
  assert.deepEqual((await db.query("SELECT call,step_id FROM run_control.model_calls ORDER BY call")).rows,[{ call: 1,step_id: "draft" },{ call: 2,step_id: "draft" },{ call: 3,step_id: "review" }]);
  const previews = (await db.query("SELECT envelope->'payload' AS payload FROM run_control.outbox WHERE envelope->>'eventType'='run.output.preview.v1' ORDER BY sequence")).rows;
  assert.deepEqual(previews.map(r => (r.payload as { call: number; stepId: string }).call), [2,3]);
  assert.deepEqual(previews.map(r => (r.payload as { stepId: string }).stepId), ["draft","review"]);
  assert.match(JSON.stringify(model.requests[2]),/DRAFT content/);
  const skillStatus = (await db.query("SELECT envelope->'payload' AS payload FROM run_control.outbox WHERE envelope->'payload'->>'tool'='skill'")).rows;
  assert.equal(skillStatus.length, 1);
  assert.equal((skillStatus[0]!.payload as { stepId: string }).stepId, "draft");
  assert.doesNotMatch(JSON.stringify(skillStatus), /APPROVED_WORKFLOW_SKILL/);
  assert.doesNotMatch(JSON.stringify(model.requests),/Never invoked|workspace_write|workflow-worker/);
});

function nativeWorkflowInput() {
  const data = input();
  data.definition.workflow = { steps: [
    { id: "first", instructions: "First", maxTurns: 2, tools: ["workspace.list"] },
    { id: "second", instructions: "Second", maxTurns: 2, tools: ["workspace.list"] },
  ] };
  return data;
}

test("原生技能：显式调用去重、别名和调用策略，历史及路径不伪造本轮调用", async t => {
  const model = await modelServer([{ text: "done" }]); t.after(model.close);
  const data = input();
  data.definition.tools = [];
  data.definition.skills = [
    { id: "Manual_Internal", name: "manual", version: 2, instructions: "MANUAL_BODY_ONLY", description: "Manual only", invocation: { modelInvocable: false, userInvocable: true } },
    { id: "model-only", version: 1, instructions: "MODEL_BODY_ONLY", description: "MODEL_ROUTING_ONLY", invocation: { modelInvocable: true, userInvocable: false } },
    { id: "disabled", version: 1, instructions: "DISABLED_BODY_ONLY", invocation: { modelInvocable: false, userInvocable: false } },
    { id: "historical", version: 1, instructions: "HISTORICAL_BODY_ONLY" },
  ];
  data.context.messages.unshift({ ...data.context.messages[0]!, id: randomUUID(), content: "/historical" });
  data.context.messages.at(-1)!.content = "Please /manual /manual /model-only /disabled /unknown /usr/bin 5/8";
  const progress: RunProgress[] = [];
  const execute = processExecutor({ apiKey: "test-key", baseUrl: model.url, maxToolCalls: 1 });
  assert.equal(await execute(data, async () => { throw new Error("Unexpected remote tool"); }, AbortSignal.timeout(10_000), undefined,
    async value => { progress.push(value); }), "done");
  const wire = JSON.stringify(model.requests);
  assert.equal(wire.split("MANUAL_BODY_ONLY").length - 1, 1);
  assert.match(wire, /MODEL_ROUTING_ONLY/);
  assert.doesNotMatch(wire, /MODEL_BODY_ONLY|DISABLED_BODY_ONLY|HISTORICAL_BODY_ONLY|Manual only/);
  assert.deepEqual(model.requests[0]!.tools.map((tool: { function: { name: string } }) => tool.function.name), ["skill"]);
  assert.equal(progress.filter(p => p.kind === "tool").length, 0, "显式调用是原生上下文注入，不伪造工具调用");
});

test("原生技能：未知、越权和路径型名称由原生工具拒绝，技能不跨运行泄漏", async t => {
  const model = await modelServer([
    { tool: "skill", args: { name: "foreign" } }, { tool: "skill", args: { name: "manual" } },
    { tool: "skill", args: { name: "../../secret" } }, { text: "handled" }, { text: "unrelated" },
  ]); t.after(model.close);
  const data = input();
  data.definition.skills = [{ id: "manual", version: 1, instructions: "PRIVATE_SKILL_BODY", invocation: { modelInvocable: false, userInvocable: true } }];
  const execute = processExecutor({ apiKey: "test-key", baseUrl: model.url, maxToolCalls: 3 });
  const reports: RunProgress[] = [];
  const unused = async () => { throw new Error("Unexpected remote tool"); };
  assert.equal(await execute(data, unused, AbortSignal.timeout(10_000), undefined, async value => { reports.push(value); }), "handled");
  const wire = JSON.stringify(model.requests);
  assert.match(wire, /unknown or no longer available/);
  assert.match(wire, /not available for model invocation/);
  assert.match(wire, /invalid skill name/);
  assert.doesNotMatch(wire, /PRIVATE_SKILL_BODY/);
  assert.equal(reports.filter(p => p.kind === "tool" && p.tool === "skill").length, 3);
  assert.equal(await execute(input(), unused, AbortSignal.timeout(10_000)), "unrelated");
  assert.doesNotMatch(JSON.stringify(model.requests.at(-1)), /PRIVATE_SKILL_BODY|available_skills|"name":"skill"/);
});

test("原生技能：进度确认失败中止，技能调用与远程工具共享预算", async t => {
  const data = input(); data.definition.skills = [{ id: "brief", version: 1, instructions: "SKILL_BODY" }];
  const broken = await modelServer([{ tool: "skill", args: { name: "brief" } }, { text: "unreachable" }]); t.after(broken.close);
  const unused = async () => { throw new Error("Unexpected remote tool"); };
  await assert.rejects(processExecutor({ apiKey: "test-key", baseUrl: broken.url, maxToolCalls: 2 })(data, unused,
    AbortSignal.timeout(10_000), undefined, async report => {
      if (report.kind === "tool") throw new Error("Progress ACK unavailable");
    }), /EXECUTION_FAILED/);
  assert.equal(broken.requests.length, 1);
  const limited = await modelServer([{ tool: "skill", args: { name: "brief" } }, { tool: "workspace_list", args: {} }, { text: "unreachable" }]); t.after(limited.close);
  let remote = 0;
  await assert.rejects(processExecutor({ apiKey: "test-key", baseUrl: limited.url, maxToolCalls: 1 })(data, async () => {
    remote++; return { tool: "workspace.list", result: { items: [], nextCursor: null } };
  }, AbortSignal.timeout(10_000)), /EXECUTION_FAILED/);
  assert.equal(remote, 0); assert.equal(limited.requests.length, 2);
});

test("原生 Workflow：本地技能预算跨步骤累计，技能不能绕过步骤工具权限", async t => {
  const model = await modelServer([{ tool: "skill", args: { name: "brief" } }, { text: "first" }, { tool: "workspace_list", args: {} }]); t.after(model.close);
  const data = nativeWorkflowInput(); data.definition.skills = [{ id: "brief", version: 1, instructions: "WORKFLOW_SKILL_BODY" }];
  let calls = 0;
  await assert.rejects(processExecutor({ apiKey: "test-key", baseUrl: model.url, maxToolCalls: 1 })(
    data, async () => { calls++; return { tool: "workspace.list", result: { items: [], nextCursor: null } }; },
    AbortSignal.timeout(10_000)), /EXECUTION_FAILED/);
  assert.equal(calls, 0); assert.equal(model.requests.length, 3);
  assert.match(JSON.stringify(model.requests[1]), /WORKFLOW_SKILL_BODY/);
  assert.doesNotMatch(JSON.stringify(model.requests[2]), /WORKFLOW_SKILL_BODY/, "不同步骤按需重新加载正文");
});

test("原生 Workflow：状态确认失败和模型失败停止流程，不启动后续步骤", async t => {
  const model = await modelServer([{ text: "first result" }]); t.after(model.close);
  const execute = processExecutor({ apiKey: "test-key", baseUrl: model.url, maxToolCalls: 5 });
  const unused = async () => { throw new Error("Unexpected tool"); };
  for (const state of ["running", "succeeded"]) {
    await assert.rejects(execute(nativeWorkflowInput(), unused, AbortSignal.timeout(10_000), undefined, async report => {
      if (report.kind === "workflow" && report.state === state) throw new Error("ACK unavailable");
    }), /EXECUTION_FAILED/);
  }
  assert.equal(model.requests.length, 1);
  const truncated = await modelServer(["length"]); t.after(truncated.close);
  const reports: RunProgress[] = [];
  await assert.rejects(processExecutor({ apiKey: "test-key", baseUrl: truncated.url, maxToolCalls: 5 })(
    nativeWorkflowInput(), unused, AbortSignal.timeout(10_000), undefined, async report => { reports.push(report); }), /EXECUTION_FAILED/);
  assert.equal(truncated.requests.length, 1);
  assert.deepEqual(reports.filter(r => r.kind === "workflow"), [{ kind: "workflow",stepId: "first",state: "running" }]);
});

test("原生 Workflow：取消活动子智能体，不执行后续步骤", async t => {
  const model = await modelServer(["hang"]); t.after(model.close);
  const controller = new AbortController(), reports: RunProgress[] = [];
  t.after(() => controller.abort());
  const running = processExecutor({ apiKey: "test-key", baseUrl: model.url, maxToolCalls: 5 })(
    nativeWorkflowInput(), async () => { throw new Error(); }, AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]),
    undefined, async report => { reports.push(report); });
  const rejected = assert.rejects(running, /EXECUTION_FAILED/);
  for (let i = 0; i < 200 && !model.requests.length; i++) await pause(20);
  assert.equal(model.requests.length, 1); controller.abort(); await rejected;
  assert.deepEqual(reports.filter(r => r.kind === "workflow"), [{ kind: "workflow",stepId: "first",state: "running" }]);
});

test("原生 Workflow：工具次数预算跨步骤累计，不随子智能体重置", async t => {
  const model = await modelServer([{ tool: "workspace_list",args: {} },{ text: "first" },{ tool: "workspace_list",args: {} }]); t.after(model.close);
  let calls = 0;
  await assert.rejects(processExecutor({ apiKey: "test-key",baseUrl: model.url,maxToolCalls: 1 })(
    nativeWorkflowInput(), async () => { calls++; return { tool: "workspace.list",result: { items: [],nextCursor: null } }; },
    AbortSignal.timeout(10_000)), /EXECUTION_FAILED/);
  assert.equal(calls, 1); assert.equal(model.requests.length, 3);
});

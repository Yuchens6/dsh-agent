import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { AgentDefinition, ExecutionInput, type RunProgress } from "@dsh-agent/contracts";
import { serviceDatabase, definition } from "./workspace-catalog-helpers.js";
import { alice, bob, otherTenant, secret } from "./helpers.js";
import { RunRepository } from "../dsh-agent-run-control/src/repository.js";
import { CatalogRepository } from "../dsh-agent-catalog/src/repository.js";
import { createRunControlApp } from "../dsh-agent-run-control/src/app.js";
import { authenticators } from "../dsh-agent-run-control/src/auth.js";
import { createApiApp } from "../dsh-agent-api/src/app.js";
import { serviceClient } from "../dsh-agent-api/src/chat-client.js";
import { stepInput } from "../dsh-agent-runtime-dsh/src/workflow.js";

const workflowDefinition = () => AgentDefinition.parse({ ...definition, workflow: { steps: [
  { id: "draft", instructions: "Draft only", maxTurns: 1, tools: ["workspace.read"] },
  { id: "optional", instructions: "Optional rewrite", maxTurns: 1, tools: [], whenPreviousContains: "REWRITE" },
  { id: "review", instructions: "Review draft", maxTurns: 2, tools: [], whenPreviousContains: "DRAFT" },
] } });
async function prepare(runs: RunRepository) {
  const messageId = randomUUID(), sessionId = randomUUID();
  const run = await runs.accept({ eventId: randomUUID(), eventType: "conversation.message.accepted.v1", producer: "dsh-agent-chat",
    tenantId: alice.tenantId, ownerUid: alice.uid, sessionId, subjectId: messageId, payload: { messageId }, occurredAt: new Date().toISOString(), traceId: "test" });
  const claim = (await runs.claim("worker"))!;
  const input = ExecutionInput.parse({ runId: run.id, capturedAt: new Date().toISOString(), definition: workflowDefinition(), context: {
    sessionId, messageId, binding: { workspaceId: randomUUID(), agentDefinitionId: definition.id, agentDefinitionVersion: 1 }, truncated: false,
    messages: [{ id: messageId, sessionId, role: "user", content: "private task", createdAt: new Date().toISOString() }] } });
  await runs.input("worker", run.id, claim.lease, async () => input);
  return { run, claim, input };
}
async function measured(runs: RunRepository, id: string, lease: { attempt: number; leaseId: string }, call: number) {
  await runs.reportUsage("worker", id, lease, { call, phase: "started" });
  await runs.reportUsage("worker", id, lease, { call, phase: "finished", tokens: { inputTokens: 10, outputTokens: 5 } });
}
test("工作流定义：不可变版本、租户授权、步骤预算及工具子集验证", async t => {
  const { pg,db } = await serviceDatabase("catalog"); t.after(() => pg.close());
  const catalog = new CatalogRepository(db), valid = workflowDefinition();
  await catalog.publish(valid, alice.tenantId, true);
  assert.deepEqual((await catalog.getDefault(alice)).workflow, valid.workflow);
  await assert.rejects(catalog.get(otherTenant, valid.id, valid.version), /NOT_FOUND/);
  await assert.rejects(catalog.publish({ ...valid, workflow: { steps: [{ ...valid.workflow!.steps[0], instructions: "changed" }] } }, alice.tenantId, false), /VERSION_CONFLICT/);
  const first = valid.workflow!.steps[0]!;
  for (const steps of [[], [first,first], [{ ...first,whenPreviousContains: "x" }], [{ ...first,maxTurns: 6 }],
    [{ ...first,tools: ["bash"] }], [{ ...first,tools: ["workspace.read","workspace.read"] }], [{ ...first, next: "draft" }]]) {
    assert.equal(AgentDefinition.safeParse({ ...valid, workflow: { steps } }).success, false);
  }
  assert.equal(AgentDefinition.safeParse({ ...valid, tools: [], workflow: { steps: [first] } }).success, false);
  assert.equal(AgentDefinition.safeParse({ ...valid, systemPrompt: "x".repeat(16000) }).success, false);
});

test("原生工作流状态投影：用量屏障、工具权限、进度幂等及终态一致性", async t => {
  const { pg,db } = await serviceDatabase("run_control"); t.after(() => pg.close());
  const runs = new RunRepository(db), { run,claim,input } = await prepare(runs);
  let sequence = 0;
  const report = async (value: RunProgress) => { await runs.reportProgress("worker",run.id,{ lease: claim.lease,sequence: sequence + 1,report: value }); sequence++; };
  const result = (stepId: string, output: string) => report({ kind: "workflow",stepId,state: "succeeded",output });
  const auth = (tool: "workspace.read" | "workspace.write") => runs.authorizeWorkspace({ runId: run.id, workerId: "worker", ...claim.lease,tool });
  await assert.rejects(runs.reportUsage("worker",run.id,claim.lease,{ call: 1,phase: "started" }), /INVALID_STATE/);
  await assert.rejects(auth("workspace.read"), /FORBIDDEN/);
  await report({ kind: "workflow",stepId: "draft",state: "running" });
  await assert.rejects(report({ kind: "workflow",stepId: "review",state: "running" }), /INVALID_STATE/);
  await auth("workspace.read"); await assert.rejects(auth("workspace.write"), /FORBIDDEN/);
  await assert.rejects(result("review","bypass"), /INVALID_STATE/);
  await assert.rejects(result("draft","DRAFT"), /INVALID_STATE/);
  await runs.reportUsage("worker",run.id,claim.lease,{ call: 1,phase: "started" });
  await assert.rejects(result("draft","DRAFT"), /INVALID_STATE/);
  await runs.reportUsage("worker",run.id,claim.lease,{ call: 1,phase: "finished",tokens: null });
  await assert.rejects(runs.reportUsage("worker",run.id,claim.lease,{ call: 2,phase: "started" }), /INVALID_STATE/);
  await result("draft","DRAFT safe");
  const replay = { lease: claim.lease, sequence, report: { kind: "workflow",stepId: "draft",state: "succeeded",output: "DRAFT safe" } };
  await runs.reportProgress("worker",run.id,replay);
  await assert.rejects(runs.reportProgress("worker",run.id,{ ...replay,report: { ...replay.report,output: "changed" } }), /IDEMPOTENCY_CONFLICT/);
  await assert.rejects(runs.finish("worker",run.id,{ ...claim.lease,state: "succeeded",output: "DRAFT safe" }), /INVALID_STATE/);
  // The service does not evaluate conditions or choose a next step.
  assert.deepEqual((await runs.workflowProgress(alice,run.id)).steps.map(s => s.state),["succeeded","pending","pending"]);
  await report({ kind: "workflow",stepId: "optional",state: "skipped" });
  await report({ kind: "workflow",stepId: "review",state: "running" });
  await assert.rejects(auth("workspace.read"), /FORBIDDEN/);
  await measured(runs,run.id,claim.lease,2); await result("review","final answer");
  await assert.rejects(report({ kind: "workflow",stepId: "unknown",state: "running" }), /INVALID_STATE/);
  await assert.rejects(runs.finish("worker",run.id,{ ...claim.lease,state: "succeeded",output: "forged" }), /INVALID_STATE/);
  await runs.finish("worker",run.id,{ ...claim.lease,state: "succeeded",output: "final answer" });
  const state = await runs.workflowProgress(alice,run.id);
  assert.deepEqual(state.steps.map(s => s.state),["succeeded","skipped","succeeded"]);
  assert.doesNotMatch(JSON.stringify(state),/safe|final answer|private task|instructions/);
  assert.equal((await db.query("SELECT step_id FROM run_control.model_calls ORDER BY call")).rows.map(r => r.step_id).join(","),"draft,review");
  assert.equal(input.definition.execution.maxTurns,5);
});

test("工作流取消与接口：不能推进/跨用户查询，步骤显示中断，旧定义兼容", async t => {
  const { pg,db } = await serviceDatabase("run_control"); t.after(() => pg.close());
  const runs = new RunRepository(db), { run,claim,input } = await prepare(runs);
  const started = { lease: claim.lease,sequence: 1,report: { kind: "workflow",stepId: "draft",state: "running" } };
  await runs.reportProgress("worker",run.id,started);
  await runs.cancel(alice,run.id);
  await assert.rejects(runs.reportProgress("worker",run.id,started), /LEASE_LOST/);
  await assert.rejects(runs.reportProgress("worker",run.id,{ ...started,sequence: 2,report: { kind: "workflow",stepId: "draft",state: "succeeded",output: "late" } }), /LEASE_LOST/);
  assert.equal((await runs.workflowProgress(alice,run.id)).steps[0]!.state,"interrupted");
  for (const actor of [bob,otherTenant]) await assert.rejects(runs.workflowProgress(actor,run.id), /NOT_FOUND/);
  const auth = authenticators(secret,"test-workflow-worker-secret-32-bytes");
  const app = createRunControlApp({ repository: runs,authenticateApi: auth.api,authenticateWorker: auth.worker,ready: async () => {} });
  t.after(() => app.close());
  const url = await app.listen({ host: "127.0.0.1",port: 0 });
  const api = createApiApp({ authenticate: async h => h === "bob" ? bob : alice,chat: async () => { throw new Error(); }, runs: serviceClient(url,secret,"dsh-agent-run-control") });
  t.after(() => api.close());
  const path = `/api/v1/runs/${run.id}/workflow`;
  assert.equal((await api.inject(path)).statusCode,200);
  assert.equal((await api.inject({ url: path,headers: { authorization: "bob" } })).statusCode,404);
  assert.equal((await api.inject(path + "?uid=alice")).statusCode,400);
  assert.equal((await app.inject({ method: "POST",url: `/worker/v1/runs/${run.id}/workflow/next`,payload: claim.lease })).statusCode,404);
  await db.query("UPDATE run_control.runs SET execution_input=$2 WHERE id=$1",[run.id,JSON.stringify({ ...input,definition })]);
  const legacy = await runs.workflowProgress(alice,run.id); assert.equal(legacy.enabled,false); assert.deepEqual(legacy.steps,[]);
});

test("步骤输入：指令与历史分离，不在平台裁剪上下文，原始快照不改变", () => {
  const sessionId = randomUUID(), messageId = randomUUID();
  const input = ExecutionInput.parse({ runId: randomUUID(),capturedAt: new Date().toISOString(),definition: workflowDefinition(),context: {
    sessionId,messageId,binding: { workspaceId: randomUUID(),agentDefinitionId: definition.id,agentDefinitionVersion: 1 },truncated: false,
    messages: Array.from({ length: 40 },(_,i) => ({ id: i === 39 ? messageId : randomUUID(),sessionId,role: "user",content: "a".repeat(1600),createdAt: new Date().toISOString() })) } });
  const step = input.definition.workflow!.steps[2]!, previousOutput = "untrusted ".repeat(3000), snapshot = JSON.stringify(input);
  const actual = stepInput(input,step,previousOutput);
  assert.equal(actual.definition.workflow,undefined); assert.equal(actual.definition.execution.maxTurns,2);
  assert.deepEqual(actual.definition.tools,[]); assert.match(actual.definition.systemPrompt,/Review draft/);
  assert.doesNotMatch(actual.definition.systemPrompt,/untrusted/);
  assert.equal(actual.context.messages.at(-2)!.content,previousOutput);
  assert.equal(actual.context.truncated,false);
  assert.equal(actual.context.messages.length,41);
  assert.equal(actual.context.messages.reduce((sum,m) => sum+m.content.length,0),64000 + previousOutput.length);
  assert.equal(JSON.stringify(input),snapshot);
});

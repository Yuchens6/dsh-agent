import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import { SignJWT } from "jose";
import { AgentDefinition, KnowledgeSearch, KnowledgeToolCall, ExecutionInput, type KnowledgeAuthorization } from "@dsh-agent/contracts";
import { sourceRegistry } from "../dsh-agent-knowledge/src/sources.js";
import { lightRagClient } from "../dsh-agent-knowledge/src/lightrag.js";
import { createKnowledgeApp } from "../dsh-agent-knowledge/src/app.js";
import { knowledgeAuthorizer } from "../dsh-agent-knowledge/src/auth.js";
import { KnowledgeError } from "../dsh-agent-knowledge/src/network.js";
import { knowledgeCapabilitySigner, knowledgeServiceVerifier } from "../dsh-agent-run-control/src/knowledge-auth.js";
import { workspaceCapabilitySigner } from "../dsh-agent-run-control/src/workspace-auth.js";
import { RunRepository } from "../dsh-agent-run-control/src/repository.js";
import { createRunControlApp } from "../dsh-agent-run-control/src/app.js";
import { authenticators } from "../dsh-agent-run-control/src/auth.js";
import { runtimeClient } from "../dsh-agent-runtime-dsh/src/client.js";
import { processExecutor } from "../dsh-agent-runtime-dsh/src/executor.js";
import { executeClaim } from "../dsh-agent-runtime-dsh/src/worker.js";
import { serviceDatabase, definition } from "./workspace-catalog-helpers.js";
import { alice, bob, otherTenant, secret } from "./helpers.js";
import { knowledgeDatabase } from "./knowledge-helpers.js";
import { publishCorpus } from "../dsh-agent-knowledge/src/corpus.js";

const capKey = "test-knowledge-capability-key-32-bytes-long";
const serviceKey = "test-knowledge-authorization-key-32-bytes-long";
const workerKey = "test-runtime-control-knowledge-32-bytes-long";
const sourceToken = "test-upstream-private-api-key";
const query = KnowledgeSearch.parse({ sourceId: "handbook", query: "项目使用什么数据库", keywords: ["项目", "数据库"] });
const call = { tool: "knowledge.search" as const, arguments: query };
const result = { sourceId: "handbook", chunks: [], entities: [], relationships: [], truncated: false };
const ragData = { status: "success", message: "ok", data: {
  chunks: [{ chunk_id: "chunk-1", content: "平台使用 PostgreSQL。", reference_id: "1", file_path: "C:/private/secret.txt" }],
  entities: [{ entity_name: "PostgreSQL", entity_type: "DATABASE", description: "关系型数据库", file_path: "secret" }],
  relationships: [{ src_id: "DSH平台", tgt_id: "PostgreSQL", description: "使用", internal_secret: "hidden" }],
  references: [{ reference_id: "1", file_path: "C:/private/secret.txt" }],
} };
const agent = () => AgentDefinition.parse({ ...definition, tools: ["knowledge.search"], knowledgeSources: ["handbook"] });
const registry = (endpoint: string) => sourceRegistry({ sources: [{ id: "handbook", endpoint, apiKeyEnv: "TEST_LIGHTRAG_KEY", readers: [alice] .map(({ tenantId, uid }) => ({ tenantId, uid })) }] }, { TEST_LIGHTRAG_KEY: sourceToken });
const authorization = (): KnowledgeAuthorization => ({ runId: randomUUID(), leaseId: randomUUID(), attempt: 1, workerId: "worker-a",
  tool: "knowledge.search", sourceId: "handbook", actor: alice, workspaceId: randomUUID(), leaseExpiresAt: new Date(Date.now() + 30000).toISOString() });

test("知识协议和来源：定义显式绑定、未知参数拒绝、用户与公司授权隔离", () => {
  assert.equal(agent().tools[0], "knowledge.search");
  assert.equal(AgentDefinition.safeParse({ ...definition, tools: ["knowledge.search"] }).success, false);
  assert.equal(AgentDefinition.safeParse({ ...agent(), knowledgeSources: ["handbook", "handbook"] }).success, false);
  for (const extra of [{ url: "http://evil" }, { tenantId: "other" }, { workspaceId: randomUUID() }, { cypher: "MATCH (n) RETURN n" }]) {
    assert.equal(KnowledgeToolCall.safeParse({ ...call, arguments: { ...query, ...extra } }).success, false);
  }
  const sources = registry("http://127.0.0.1:9621");
  assert.equal(sources.resolve("handbook", alice).apiKey, sourceToken);
  for (const actor of [bob, otherTenant]) assert.throws(() => sources.resolve("handbook", actor), /FORBIDDEN/);
  assert.throws(() => sources.resolve("unknown", alice), /FORBIDDEN/);
  assert.throws(() => sourceRegistry({ sources: [{ id: "a", endpoint: "http://user:password@127.0.0.1", apiKeyEnv: "KEY", readers: [{ tenantId: "a", uid: "a" }] }] }, { KEY: sourceToken }));
  assert.throws(() => sourceRegistry({ sources: [{ id: "a", endpoint: "http://127.0.0.1", apiKeyEnv: "KEY", readers: [{ tenantId: "a", uid: "a" }] }] }, { KEY: sourceToken, NODE_ENV: "production" }), /HTTPS/);
});

test("LightRAG 适配：固定检索端点、图谱与文本证据、关键词避免二次生成、隐藏上游元数据", async t => {
  const upstream = Fastify(); t.after(() => upstream.close()); let requests = 0;
  upstream.post("/query/data", async req => {
    requests++; assert.equal(req.headers["x-api-key"], sourceToken);
    const body = req.body as Record<string, unknown>;
    assert.deepEqual(body.hl_keywords, query.keywords); assert.deepEqual(body.ll_keywords, query.keywords);
    assert.equal(body.mode, "mix"); assert.equal(body.enable_rerank, false); assert.equal(body.chunk_top_k, 5);
    assert.equal(body.conversation_history, undefined); assert.equal(body.workspaceId, undefined);
    return ragData;
  });
  const url = await upstream.listen({ host: "127.0.0.1", port: 0 });
  const source = registry(url).resolve("handbook", alice);
  const retrieve = lightRagClient();
  const value = await retrieve(source, query, AbortSignal.timeout(5000));
  assert.equal(value.chunks[0]?.content, "平台使用 PostgreSQL。");
  assert.equal(value.entities[0]?.name, "PostgreSQL"); assert.equal(value.relationships[0]?.target, "PostgreSQL");
  assert.match(value.chunks[0]!.citation, /^handbook:[a-f0-9]{24}$/);
  assert.equal(JSON.stringify(value).includes("secret"), false); assert.equal(JSON.stringify(value).includes("file_path"), false);
  const again = await retrieve(source, query, AbortSignal.timeout(5000));
  assert.equal(again.chunks[0]!.citation, value.chunks[0]!.citation); assert.equal(requests, 2);
});

test("LightRAG 适配：拒绝重定向、超大响应、畸形响应、超时；输出有界且保留字符完整", async t => {
  const server = Fastify(); t.after(() => server.close()); let mode = "redirect", followed = 0;
  server.post("/query/data", async (_req, reply) => {
    if (mode === "redirect") return reply.redirect("/leak");
    if (mode === "big") return { padding: "a".repeat(1024 * 1024 + 1) };
    if (mode === "bad") return { status: "success", data: { chunks: "bad" } };
    if (mode === "timeout") { await new Promise(resolve => setTimeout(resolve, 100)); return ragData; }
    return { ...ragData, data: { ...ragData.data, chunks: Array.from({ length: 20 }, () => ({ content: "😀".repeat(10000) })) } };
  });
  server.get("/leak", async () => { followed++; return ragData; });
  const url = await server.listen({ host: "127.0.0.1", port: 0 }), source = registry(url).resolve("handbook", alice);
  for (mode of ["redirect", "big", "bad", "timeout"]) {
    await assert.rejects(lightRagClient({ timeoutMs: mode === "timeout" ? 20 : 5000 })(source, query, AbortSignal.timeout(5000)), /DEPENDENCY_UNAVAILABLE/);
  }
  assert.equal(followed, 0);
  mode = "long";
  const value = await lightRagClient()(source, query, AbortSignal.timeout(5000));
  assert.equal(value.truncated, true); assert.equal(value.chunks.length, 5);
  assert.ok(value.chunks.every(c => c.content.isWellFormed())); assert.ok(JSON.stringify(value).length < 20000);
});

test("知识接口：检索前后在线授权，检索中撤销不泄露结果，未知身份不访问上游", async t => {
  let checks = 0, retrievals = 0, denyAfter = true;
  const scope = authorization();
  const app = createKnowledgeApp({ sources: registry("http://127.0.0.1:9621"),
    authorize: async () => { if (++checks > 1 && denyAfter) throw new KnowledgeError(409, "LEASE_LOST"); return scope; },
    retrieve: async () => { retrievals++; return result; } }); t.after(() => app.close());
  const response = await app.inject({ method: "POST", url: "/execution/v1/tools", payload: call });
  assert.equal(response.statusCode, 409); assert.equal(retrievals, 1); assert.equal(checks, 2);
  assert.equal(response.body.includes("chunks"), false);
  denyAfter = false; scope.actor = bob;
  assert.equal((await app.inject({ method: "POST", url: "/execution/v1/tools", payload: call })).statusCode, 403);
  assert.equal(retrievals, 1);
});

test("知识接口：并发门禁有界，失败与完成后释放槽位", async t => {
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(r => { release = r; }), started = new Promise<void>(r => { entered = r; });
  const scope = authorization();
  const app = createKnowledgeApp({ sources: registry("http://127.0.0.1:9621"), maxInFlight: 1,
    authorize: async () => scope, retrieve: async () => { entered(); await gate; return result; } }); t.after(() => app.close());
  const first = app.inject({ method: "POST", url: "/execution/v1/tools", payload: call }).then(r => r);
  await started;
  const rejected = await app.inject({ method: "POST", url: "/execution/v1/tools?other=1", payload: call });
  assert.equal(rejected.statusCode, 503); assert.equal(rejected.headers["retry-after"], "1");
  release(); assert.equal((await first).statusCode, 200);
  assert.equal((await app.inject({ method: "POST", url: "/execution/v1/tools", payload: call })).statusCode, 200);
});

test("知识授权：运行/步骤/来源/节点/取消检查，以及独立令牌不可替代", async t => {
  const { pg, db } = await serviceDatabase("run_control"); t.after(() => pg.close());
  const repository = new RunRepository(db);
  const sessionId = randomUUID(), messageId = randomUUID();
  const run = await repository.accept({ eventId: randomUUID(), eventType: "conversation.message.accepted.v1", producer: "dsh-agent-chat",
    tenantId: alice.tenantId, ownerUid: alice.uid, sessionId, subjectId: messageId, payload: { messageId }, occurredAt: new Date().toISOString(), traceId: "test" });
  const claim = (await repository.claim("worker-a"))!;
  const input = ExecutionInput.parse({ runId: run.id, capturedAt: new Date().toISOString(), definition: { ...agent(), workflow: { steps: [
    { id: "read", instructions: "retrieve", maxTurns: 1, tools: ["knowledge.search"] },
    { id: "answer", instructions: "answer", maxTurns: 1, tools: [] },
  ] } }, context: { sessionId, messageId, binding: { workspaceId: randomUUID(), agentDefinitionId: definition.id, agentDefinitionVersion: 1 },
    truncated: false, messages: [{ id: messageId, sessionId, role: "user", content: "query", createdAt: new Date().toISOString() }] } });
  await repository.input("worker-a", run.id, claim.lease, async () => input);
  const reference = { runId: run.id, workerId: "worker-a", ...claim.lease };
  const request = { ...reference, tool: "knowledge.search", sourceId: "handbook" };
  await assert.rejects(repository.authorizeKnowledge(request), /FORBIDDEN/);
  await repository.reportProgress("worker-a", run.id, { lease: claim.lease, sequence: 1, report: { kind: "workflow", stepId: "read", state: "running" } });
  assert.equal((await repository.authorizeKnowledge(request)).actor.uid, alice.uid);
  for (const overrides of [{ sourceId: "other" }, { workerId: "foreign" }, { leaseId: randomUUID() }]) await assert.rejects(repository.authorizeKnowledge({ ...request, ...overrides }));
  await assert.rejects(repository.workspaceCapability("worker-a", run.id, claim.lease, workspaceCapabilitySigner(secret)), /FORBIDDEN/);
  const verify = knowledgeAuthorizer({ capabilitySecret: capKey, serviceSecret: serviceKey, runControlUrl: "http://127.0.0.1:1" });
  const wrong = await workspaceCapabilitySigner(capKey)(reference, Math.floor(Date.now() / 1000) + 30);
  await assert.rejects(verify("Bearer " + wrong.token, "handbook"), /UNAUTHENTICATED/);
  const expired = await new SignJWT({ scope: "knowledge:execute", reference }).setProtectedHeader({ alg: "HS256" }).setIssuer("dsh-agent-run-control")
    .setAudience("dsh-agent-knowledge-execution").setIssuedAt(Math.floor(Date.now() / 1000) - 60).setExpirationTime(Math.floor(Date.now() / 1000) - 30).sign(new TextEncoder().encode(capKey));
  await assert.rejects(verify("Bearer " + expired, "handbook"), /UNAUTHENTICATED/);
  const cap = await repository.knowledgeCapability("worker-a", run.id, claim.lease, knowledgeCapabilitySigner(capKey));
  await assert.rejects(verify("Bearer " + cap.token, "handbook"), /DEPENDENCY_UNAVAILABLE/);
  await repository.reportUsage("worker-a", run.id, claim.lease, { call: 1, phase: "started" });
  await repository.reportUsage("worker-a", run.id, claim.lease, { call: 1, phase: "finished", tokens: null });
  await repository.reportProgress("worker-a", run.id, { lease: claim.lease, sequence: 2, report: { kind: "workflow", stepId: "read", state: "succeeded", output: "read complete" } });
  await repository.reportProgress("worker-a", run.id, { lease: claim.lease, sequence: 3, report: { kind: "workflow", stepId: "answer", state: "running" } });
  await assert.rejects(repository.authorizeKnowledge(request), /FORBIDDEN/);
  await repository.cancel(alice, run.id);
  await assert.rejects(repository.authorizeKnowledge(request), /LEASE_LOST/);
});

for (const backend of ["lightrag","postgres"] as const) test(`知识端到端：真实 DSH 子进程 → 租约能力 → 知识服务 → ${backend} → 最终回答`, async t => {
  const { pg, db } = await serviceDatabase("run_control"); t.after(() => pg.close());
  const repository = new RunRepository(db), upstream = Fastify(); let upstreamCalls = 0;
  upstream.post("/query/data", async req => { upstreamCalls++; assert.equal(req.headers["x-api-key"], sourceToken); return ragData; });
  const upstreamUrl = await upstream.listen({ host: "127.0.0.1", port: 0 }); t.after(() => upstream.close());
  const sessionId = randomUUID(), messageId = randomUUID();
  const run = await repository.accept({ eventId: randomUUID(), eventType: "conversation.message.accepted.v1", producer: "dsh-agent-chat", tenantId: alice.tenantId, ownerUid: alice.uid,
    sessionId, subjectId: messageId, payload: { messageId }, occurredAt: new Date().toISOString(), traceId: "knowledge-test" });
  const input = ExecutionInput.parse({ runId: run.id, capturedAt: new Date().toISOString(), definition: agent(), context: {
    sessionId, messageId, binding: { workspaceId: randomUUID(), agentDefinitionId: definition.id, agentDefinitionVersion: 1 }, truncated: false,
    messages: [{ id: messageId, sessionId, role: "user", content: query.query, createdAt: new Date().toISOString() }],
  } });
  const auth = authenticators(secret, workerKey);
  const control = createRunControlApp({ repository, authenticateApi: auth.api, authenticateWorker: auth.worker, ready: async () => {}, resolveInput: async () => input,
    authenticateKnowledge: knowledgeServiceVerifier(serviceKey), signKnowledgeCapability: knowledgeCapabilitySigner(capKey) });
  const controlUrl = await control.listen({ host: "127.0.0.1", port: 0 }); t.after(() => control.close());
  const local = backend === "postgres" ? await knowledgeDatabase() : undefined;
  if (local) {
    t.after(() => local.pg.close());
    await publishCorpus(local.db,{ id: "handbook",version: 1,documents: [{ id: "db",title: "项目数据库",content: "平台使用 PostgreSQL 数据库。" }] });
  }
  const sources = local ? sourceRegistry({ sources: [{ id: "handbook",backend: "postgres",corpusId: "handbook",ragMode: "fulltext",readers: [{ tenantId: alice.tenantId,uid: alice.uid }] }] },{}) : registry(upstreamUrl);
  const knowledge = createKnowledgeApp({ sources,database: local?.db, authorize: knowledgeAuthorizer({ capabilitySecret: capKey, serviceSecret: serviceKey, runControlUrl: controlUrl }) });
  const knowledgeUrl = await knowledge.listen({ host: "127.0.0.1", port: 0 }); t.after(() => knowledge.close());
  const unauth = await knowledge.inject({ method: "POST", url: "/execution/v1/tools", payload: call }); assert.equal(unauth.statusCode, 401); assert.equal(upstreamCalls, 0);
  const model = Fastify(); let modelCalls = 0, cited = "";
  model.post("/chat/completions", async (req, reply) => {
    const body = req.body as { tools: Array<{ function: { name: string } }>; messages: unknown[] };
    assert.deepEqual(body.tools.map(t => t.function.name), ["knowledge_search"]);
    modelCalls++;
    const toolCall = modelCalls === 1;
    if (!toolCall) {
      const wire = JSON.stringify(body.messages);
      assert.ok(wire.includes("PostgreSQL")); assert.equal(wire.includes(sourceToken), false); assert.equal(wire.includes("secret.txt"), false);
      cited = wire.match(/handbook:[a-f0-9]{24}/)![0];
    }
    const delta = toolCall ? { role: "assistant", tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "knowledge_search", arguments: JSON.stringify(query) } }] }
      : { role: "assistant", content: `平台使用 PostgreSQL。[${cited}]` };
    const frames = [{ choices: [{ index: 0, delta, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: toolCall ? "tool_calls" : "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }];
    return reply.header("content-type", "text/event-stream").send(frames.map(v => "data: " + JSON.stringify(v) + "\n\n").join("") + "data: [DONE]\n\n");
  });
  const modelUrl = await model.listen({ host: "127.0.0.1", port: 0 }); t.after(() => model.close());
  const client = runtimeClient({ runControlUrl: controlUrl, workspaceUrl: "http://127.0.0.1:1", knowledgeUrl, workerId: "worker-a", secret: workerKey });
  const claim = (await client.claim())!;
  await executeClaim(client, claim, processExecutor({ apiKey: "test-key", baseUrl: modelUrl, maxToolCalls: 3 }), AbortSignal.timeout(20000));
  const finished = await repository.get(alice, run.id);
  assert.equal(finished.state, "succeeded"); assert.ok(finished.output?.includes(cited)); assert.equal(upstreamCalls, backend === "postgres" ? 0 : 1); assert.equal(modelCalls, 2);
  const saved = await db.query("SELECT envelope FROM run_control.outbox WHERE run_id=$1", [run.id]);
  assert.ok(JSON.stringify(saved.rows).includes("knowledge.search"));
});

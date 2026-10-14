import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { SignJWT } from "jose";
import { AgentDefinition, AssistantMessage, ExecutionInput, type Principal } from "@dsh-agent/contracts";
import { ChatRepository } from "../dsh-agent-chat/src/repository.js";
import { createChatApp } from "../dsh-agent-chat/src/app.js";
import { executionVerifier, serviceVerifier as chatVerifier } from "../dsh-agent-chat/src/auth.js";
import { CatalogRepository } from "../dsh-agent-catalog/src/repository.js";
import { createCatalogApp } from "../dsh-agent-catalog/src/app.js";
import { serviceVerifier as catalogVerifier } from "../dsh-agent-catalog/src/auth.js";
import { RunRepository } from "../dsh-agent-run-control/src/repository.js";
import type { Database } from "../dsh-agent-run-control/src/database.js";
import { executionClient } from "../dsh-agent-run-control/src/execution-client.js";
import { createRunControlApp } from "../dsh-agent-run-control/src/app.js";
import { authenticators } from "../dsh-agent-run-control/src/auth.js";
import { runtimeClient } from "../dsh-agent-runtime-dsh/src/client.js";
import { serviceDatabase, definition, serviceSecrets } from "./workspace-catalog-helpers.js";
import { alice, bob, otherTenant, testBinding, secret } from "./helpers.js";
const chatKey = "test-only-run-control-chat-separate-32-bytes";
const catalogKey = "test-only-run-control-catalog-separate-32-bytes";
const workerKey = "test-only-runtime-control-separate-32-bytes";
function command(sessionId: string = randomUUID(), messageId: string = randomUUID()) {
  return { eventId: randomUUID(), eventType: "conversation.message.accepted.v1", producer: "dsh-agent-chat",
    tenantId: alice.tenantId, ownerUid: alice.uid, sessionId, subjectId: messageId, payload: { messageId },
    occurredAt: new Date().toISOString(), traceId: "test" };
}
async function inputFixture(runId: string, sessionId: string, messageId: string): Promise<ExecutionInput> {
  return { runId, capturedAt: new Date().toISOString(), definition: AgentDefinition.parse(definition), context: {
    sessionId, messageId, binding: await testBinding(), truncated: false,
    messages: [{ id: messageId, sessionId, role: "user", content: "input", createdAt: new Date().toISOString() }],
  } };
}
async function token(issuer: string, audience: string, key: string, actor: Principal = alice) {
  return new SignJWT({ actor }).setProtectedHeader({ alg: "HS256" }).setIssuer(issuer).setAudience(audience)
    .setSubject("worker-a").setIssuedAt().setExpirationTime("30s").sign(new TextEncoder().encode(key));
}

test("执行上下文：完整问答对、未来消息排除、投影幂等及主体隔离", async t => {
  const { pg, db } = await serviceDatabase("chat"); t.after(() => pg.close());
  const chat = new ChatRepository(db, testBinding);
  const session = await chat.create(alice, "conversation", "session-key-001", "test");
  const first = await chat.send(alice, session.id, "question one", "message-key-001", "test");
  const second = await chat.send(alice, session.id, "question two", "message-key-002", "test");
  const later = await chat.send(alice, session.id, "future question", "message-key-003", "test");
  const result = { runId: randomUUID(), messageId: first.id, output: "answer one" };
  const before = (await db.query("SELECT * FROM chat.conversation_outbox")).rows.length;
  const answer = AssistantMessage.parse(await chat.appendAssistant(alice, session.id, result));
  assert.deepEqual(await chat.appendAssistant(alice, session.id, result), answer);
  await assert.rejects(chat.appendAssistant(alice, session.id, { ...result, output: "changed" }), /IDEMPOTENCY_CONFLICT/);
  await assert.rejects(chat.appendAssistant(alice, session.id, { ...result, runId: randomUUID() }), /IDEMPOTENCY_CONFLICT/);
  assert.equal((await db.query("SELECT * FROM chat.conversation_outbox")).rows.length, before);
  const context = await chat.executionContext(alice, session.id, second.id);
  assert.deepEqual(context.messages.map(m => m.content), ["question one", "answer one", "question two"]);
  assert.equal(context.truncated, false);
  const page = await chat.history(alice, session.id, 3);
  assert.equal(page.nextCursor, later.id);
  assert.deepEqual((await chat.history(alice, session.id, 3, page.nextCursor!)).items, [answer]);
  assert.equal((await chat.send(alice, session.id, "question one", "message-key-001", "test")).id, first.id);
  for (const actor of [bob, otherTenant]) {
    await assert.rejects(chat.executionContext(actor, session.id, first.id), /NOT_FOUND/);
    await assert.rejects(chat.appendAssistant(actor, session.id, result), /NOT_FOUND/);
  }
  const foreign = await chat.create(bob, "foreign", "session-key-002", "test");
  await assert.rejects(chat.executionContext(alice, session.id, foreign.id), /NOT_FOUND/);
  await assert.rejects(chat.executionContext(alice, session.id, answer.id), /NOT_FOUND/);
  await assert.rejects(chat.appendAssistant(alice, session.id, { ...result, messageId: answer.id }), /NOT_FOUND/);
  await db.query("UPDATE chat.conversations SET workspace_id=NULL WHERE id=$1", [session.id]);
  await assert.rejects(chat.executionContext(alice, session.id, first.id), /INVALID_STATE/);
});

test("执行历史：超过二十轮和 64000 字符仍完整导出，跨读取批次不丢记录", async t => {
  const { pg, db } = await serviceDatabase("chat"); t.after(() => pg.close());
  const chat = new ChatRepository(db, testBinding, { messagesPerMinute: 1000,pendingPerUser: 1000,pendingPerSession: 1000 });
  const session = await chat.create(alice, "bounded", "session-key-001", "test");
  const first = await chat.send(alice, session.id, "a".repeat(32_000), "message-key-001", "test");
  await chat.appendAssistant(alice, session.id, { runId: randomUUID(), messageId: first.id, output: "b".repeat(32_000) });
  const second = await chat.send(alice, session.id, "c".repeat(32_000), "message-key-002", "test");
  const context = await chat.executionContext(alice, session.id, second.id);
  assert.equal(context.truncated, false);
  assert.equal(context.messages.reduce((sum,m) => sum + m.content.length,0), 96_000);
  assert.deepEqual(context.messages.filter(m => m.role === "user").map(m => m.id), [first.id,second.id]);
  let last = second;
  for (let i = 0; i < 121; i++) {
    last = await chat.send(alice, session.id, "small", "small-key-" + i, "test");
  }
  const bounded = await chat.executionContext(alice, session.id, last.id);
  assert.equal(bounded.messages.length, 124); assert.equal(bounded.truncated, false);
  assert.equal(bounded.messages[0]!.id, first.id); assert.equal(bounded.messages.at(-1)!.id,last.id);
});

test("运行输入：快照冻结、重复获取不重查，失效租约和跨资源响应拒绝", async t => {
  const { pg, db } = await serviceDatabase("run_control"); t.after(() => pg.close());
  // 此夹具有意保留多个取消/失效租约以验证权限；并发上限另由 concurrency.test 覆盖。
  const runs = new RunRepository(db,undefined,{userActive:8,tenantActive:32,agingSeconds:60});
  const run = await runs.accept(command()); const claim = (await runs.claim("worker-a"))!;
  const fixture = await inputFixture(run.id, run.sessionId, run.messageId);
  let calls = 0;
  const resolve = async (actor: Principal) => { assert.equal(actor.uid, alice.uid); calls++; return fixture; };
  await assert.rejects(runs.input("worker-b", run.id, claim.lease, resolve), /LEASE_LOST/);
  assert.equal(calls, 0);
  await assert.rejects(runs.input("worker-a", run.id, claim.lease, async () => ({ ...fixture, runId: randomUUID() })), /DEPENDENCY_UNAVAILABLE/);
  await assert.rejects(runs.input("worker-a", run.id, claim.lease, async () => ({ ...fixture, definition: { ...fixture.definition, version: 2 } })), /DEPENDENCY_UNAVAILABLE/);
  const stored = await runs.input("worker-a", run.id, claim.lease, resolve);
  assert.equal(calls, 1);
  fixture.definition.systemPrompt = "changed upstream";
  assert.deepEqual(await new RunRepository(db).input("worker-a", run.id, claim.lease, resolve), stored);
  assert.equal(calls, 1);
  await runs.cancel(alice, run.id);
  await assert.rejects(runs.input("worker-a", run.id, claim.lease, resolve), /LEASE_LOST/);
  const next = await runs.accept(command()); const second = (await runs.claim("worker-a"))!;
  assert.equal(second.run.id, next.id);
  await assert.rejects(runs.input("worker-a", next.id, second.lease, async () => {
    await runs.cancel(alice, next.id);
    return inputFixture(next.id, next.sessionId, next.messageId);
  }), /LEASE_LOST/);
  assert.equal((await db.query("SELECT execution_input FROM run_control.runs WHERE id=$1", [next.id])).rows[0]!.execution_input, null);
  const expired = await runs.accept(command()); const third = (await runs.claim("worker-a"))!;
  await assert.rejects(runs.input("worker-a", expired.id, third.lease, async () => {
    await db.query("UPDATE run_control.runs SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [expired.id]);
    return inputFixture(expired.id, expired.sessionId, expired.messageId);
  }), /LEASE_LOST/);
});

test("历史传输保护：超限显式拒绝，不能删除或静默裁剪聊天记录", async t => {
  const { pg,db } = await serviceDatabase("chat"); t.after(() => pg.close());
  const chat = new ChatRepository(db,testBinding,{ messagesPerMinute: 1000,pendingPerUser: 1000,pendingPerSession: 1000 });
  const session = await chat.create(alice,"transport limit","context-session","test");
  let last;
  for (let i = 0; i < 140; i++) {
    last = await chat.send(alice,session.id,"x".repeat(32_000),"history-"+i,"test");
    await chat.appendAssistant(alice,session.id,{ runId: randomUUID(),messageId: last.id,output: "y".repeat(32_000) });
  }
  await assert.rejects(chat.executionContext(alice,session.id,last!.id),error =>
    error instanceof Error && "status" in error && error.status === 413);
  assert.equal(Number((await db.query("SELECT count(*) AS count FROM chat.conversation_messages WHERE session_id=$1",[session.id])).rows[0]!.count),280);
});

test("回答投影：跨库提交后确认丢失重传、会话屏障、退避且不阻塞其他会话", async t => {
  const chatDb = await serviceDatabase("chat"), runDb = await serviceDatabase("run_control");
  t.after(async () => { await chatDb.pg.close(); await runDb.pg.close(); });
  const chat = new ChatRepository(chatDb.db, testBinding), runs = new RunRepository(runDb.db);
  const session = await chat.create(alice, "projection", "session-key-001", "test");
  const question = await chat.send(alice, session.id, "question", "message-key-001", "test");
  const run = await runs.accept(command(session.id, question.id));
  const next = await runs.accept(command(session.id));
  const claim = (await runs.claim("worker-a"))!;
  const completed = { ...claim.lease, state: "succeeded", output: "durable answer" };
  await runs.publishBatch(async (_subject, event) => { assert.equal(event.eventType, "run.status.v1"); });
  await runs.publishBatch(async (_subject, event) => { assert.equal(event.eventType, "run.status.v1"); });
  await assert.rejects(runs.finish("worker-a", run.id, { ...completed, output: "bad\0text" }), /INVALID_REQUEST/);
  const brokenTicket: Database = { query: runDb.db.query, transaction: work => runDb.db.transaction(tx => work({ query: (sql, values) => {
    if (sql.startsWith("INSERT INTO run_control.result_projections")) throw new Error("ticket failed");
    return tx.query(sql, values);
  } })) };
  await assert.rejects(new RunRepository(brokenTicket).finish("worker-a", run.id, completed), /ticket failed/);
  assert.equal((await runs.get(alice, run.id)).state, "running");
  assert.equal((await runDb.db.query("SELECT * FROM run_control.outbox WHERE envelope->>'eventType'<>'run.status.v1'")).rows.length, 0);
  await runs.finish("worker-a", run.id, completed);
  const deliver = async (actor: Principal, id: string, value: unknown) => { await chat.appendAssistant(actor, id, value); };
  const broken: Database = { query: runDb.db.query, transaction: work => runDb.db.transaction(tx => work({ query: (sql, values) => {
    if (sql.startsWith("UPDATE run_control.result_projections SET attempts=attempts+1,projected_at")) throw new Error("local commit lost");
    return tx.query(sql, values);
  } })) };
  await assert.rejects(new RunRepository(broken).projectBatch(deliver), /local commit lost/);
  assert.equal((await chat.history(alice, session.id, 20)).items.filter(m => m.role === "assistant").length, 1);
  assert.equal(await runs.claim("worker-b"), null);
  assert.equal(await runs.publishBatch(async () => { throw new Error("must not publish"); }), 0);
  assert.equal(await runs.projectBatch(async () => { throw new Error("Chat offline"); }), "retry");
  assert.equal(await runs.projectBatch(deliver), "idle");
  const other = await runs.accept(command());
  assert.equal((await runs.claim("worker-c"))!.run.id, other.id);
  await runDb.db.query("UPDATE run_control.result_projections SET next_attempt_at=clock_timestamp()-interval '1 second'");
  assert.equal(await new RunRepository(runDb.db).projectBatch(deliver), "projected");
  assert.equal((await chat.history(alice, session.id, 20)).items.filter(m => m.role === "assistant").length, 1);
  await runs.finish("worker-a", run.id, completed);
  assert.equal((await runDb.db.query("SELECT * FROM run_control.result_projections")).rows.length, 1);
  assert.equal((await runs.claim("worker-d"))!.run.id, next.id);
  assert.ok(await runs.publishBatch(async () => {}) > 0);
});

test("执行 HTTP：独立凭据、精确版本授权、有效租约快照与助手历史完整链路", async t => {
  const chatDb = await serviceDatabase("chat", "catalog"), runDb = await serviceDatabase("run_control");
  t.after(async () => { await chatDb.pg.close(); await runDb.pg.close(); });
  const chat = new ChatRepository(chatDb.db, testBinding), runs = new RunRepository(runDb.db);
  const catalog = new CatalogRepository(chatDb.db);
  await catalog.publish(definition, alice.tenantId, true);
  const chatApp = createChatApp({ repository: chat, authenticate: chatVerifier(secret), authenticateExecution: executionVerifier(chatKey),
    ready: async () => {}, signCapability: async () => ({}) });
  const catalogApp = createCatalogApp({ repository: catalog, authenticate: catalogVerifier({ api: serviceSecrets.apiCatalog, chat: serviceSecrets.chatCatalog, runControl: catalogKey }), ready: async () => {} });
  const chatUrl = await chatApp.listen({ host: "127.0.0.1", port: 0 });
  const catalogUrl = await catalogApp.listen({ host: "127.0.0.1", port: 0 });
  const client = executionClient({ chatUrl, catalogUrl, chatSecret: chatKey, catalogSecret: catalogKey });
  const auth = authenticators(secret, workerKey);
  const app = createRunControlApp({ repository: runs, authenticateApi: auth.api, authenticateWorker: auth.worker, resolveInput: client.resolve, ready: async () => {} });
  t.after(async () => { await app.close(); await chatApp.close(); await catalogApp.close(); });
  const session = await chat.create(alice, "http", "session-key-001", "test");
  const question = await chat.send(alice, session.id, "message one", "message-key-001", "test");
  const run = await runs.accept(command(session.id, question.id));
  const headers = { authorization: "Bearer " + await token("dsh-agent-runtime-dsh", "dsh-agent-run-control", workerKey) };
  const claim = (await app.inject({ method: "POST", url: "/worker/v1/claim", headers })).json().claim;
  const url = `/worker/v1/runs/${run.id}/input`;
  const response = await app.inject({ method: "POST", url, headers, payload: claim.lease });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(ExecutionInput.parse(response.json()).context.messages[0]!.content, "message one");
  assert.equal(response.headers["cache-control"], "no-store");
  assert.equal((await app.inject({ method: "POST", url, headers, payload: { ...claim.lease, uid: bob.uid } })).statusCode, 400);
  const apiHeader = { authorization: "Bearer " + await token("dsh-agent-api", "dsh-agent-chat", secret) };
  const executionHeader = { authorization: "Bearer " + await token("dsh-agent-run-control", "dsh-agent-chat", chatKey) };
  const contextPath = `/execution/v1/sessions/${session.id}/messages/${question.id}/context`;
  assert.equal((await chatApp.inject({ url: contextPath, headers: apiHeader })).statusCode, 401);
  assert.equal((await chatApp.inject({ url: "/internal/v1/sessions", headers: executionHeader })).statusCode, 401);
  assert.equal((await chatApp.inject({ url: contextPath, headers })).statusCode, 401);
  assert.equal((await chatApp.inject({ url: contextPath, headers: { authorization: "Bearer " + await token("dsh-agent-run-control", "dsh-agent-chat", chatKey, bob) } })).statusCode, 404);
  const output = "\u0001".repeat(32_000); // JSON 转义后超过 128 KiB，仍属于合法回答上限。
  await runs.finish("worker-a", run.id, { ...claim.lease, state: "succeeded", output });
  assert.equal(await runs.projectBatch(client.project), "projected");
  assert.equal((await chat.history(alice, session.id, 20)).items.at(-1)!.content, output);
  const second = await chat.send(alice, session.id, "message two", "message-key-002", "test");
  const next = await runs.accept(command(session.id, second.id)); const nextClaim = (await runs.claim("worker-a"))!;
  const nextInput = await runs.input("worker-a", next.id, nextClaim.lease, client.resolve);
  assert.equal(nextInput.context.messages[1]!.role, "assistant");
  assert.equal(nextInput.definition.version, 1);
  // Exercise both authenticated HTTP clients above the former 1 MiB response ceiling.
  const largeSession = await chat.create(alice,"large history","large-session-key","test");
  for (let i = 0; i < 20; i++) {
    const message = await chat.send(alice,largeSession.id,"u".repeat(32_000),"large-history-"+i,"test");
    await chat.appendAssistant(alice,largeSession.id,{ runId: randomUUID(),messageId: message.id,output: "a".repeat(32_000) });
  }
  const current = await chat.send(alice,largeSession.id,"latest task","large-current-key","test");
  const largeRun = await runs.accept(command(largeSession.id,current.id));
  const controlUrl = await app.listen({ host: "127.0.0.1",port: 0 });
  const runtime = runtimeClient({ runControlUrl: controlUrl,workspaceUrl: controlUrl,workerId: "large-worker",secret: workerKey });
  const largeClaim = (await runtime.claim())!;
  assert.equal(largeClaim.run.id,largeRun.id);
  const complete = await runtime.input(largeClaim,AbortSignal.timeout(10_000));
  assert.equal(complete.context.messages.length,41);
  assert.ok(Buffer.byteLength(JSON.stringify(complete)) > 1024 * 1024);
  assert.equal(complete.context.truncated,false);
  assert.equal(complete.context.messages.at(-1)!.id,current.id);
  await runs.cancel(alice,largeRun.id); await runtime.release(largeClaim);
  await chatDb.db.query("DELETE FROM catalog.tenant_definitions WHERE tenant_id=$1", [alice.tenantId]);
  assert.deepEqual(await runs.input("worker-a", next.id, nextClaim.lease, client.resolve), nextInput);
  const third = await chat.send(alice, session.id, "message three", "message-key-003", "test");
  await runs.cancel(alice, next.id); await runs.release("worker-a", next.id, nextClaim.lease);
  const ungranted = await runs.accept(command(session.id, third.id)); const thirdClaim = (await runs.claim("worker-a"))!;
  await assert.rejects(runs.input("worker-a", ungranted.id, thirdClaim.lease, client.resolve), /NOT_FOUND/);
});

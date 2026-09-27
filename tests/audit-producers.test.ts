import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import { SignJWT } from "jose";
import { ChatAuditRecord, WorkspaceAuditRecord } from "@dsh-agent/contracts";
import { ChatRepository } from "../dsh-agent-chat/src/repository.js";
import { WorkspaceRepository } from "../dsh-agent-workspace/src/repository.js";
import { AuditRepository } from "../dsh-agent-audit/src/repository.js";
import { createAuditApp } from "../dsh-agent-audit/src/app.js";
import { authenticators } from "../dsh-agent-audit/src/auth.js";
import { auditClient as chatClient } from "../dsh-agent-chat/src/audit.js";
import { auditClient as workspaceClient } from "../dsh-agent-workspace/src/audit.js";
import { serviceDatabase, MemoryBlobs } from "./workspace-catalog-helpers.js";
import { alice, bob, otherTenant, testBinding } from "./helpers.js";
const apiKey = "test-only-audit-api-key-thirty-two-bytes";
const runKey = "test-only-audit-run-key-thirty-two-bytes";
const chatKey = "test-only-audit-chat-key-thirty-two-bytes";
const workspaceKey = "test-only-audit-workspace-key-thirty-two-bytes";
const record = () => ChatAuditRecord.parse({ eventId: randomUUID(), occurredAt: new Date().toISOString(), producer: "dsh-agent-chat", tenantId: alice.tenantId, ownerUid: alice.uid,
  sessionId: randomUUID(), subjectId: randomUUID(), action: "message.accepted" });
test("审计生产者 HTTP：独立凭据绑定生产者，会话/文件变更可靠投递且不含正文", async t => {
  const chatDb = await serviceDatabase("chat"), workspaceDb = await serviceDatabase("workspace"), auditDb = await serviceDatabase("audit");
  t.after(async () => { await chatDb.pg.close(); await workspaceDb.pg.close(); await auditDb.pg.close(); });
  const audit = new AuditRepository(auditDb.db), auth = authenticators(apiKey, runKey, { chat: chatKey, workspace: workspaceKey });
  const app = createAuditApp({ repository: audit, authenticateApi: auth.api, authenticateControl: auth.control, authenticateProducer: auth.producer, ready: async () => {} });
  const url = await app.listen({ host: "127.0.0.1", port: 0 }); t.after(() => app.close());
  const chat = new ChatRepository(chatDb.db, testBinding), workspace = new WorkspaceRepository(workspaceDb.db, new MemoryBlobs());
  const session = await chat.create(alice, "private title", "audit-session-key", "private trace");
  await chat.create(alice, "private title", "audit-session-key", "different trace");
  const message = await chat.send(alice, session.id, "private prompt", "audit-message-key", "private trace");
  await chat.send(alice, session.id, "private prompt", "audit-message-key", "private trace");
  const result = { runId: randomUUID(), messageId: message.id, output: "private answer" };
  await chat.appendAssistant(alice, session.id, result); await chat.appendAssistant(alice, session.id, result);
  await chat.update(alice, session.id, { expectedRevision: 1, title: "new private title", archived: true });
  const owned = await workspace.ensure(alice); await workspace.ensure(alice);
  const first = await workspace.write(alice, owned.id, { path: "private-name.txt", content: "private file", expectedVersion: null });
  const second = await workspace.write(alice, owned.id, { path: "private-name.txt", content: "new private file", expectedVersion: first.version });
  await workspace.delete(alice, owned.id, "private-name.txt", second.version);
  while (await chat.publishAuditBatch(chatClient(url, chatKey)) !== "idle") {}
  while (await workspace.publishAuditBatch(workspaceClient(url, workspaceKey)) !== "idle") {}
  const page = await audit.list(alice, { limit: 100 }); assert.equal(page.items.length, 8);
  assert.doesNotMatch(JSON.stringify(page), /private|content|path|trace|token/);
  const writes = page.items.filter(v => v.producer === "dsh-agent-workspace" && v.action === "file.written");
  assert.equal(writes.length, 2); assert.ok(writes.some(v => v.producer === "dsh-agent-workspace" && v.previousVersion === first.version && v.version === second.version));
  assert.equal((await audit.list(bob, { limit: 100 })).items.length, 0);
  assert.equal((await audit.list(otherTenant, { limit: 100 })).items.length, 0);
  const token = await new SignJWT({}).setProtectedHeader({ alg: "HS256" }).setIssuer("dsh-agent-chat").setAudience("dsh-agent-audit").setIssuedAt().setExpirationTime("30s").sign(new TextEncoder().encode(chatKey));
  const foreign = WorkspaceAuditRecord.parse({ eventId: randomUUID(), occurredAt: new Date().toISOString(), producer: "dsh-agent-workspace", tenantId: alice.tenantId, ownerUid: alice.uid, workspaceId: owned.id, action: "workspace.created" });
  const forged = await app.inject({ method: "POST", url: "/control/v1/records", headers: { authorization: "Bearer " + token }, payload: foreign });
  assert.equal(forged.statusCode, 403);
  assert.equal((await app.inject({ method: "POST", url: "/control/v1/records", headers: { authorization: "Bearer " + token }, payload: { ...record(), content: "secret" } })).statusCode, 400);
  assert.equal((await app.inject({ url: "/internal/v1/audit", headers: { authorization: "Bearer " + token } })).statusCode, 401);
  await assert.rejects(chatClient(url, workspaceKey)(record()), /rejected/);
});
test("审计原子性：会话审计写入失败回滚消息/修改，文件审计失败不提交可见版本", async t => {
  const chatDb = await serviceDatabase("chat"), workspaceDb = await serviceDatabase("workspace");
  t.after(async () => { await chatDb.pg.close(); await workspaceDb.pg.close(); });
  const chat = new ChatRepository(chatDb.db, testBinding), blobs = new MemoryBlobs(), workspace = new WorkspaceRepository(workspaceDb.db, blobs);
  const s = await chat.create(alice, "title", "atomic-session-key", "test"), w = await workspace.ensure(alice);
  const original = await workspace.write(alice, w.id, { path: "notes.txt", content: "old", expectedVersion: null });
  const injectFailure = (database: typeof chatDb.db, schema: string) => {
    const transaction = database.transaction.bind(database);
    database.transaction = work => transaction(tx => work({ query: async (sql, values) => {
      if (sql.startsWith("INSERT INTO " + schema + ".audit_outbox")) throw new Error("audit local write failed");
      return tx.query(sql, values);
    } }));
  };
  injectFailure(chatDb.db, "chat"); injectFailure(workspaceDb.db, "workspace");
  await assert.rejects(chat.send(alice, s.id, "not saved", "atomic-message-key", "test"), /audit local/);
  await assert.rejects(chat.update(alice, s.id, { expectedRevision: 1, archived: true }), /audit local/);
  assert.equal((await chat.history(alice, s.id, 10)).items.length, 0); assert.equal((await chat.get(alice, s.id)).revision, 1);
  await assert.rejects(chat.create(alice, "not saved", "atomic-session-new", "test"), /audit local/);
  assert.equal((await chat.list(alice, 10)).items.length, 1);
  await assert.rejects(workspace.write(alice, w.id, { path: "notes.txt", content: "new", expectedVersion: original.version }), /audit local/);
  assert.equal((await workspace.read(alice, w.id, "notes.txt")).version, original.version);
  assert.equal((await workspace.read(alice, w.id, "notes.txt")).content, "old");
  await assert.rejects(workspace.delete(alice, w.id, "notes.txt", original.version), /audit local/);
  await assert.rejects(workspace.ensure(bob), /audit local/);
  assert.equal((await workspaceDb.db.query("SELECT * FROM workspace.workspaces")).rows.length, 1);
  assert.equal((await workspaceDb.db.query("SELECT * FROM workspace.audit_outbox")).rows.length, 2);
  assert.equal(blobs.puts, 2); // 上传已发生，但暂存对象没有成为可见文件，仍可由回收器处理。
  await workspaceDb.db.query("UPDATE workspace.blobs SET created_at=clock_timestamp()-interval '2 hours' WHERE state='staged'");
  assert.equal(await workspace.collectOne(), true); assert.equal(blobs.objects.size, 1);
});
test("审计投递：确认丢失后重传去重，退避积压可观测，网络故障不阻塞新业务", async t => {
  const chatDb = await serviceDatabase("chat"), auditDb = await serviceDatabase("audit");
  t.after(async () => { await chatDb.pg.close(); await auditDb.pg.close(); });
  const chat = new ChatRepository(chatDb.db, testBinding), audit = new AuditRepository(auditDb.db);
  const s = await chat.create(alice, "title", "delivery-session-key", "test");
  assert.equal(await chat.publishAuditBatch(async record => { await audit.append(record); throw new Error("ack lost"); }), "retry");
  assert.equal(await chat.publishAuditBatch(async () => { throw new Error("must back off"); }), "idle");
  assert.equal((await chat.metrics()).audit_max_attempts, 1);
  await chat.send(alice, s.id, "still accepted", "delivery-message-key", "test");
  await chatDb.db.query("UPDATE chat.audit_outbox SET next_attempt_at=clock_timestamp(),created_at=clock_timestamp()-interval '5 minutes'");
  assert.ok((await chat.metrics()).audit_oldest_age_seconds! >= 300);
  while (await chat.publishAuditBatch(record => audit.append(record).then(() => undefined)) !== "idle") {}
  assert.equal((await audit.list(alice, { limit: 10 })).items.length, 2);
  assert.equal((await chat.metrics()).audit_pending, 0); assert.equal((await chat.metrics()).audit_oldest_age_seconds, 0);
});
test("审计客户端：响应大小限制、不跟随重定向、严格确认与独立生产者模式", async t => {
  const app = Fastify(); let mode = "ok", redirects = 0;
  app.post("/control/v1/records", async (_req, reply) => {
    if (mode === "redirect") return reply.redirect("/capture");
    if (mode === "large") return reply.type("application/json").send(" ".repeat(4097));
    if (mode === "extra") return { recorded: true, secret: "not allowed" };
    return { recorded: true };
  });
  app.post("/capture", async () => { redirects++; return { recorded: true }; });
  const url = await app.listen({ host: "127.0.0.1", port: 0 }); t.after(() => app.close());
  const send = chatClient(url, chatKey);
  await send(record());
  for (mode of ["redirect", "large", "extra"]) await assert.rejects(send(record()));
  assert.equal(redirects, 0);
  assert.throws(() => chatClient(url + "/path", chatKey));
  assert.throws(() => workspaceClient(url, "short"));
});

import test from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import { ChatRepository, ChatError } from "../dsh-agent-chat/src/repository.js";
import type { Database } from "../dsh-agent-chat/src/database.js";
import { database, alice, bob, otherTenant, testBinding } from "./helpers.js";

test("PostgreSQL: 专属角色可迁移自身模式，不能读取身份服务数据", async t => {
  const pg = new PGlite(); t.after(() => pg.close());
  await pg.exec("CREATE ROLE chat; CREATE ROLE iam; CREATE SCHEMA chat AUTHORIZATION chat; " +
    "CREATE SCHEMA iam AUTHORIZATION iam; SET ROLE iam; CREATE TABLE iam.users (id uuid); RESET ROLE; SET ROLE chat;");
  await pg.exec(await readFile(new URL("../dsh-agent-chat/migrations/001_initial.sql", import.meta.url), "utf8"));
  const legacySession = "01960000-0000-7000-8000-000000000001";
  const legacyOne = "01960000-0000-7000-8000-000000000002", legacyTwo = "01960000-0000-7000-8000-000000000003";
  await pg.query("INSERT INTO chat.conversations(id,tenant_id,owner_uid,title,agent_definition_id,agent_definition_version,idempotency_key,request_hash) " +
    "VALUES($1,'tenant-a','alice','legacy','document-agent',1,'legacy-session','hash')", [legacySession]);
  // 故意先写较大标识，验证升级保留旧接口的 UUID 顺序而不是物理插入顺序。
  for (const id of [legacyTwo, legacyOne]) await pg.query("INSERT INTO chat.conversation_messages(id,session_id,tenant_id,owner_uid,role,content,idempotency_key,request_hash) " +
    "VALUES($1,$2,'tenant-a','alice','user','preserved',$3,'hash')", [id, legacySession, id]);
  await pg.exec(await readFile(new URL("../dsh-agent-chat/migrations/002_execution.sql", import.meta.url), "utf8"));
  assert.equal((await pg.query("SELECT version FROM chat.schema_migrations")).rows.length, 2);
  assert.deepEqual((await pg.query<{ id: string }>("SELECT id FROM chat.conversation_messages ORDER BY position")).rows.map(row => row.id), [legacyOne, legacyTwo]);
  const inserted = await pg.query<{ position: number }>("INSERT INTO chat.conversation_messages(id,session_id,tenant_id,owner_uid,role,content,idempotency_key,request_hash) " +
    "VALUES('01960000-0000-7000-8000-000000000004',$1,'tenant-a','alice','user','new','new-message','hash') RETURNING position", [legacySession]);
  assert.equal(Number(inserted.rows[0]!.position), 3);
  assert.equal((await pg.query<{ count: number }>("SELECT count(*)::integer AS count FROM chat.conversation_messages WHERE content='preserved'")).rows[0]!.count, 2);
  await assert.rejects(pg.query("SELECT * FROM iam.users"), /permission denied/);
});

test("PostgreSQL: 所有权、分页、并发重试及幂等冲突", async t => {
  const { pg, db } = await database(); t.after(() => pg.close());
  const repo = new ChatRepository(db, testBinding);
  const session = await repo.create(alice, "私人会话", "create-key-001", "trace");
  const duplicate = await repo.create(alice, "私人会话", "create-key-001", "trace");
  assert.equal(session.id, duplicate.id);
  await assert.rejects(repo.create(alice, "改动标题", "create-key-001", "trace"),
    e => e instanceof ChatError && e.status === 409);
  for (const foreign of [bob, otherTenant]) {
    assert.deepEqual((await repo.list(foreign, 20)).items, []);
    await assert.rejects(repo.get(foreign, session.id), e => e instanceof ChatError && e.status === 404);
    await assert.rejects(repo.history(foreign, session.id, 20), /NOT_FOUND/);
    await assert.rejects(repo.send(foreign, session.id, "越权消息", "message-001", "trace"), /NOT_FOUND/);
  }
  const repeated = await Promise.all(Array.from({ length: 5 }, () =>
    repo.send(alice, session.id, "你好", "message-001", "trace")));
  assert.equal(new Set(repeated.map(m => m.id)).size, 1);
  await assert.rejects(repo.send(alice, session.id, "内容不同", "message-001", "trace"), /IDEMPOTENCY_CONFLICT/);
  await repo.send(alice, session.id, "第二条", "message-002", "trace");
  const first = await repo.history(alice, session.id, 1);
  const second = await repo.history(alice, session.id, 1, first.nextCursor!);
  assert.equal(first.items[0]!.content, "你好");
  assert.equal(second.items[0]!.content, "第二条");
  assert.equal(second.nextCursor, null);
  const events = await db.query("SELECT * FROM chat.conversation_outbox");
  assert.equal(events.rows.length, 5, "两个用户消息各有公开事件与独立运行请求");
});

test("PostgreSQL: Outbox 写入失败时用户消息一同回滚", async t => {
  const { pg, db } = await database(); t.after(() => pg.close());
  const repo = new ChatRepository(db, testBinding);
  const session = await repo.create(alice, "测试回滚", "create-key-001", "trace");
  const broken: Database = { query: db.query, transaction: work => db.transaction(tx => work({
    query: (sql, values) => {
      if (sql.startsWith("INSERT INTO chat.conversation_outbox")) throw new Error("injected outbox failure");
      return tx.query(sql, values);
    },
  })) };
  await assert.rejects(new ChatRepository(broken, testBinding)
    .send(alice, session.id, "不能丢事件", "message-001", "trace"), /injected/);
  assert.equal((await repo.history(alice, session.id, 20)).items.length, 0);
  assert.equal((await db.query("SELECT * FROM chat.conversation_outbox")).rows.length, 1);
});

test("PostgreSQL: 消息代理失败后保留 Outbox，恢复后顺序重发", async t => {
  const { pg, db } = await database(); t.after(() => pg.close());
  const repo = new ChatRepository(db, testBinding);
  const session = await repo.create(alice, "事件", "create-key-001", "trace");
  await repo.send(alice, session.id, "消息", "message-001", "trace");
  await assert.rejects(repo.publishBatch(async () => { throw new Error("broker offline"); }), /offline/);
  const pending = await db.query("SELECT * FROM chat.conversation_outbox WHERE published_at IS NULL");
  assert.equal(pending.rows.length, 3);
  const sent: string[] = [];
  assert.equal(await repo.publishBatch(async (subject, event) => { sent.push(subject.startsWith("agent.commands.") ? "run.request" : event.eventType); }), 3);
  assert.deepEqual(sent, ["conversation.created.v1", "conversation.message.accepted.v1", "run.request"]);
  assert.equal(await repo.publishBatch(async () => { throw new Error("must not republish"); }), 0);
});

test("Chat: 运行请求写入失败时，用户消息与公开事件一起回滚", async t => {
  const { pg, db } = await database(); t.after(() => pg.close());
  const repo = new ChatRepository(db, testBinding);
  const session = await repo.create(alice, "request atomicity", "create-key-001", "trace");
  const broken: Database = { query: db.query, transaction: work => db.transaction(tx => work({
    query: (sql, values) => {
      if (sql.startsWith("INSERT INTO chat.conversation_outbox") && values?.[2] === "agent.commands.run.requested.v1") {
        throw new Error("request write failed");
      }
      return tx.query(sql, values);
    },
  })) };
  await assert.rejects(new ChatRepository(broken, testBinding).send(alice, session.id, "must enqueue", "message-001", "trace"), /request write failed/);
  assert.equal((await repo.history(alice, session.id, 20)).items.length, 0);
  assert.equal((await db.query("SELECT * FROM chat.conversation_outbox")).rows.length, 1);
});

import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { RunRepository } from "../dsh-agent-run-control/src/repository.js";
import type { Database } from "../dsh-agent-run-control/src/database.js";
import { processRequest, requestSubject } from "../dsh-agent-run-control/src/consumer.js";
import { serviceDatabase } from "./workspace-catalog-helpers.js";
import { alice, bob, otherTenant } from "./helpers.js";
function request(sessionId = randomUUID(), actor = alice) {
  const messageId = randomUUID();
  return { eventId: randomUUID(), eventType: "conversation.message.accepted.v1", producer: "dsh-agent-chat",
    tenantId: actor.tenantId, ownerUid: actor.uid, sessionId, subjectId: messageId, occurredAt: new Date().toISOString(),
    traceId: randomUUID(), payload: { messageId } };
}
test("调度：优先当前负载较低的租户和用户，保留同会话顺序", async t => {
  const { pg, db } = await serviceDatabase("run_control"); t.after(() => pg.close());
  const repo = new RunRepository(db);
  const first = await repo.accept(request()); await repo.accept(request());
  const b = await repo.accept(request(randomUUID(), bob));
  const c = await repo.accept(request(randomUUID(), otherTenant));
  assert.equal((await repo.claim("worker-1"))!.run.id, first.id);
  assert.equal((await repo.claim("worker-2"))!.run.id, c.id);
  assert.equal((await repo.claim("worker-3"))!.run.id, b.id);
});

test("Run Control: 请求去重、身份一致性、所有权与分页", async t => {
  const { pg, db } = await serviceDatabase("run_control"); t.after(() => pg.close());
  const repo = new RunRepository(db), input = request();
  const runs = await Promise.all(Array.from({ length: 4 }, () => repo.accept(input)));
  assert.equal(new Set(runs.map(r => r.id)).size, 1);
  const run = runs[0]!;
  assert.equal((await repo.accept({ ...input, eventId: randomUUID() })).id, run.id);
  await assert.rejects(repo.accept({ ...input, eventId: randomUUID(), ownerUid: bob.uid }), /IDEMPOTENCY_CONFLICT/);
  await assert.rejects(repo.accept({ ...request(), eventId: input.eventId }), /IDEMPOTENCY_CONFLICT/);
  assert.equal((await db.query("SELECT * FROM run_control.runs")).rows.length, 1);
  for (const actor of [bob, otherTenant]) {
    assert.deepEqual((await repo.list(actor, { limit: 10 })).items, []);
    await assert.rejects(repo.get(actor, run.id), /NOT_FOUND/);
    await assert.rejects(repo.cancel(actor, run.id), /NOT_FOUND/);
  }
  await repo.accept(request());
  const first = await repo.list(alice, { limit: 1 });
  const second = await repo.list(alice, { limit: 1, after: first.nextCursor! });
  assert.equal(second.items[0]!.id, run.id);
  assert.equal(second.nextCursor, null);
  assert.equal("leaseId" in (await repo.get(alice, run.id)), false);
});

test("Run Control: 同会话先进先出、跨会话并行和全局领取上限", async t => {
  const { pg, db } = await serviceDatabase("run_control"); t.after(() => pg.close());
  const repo = new RunRepository(db, { leaseSeconds: 30, timeoutSeconds: 120, maxActive: 2 });
  const session = randomUUID();
  const a = await repo.accept(request(session)), b = await repo.accept(request(session)), c = await repo.accept(request());
  const claims = await Promise.all([repo.claim("worker-a"), repo.claim("worker-b"), repo.claim("worker-c")]);
  assert.deepEqual(new Set(claims.filter(Boolean).map(c => c!.run.id)), new Set([a.id, c.id]));
  assert.equal(claims.filter(Boolean).length, 2);
  const first = claims[0]!;
  await repo.finish("worker-a", first.run.id, { ...first.lease, state: "succeeded", output: "done" });
  assert.equal(await repo.claim("worker-d"), null);
  await repo.projectBatch(async () => {});
  assert.equal((await repo.claim("worker-d"))!.run.id, b.id);
});

test("Run Control: 租约身份、尝试号、截止时间和完成幂等", async t => {
  const { pg, db } = await serviceDatabase("run_control"); t.after(() => pg.close());
  const repo = new RunRepository(db);
  await repo.accept(request());
  const claim = (await repo.claim("worker-a"))!;
  await assert.rejects(repo.heartbeat("worker-b", claim.run.id, claim.lease), /LEASE_LOST/);
  await assert.rejects(repo.heartbeat("worker-a", claim.run.id, { ...claim.lease, attempt: 2 }), /LEASE_LOST/);
  await assert.rejects(repo.heartbeat("worker-a", claim.run.id, { ...claim.lease, leaseId: randomUUID() }), /LEASE_LOST/);
  await db.query("UPDATE run_control.runs SET deadline_at=clock_timestamp()+interval '2 seconds' WHERE id=$1", [claim.run.id]);
  const heartbeat = await repo.heartbeat("worker-a", claim.run.id, claim.lease);
  const record = (await db.query("SELECT deadline_at FROM run_control.runs WHERE id=$1", [claim.run.id])).rows[0]!;
  assert.equal(heartbeat.leaseExpiresAt, new Date(record.deadline_at as string).toISOString());
  const body = { ...claim.lease, state: "succeeded", output: "回答😀".repeat(3000) };
  const completed = await repo.finish("worker-a", claim.run.id, body);
  assert.equal(completed.state, "succeeded");
  const count = (await db.query("SELECT * FROM run_control.outbox")).rows.length;
  assert.ok(count > 1);
  assert.deepEqual(await repo.finish("worker-a", claim.run.id, body), completed);
  assert.equal((await db.query("SELECT * FROM run_control.outbox")).rows.length, count);
  await assert.rejects(repo.finish("worker-a", claim.run.id, { ...body, output: "different" }), /LEASE_LOST/);
  const events: unknown[] = [];
  assert.equal(await repo.publishBatch(async () => { throw new Error(); }), 0);
  await repo.projectBatch(async () => {});
  await assert.rejects(repo.publishBatch(async () => { throw new Error("broker offline"); }), /offline/);
  assert.equal(await repo.publishBatch(async (_subject, event) => { events.push(event); }), count);
  assert.equal(await repo.publishBatch(async () => { throw new Error(); }), 0);
  const projection = events as Array<{ eventType: string; payload: { text?: string } }>;
  assert.equal(projection.at(-1)!.eventType, "run.completed.v1");
  assert.equal(projection.slice(0, -1).map(e => e.payload.text).join(""), body.output);
  await assert.rejects(repo.cancel(alice, claim.run.id), /INVALID_STATE/);
});

test("Run Control: 取消保留运行槽位直到停止确认，旧结果不能覆盖取消", async t => {
  const { pg, db } = await serviceDatabase("run_control"); t.after(() => pg.close());
  const repo = new RunRepository(db), session = randomUUID();
  const first = await repo.accept(request(session)), second = await repo.accept(request(session));
  const claim = (await repo.claim("worker-a"))!;
  await repo.cancel(alice, first.id);
  assert.equal((await repo.cancel(alice, first.id)).state, "canceled");
  assert.equal((await db.query("SELECT * FROM run_control.outbox")).rows.length, 1);
  assert.equal(await repo.claim("worker-b"), null);
  await assert.rejects(repo.heartbeat("worker-a", first.id, claim.lease), /LEASE_LOST/);
  await assert.rejects(repo.finish("worker-a", first.id, { ...claim.lease, state: "succeeded", output: "late" }), /LEASE_LOST/);
  await assert.rejects(repo.release("worker-b", first.id, claim.lease), /LEASE_LOST/);
  await repo.release("worker-a", first.id, claim.lease);
  assert.equal((await repo.claim("worker-b"))!.run.id, second.id);
  const queued = await repo.accept(request());
  await repo.cancel(alice, queued.id);
  assert.equal((await repo.get(alice, queued.id)).attempt, 0);
});

test("Run Control: 过期不自动重跑，拒绝迟到结果，过期状态与事件同事务", async t => {
  const { pg, db } = await serviceDatabase("run_control"); t.after(() => pg.close());
  const repo = new RunRepository(db);
  await repo.accept(request());
  const claim = (await repo.claim("worker-a"))!;
  await db.query("UPDATE run_control.runs SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [claim.run.id]);
  await assert.rejects(repo.finish("worker-a", claim.run.id, { ...claim.lease, state: "failed", failureCode: "EXECUTION_FAILED" }), /LEASE_LOST/);
  const broken: Database = { query: db.query, transaction: work => db.transaction(tx => work({ query: (sql, values) => {
    if (sql.startsWith("INSERT INTO run_control.outbox")) throw new Error("outbox failed");
    return tx.query(sql, values);
  } })) };
  await assert.rejects(new RunRepository(broken).expireBatch(), /outbox failed/);
  assert.equal((await repo.get(alice, claim.run.id)).state, "running");
  assert.equal(await repo.expireBatch(), 1);
  assert.equal((await repo.get(alice, claim.run.id)).failureCode, "LEASE_EXPIRED");
  assert.equal(await repo.expireBatch(), 0);
  assert.equal(await repo.claim("worker-a"), null);
  await assert.rejects(repo.heartbeat("worker-a", claim.run.id, claim.lease), /LEASE_LOST/);
  await repo.accept(request());
  const timeout = (await repo.claim("worker-a"))!;
  await db.query("UPDATE run_control.runs SET deadline_at=clock_timestamp()-interval '1 second' WHERE id=$1", [timeout.run.id]);
  await repo.expireBatch();
  assert.equal((await repo.get(alice, timeout.run.id)).failureCode, "TIMEOUT");
});

test("Run Control: 消费提交后确认、坏消息隔离和数据库失败重投", async t => {
  const { pg, db } = await serviceDatabase("run_control"); t.after(() => pg.close());
  const repo = new RunRepository(db);
  let acked = 0, nacked = 0;
  const delivery = { seq: 1, subject: requestSubject, json: () => request(), ack() { acked++; }, nak() { nacked++; } };
  await processRequest(repo, delivery);
  assert.equal(acked, 1);
  await processRequest(repo, { ...delivery, seq: 2, json: () => ({ malicious: true }) });
  await processRequest(repo, { ...delivery, seq: 3, json() { throw new Error("bad JSON"); } });
  assert.equal(acked, 3);
  assert.equal((await db.query("SELECT * FROM run_control.rejected_requests")).rows.length, 2);
  const broken: Database = { query: db.query, transaction: async () => { throw new Error("db offline"); } };
  await assert.rejects(processRequest(new RunRepository(broken), delivery), /offline/);
  assert.equal(acked, 3); assert.equal(nacked, 1);
});

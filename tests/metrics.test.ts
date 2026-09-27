import test from "node:test";
import assert from "node:assert/strict";
import { setImmediate as tick } from "node:timers/promises";
import Fastify from "fastify";
import { randomUUID } from "node:crypto";
import { registerMetrics as chatMetrics } from "../dsh-agent-chat/src/metrics.js";
import { registerMetrics as workspaceMetrics } from "../dsh-agent-workspace/src/metrics.js";
import { registerMetrics as runMetrics } from "../dsh-agent-run-control/src/metrics.js";
import { RunRepository } from "../dsh-agent-run-control/src/repository.js";
import { WorkspaceRepository } from "../dsh-agent-workspace/src/repository.js";
import { serviceDatabase, MemoryBlobs } from "./workspace-catalog-helpers.js";
import { alice } from "./helpers.js";
const secret = "test-only-metrics-secret-with-thirty-two-bytes";
test("监控端点：默认不挂载、独立凭据、并发抓取合并、故障拒绝返回伪正常数据", async () => {
  for (const [register, prefix] of [[chatMetrics, "chat"], [workspaceMetrics, "workspace"], [runMetrics, "run_control"]] as const) {
    const off = Fastify(); register(off);
    assert.equal((await off.inject("/metrics")).statusCode, 404); await off.close();
    const app = Fastify(); let calls = 0, failing = false, incoming = 0;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    app.addHook("onRequest", async req => { if (req.headers.authorization === "Bearer " + secret) incoming++; });
    register(app, { secret, snapshot: async () => { calls++; await gate; if (failing) throw new Error("private database info"); return { audit_pending: 3 }; } });
    try {
      assert.equal((await app.inject("/metrics")).statusCode, 401);
      assert.equal((await app.inject({ url: "/metrics", headers: { authorization: "Bearer worker-service-key" } })).statusCode, 401);
      assert.equal(calls, 0);
      const responses = Promise.all([1,2].map(() => app.inject({ url: "/metrics", headers: { authorization: "Bearer " + secret } })));
      for (let attempt = 0; incoming < 2 && attempt < 100; attempt++) await tick();
      assert.equal(incoming, 2); await tick(); release();
      for (const r of await responses) {
        assert.equal(r.statusCode, 200); assert.match(r.headers["content-type"]!, /version=0.0.4/);
        assert.equal(r.headers["cache-control"], "no-store");
        assert.match(r.body, new RegExp(`dsh_${prefix}_audit_pending 3\\n`));
        assert.doesNotMatch(r.body, /tenant|owner|path|private|secret/);
      }
      assert.equal(calls, 1);
      failing = true;
      const failure = await app.inject({ url: "/metrics", headers: { authorization: "Bearer " + secret } });
      assert.equal(failure.statusCode, 503); assert.doesNotMatch(failure.body, /private/);
    } finally { release(); await app.close(); }
  }
});
test("监控快照：积压/超期/投影/垃圾回收指标准确，不导出主体标签", async t => {
  const runDb = await serviceDatabase("run_control"), workspaceDb = await serviceDatabase("workspace");
  t.after(async () => { await runDb.pg.close(); await workspaceDb.pg.close(); });
  const runs = new RunRepository(runDb.db), workspace = new WorkspaceRepository(workspaceDb.db, new MemoryBlobs());
  assert.equal((await runs.metrics()).runs_queued, 0); assert.equal((await workspace.metrics()).audit_pending, 0);
  const messageId = randomUUID();
  const run = await runs.accept({ eventId: randomUUID(), eventType: "conversation.message.accepted.v1", producer: "dsh-agent-chat", tenantId: alice.tenantId, ownerUid: alice.uid,
    sessionId: randomUUID(), subjectId: messageId, payload: { messageId }, occurredAt: new Date().toISOString(), traceId: "test" });
  assert.equal((await runs.metrics()).runs_queued, 1);
  const claim = (await runs.claim("worker"))!;
  assert.equal((await runs.metrics()).runs_running, 1);
  await runs.finish("worker", run.id, { ...claim.lease, state: "succeeded", output: "not exported" });
  assert.equal((await runs.metrics()).projections_pending, 1);
  assert.equal((await runs.metrics()).support_pending, 4);
  await runs.projectBatch(async () => { throw new Error(); });
  assert.equal((await runs.metrics()).projections_max_attempts, 1);
  const nextMessage = randomUUID();
  await runs.accept({ eventId: randomUUID(), eventType: "conversation.message.accepted.v1", producer: "dsh-agent-chat", tenantId: alice.tenantId, ownerUid: alice.uid,
    sessionId: randomUUID(), subjectId: nextMessage, payload: { messageId: nextMessage }, occurredAt: new Date().toISOString(), traceId: "test" });
  const overdue = (await runs.claim("worker-next"))!;
  await runDb.db.query("UPDATE run_control.runs SET lease_expires_at=clock_timestamp()-interval '1 minute' WHERE id=$1", [overdue.run.id]);
  assert.equal((await runs.metrics()).runs_overdue, 1);
  await runs.expireBatch(); assert.equal((await runs.metrics()).runs_overdue, 0);
  assert.equal((await runs.metrics()).support_retry_oldest_age_seconds, 0); // 延迟关闭票据不能误报重试故障。
  const owned = await workspace.ensure(alice);
  const file = await workspace.write(alice, owned.id, { path: "secret.txt", content: "not exported", expectedVersion: null });
  await workspace.delete(alice, owned.id, file.path, file.version);
  assert.equal((await workspace.metrics()).audit_pending, 3);
  await workspaceDb.db.query("UPDATE workspace.blobs SET retired_at=clock_timestamp()-interval '2 hours'");
  assert.equal((await workspace.metrics()).blobs_gc_pending, 1);
  await workspace.collectOne(); assert.equal((await workspace.metrics()).blobs_gc_pending, 0);
  assert.doesNotMatch(JSON.stringify([await runs.metrics(), await workspace.metrics()]), /alice|tenant|secret|not exported/);
});

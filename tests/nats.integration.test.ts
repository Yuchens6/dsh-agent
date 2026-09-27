import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import { PublicEvent } from "@dsh-agent/contracts";
import { connect } from "@nats-io/transport-node";
import { jetstream, jetstreamManager } from "@nats-io/jetstream";
import { natsSource, CursorExpired, type Delivery, type Subscription } from "../dsh-agent-stream/src/source.js";
import { ChatRepository } from "../dsh-agent-chat/src/repository.js";
import { alice, bob, database } from "./helpers.js";
import { RunRepository } from "../dsh-agent-run-control/src/repository.js";
import { serviceDatabase } from "./workspace-catalog-helpers.js";
import { openRequestConsumer, processRequest, requestStream, requestSubject } from "../dsh-agent-run-control/src/consumer.js";

async function next(subscription: AsyncIterator<Delivery>) {
  let timer: ReturnType<typeof setTimeout>;
  try {
    const item = await Promise.race([subscription.next(), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("NATS delivery timeout")), 5000);
    })]);
    assert.equal(item.done, false);
    return item.value as Delivery;
  } finally { clearTimeout(timer!); }
}

test("真实 JetStream: 事件续传与隔离、任务消费重启去重、结果回传及队列满保护",
  { skip: !process.env.NATS_SERVER_BIN, timeout: 30_000 }, async t => {
    const portServer = createServer();
    portServer.listen(0, "127.0.0.1"); await once(portServer, "listening");
    const port = (portServer.address() as { port: number }).port;
    await new Promise<void>(resolve => portServer.close(() => resolve()));
    const directory = await mkdtemp(join(tmpdir(), "dsh-nats-test-"));
    const server = spawn(process.env.NATS_SERVER_BIN!, ["-js", "-a", "127.0.0.1", "-p", String(port), "-sd", directory],
      { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    server.stderr.on("data", chunk => { output += chunk; });
    server.stdout.resume();
    t.after(async () => {
      if (server.exitCode === null) {
        const exited = once(server, "exit"); server.kill(); await exited;
      }
      await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    });
    await new Promise<void>((resolve, reject) => {
      const timer = setInterval(() => {
        if (output.includes("Server is ready")) { clearInterval(timer); clearTimeout(deadline); resolve(); }
      }, 20);
      const deadline = setTimeout(() => { clearInterval(timer); reject(new Error(output || "NATS did not start")); }, 5000);
      server.once("error", error => { clearInterval(timer); clearTimeout(deadline); reject(error); });
    });
    const nc = await connect({ servers: "nats://127.0.0.1:" + port });
    t.after(() => nc.close());
    const manager = await jetstreamManager(nc);
    const initialize = () => promisify(execFile)(process.execPath,
      [fileURLToPath(new URL("../dsh-agent-deploy/init-stream.mjs", import.meta.url))],
      { env: { ...process.env, NATS_URL: "nats://127.0.0.1:" + port, NATS_TOKEN: "" },
        timeout: 5000, windowsHide: true });
    await initialize();
    assert.equal((await manager.streams.info("DSH_EVENTS")).config.max_msg_size, 131072);
    const js = jetstream(nc);
    const { pg, db } = await database(); t.after(() => pg.close());
    const repo = new ChatRepository(db, async () => ({
      workspaceId: "01960000-0000-7000-8000-000000000001", agentDefinitionId: "document-agent", agentDefinitionVersion: 1,
    }));
    const session = await repo.create(alice, "NATS", "create-key-001", "trace");
    await repo.send(alice, session.id, "消息一", "message-001", "trace");
    const publish = (subject: string, event: unknown) => js.publish(subject, JSON.stringify(event)).then(() => {});
    await repo.publishBatch(publish);
    const beforeInit = (await manager.streams.info("DSH_EVENTS")).state.messages;
    await initialize();
    assert.equal((await manager.streams.info("DSH_EVENTS")).state.messages, beforeInit);
    const source = natsSource(nc);
    const subscriptions: Subscription[] = [];
    t.after(async () => { for (const sub of subscriptions) await sub.close(); });
    const sub = await source.open(alice, session.id);
    subscriptions.push(sub);
    const iterator = sub[Symbol.asyncIterator]();
    const first = await next(iterator); const second = await next(iterator);
    assert.ok(second.sequence > first.sequence);
    await sub.close();
    const resumed = await source.open(alice, session.id, first.sequence);
    subscriptions.push(resumed);
    const resumedIterator = resumed[Symbol.asyncIterator]();
    assert.deepEqual(await next(resumedIterator), second);
    await repo.send(alice, session.id, "消息二", "message-002", "trace");
    await repo.publishBatch(publish);
    const live = await next(resumedIterator);
    assert.ok(live.sequence > second.sequence);
    const bobSession = await repo.create(bob, "Bob", "create-key-001", "trace");
    await repo.publishBatch(publish);
    const bobSub = await source.open(bob, bobSession.id);
    subscriptions.push(bobSub);
    const bobEvent = await next(bobSub[Symbol.asyncIterator]());
    assert.equal((bobEvent.event as { ownerUid: string }).ownerUid, bob.uid);
    await manager.streams.purge("DSH_EVENTS");
    await assert.rejects(source.open(alice, session.id, first.sequence), CursorExpired);
    for (const item of subscriptions) await item.close();
    assert.equal((await manager.streams.info("DSH_EVENTS")).state.consumer_count, 0);
    // 公开事件清理不影响未确认的执行请求；没有执行器时请求仍持久保留。
    assert.equal((await manager.streams.info(requestStream)).state.messages, 2);
    assert.equal((await manager.streams.info(requestStream)).config.max_age, 0);
    const runDb = await serviceDatabase("run_control"); t.after(() => runDb.pg.close());
    const runs = new RunRepository(runDb.db);
    const requests = await openRequestConsumer(nc);
    t.after(() => { void requests.close(); });
    const requestIterator = requests[Symbol.asyncIterator]();
    const one = await requestIterator.next();
    assert.equal(one.done, false);
    const replay = one.value!.json();
    await processRequest(runs, one.value!);
    const two = await requestIterator.next();
    assert.equal(two.done, false);
    await processRequest(runs, two.value!);
    await nc.flush();
    void requests.close();
    // 重启同一持久消费者，不重置进度；生产者窗口外重发仍由数据库去重。
    const reopened = await openRequestConsumer(nc);
    t.after(() => { void reopened.close(); });
    await js.publish(requestSubject, JSON.stringify(replay));
    const duplicate = await reopened[Symbol.asyncIterator]().next();
    assert.equal(duplicate.done, false);
    await processRequest(runs, duplicate.value!);
    assert.equal((await runs.list(alice, { limit: 20 })).items.length, 2);
    const claim = (await runs.claim("test-worker"))!;
    await runs.finish("test-worker", claim.run.id, { ...claim.lease, state: "succeeded", output: "test fixture output" });
    assert.equal(await runs.publishBatch(publish), 0);
    assert.equal(await runs.projectBatch(async (actor, sessionId, result) => { await repo.appendAssistant(actor, sessionId, result); }), "projected");
    assert.equal((await repo.history(alice, session.id, 20)).items.at(-1)!.content, "test fixture output");
    await runs.publishBatch(publish);
    const resultSub = await source.open(alice, session.id);
    subscriptions.push(resultSub);
    const results = resultSub[Symbol.asyncIterator]();
    assert.equal(PublicEvent.parse((await next(results)).event).eventType, "run.output.delta.v1");
    assert.equal(PublicEvent.parse((await next(results)).event).eventType, "run.completed.v1");
    await resultSub.close();
    await nc.flush();
    await manager.streams.update(requestStream, { max_msgs: 1 });
    await js.publish(requestSubject, JSON.stringify(replay));
    await repo.send(alice, session.id, "队列满时不能丢任务", "message-003", "trace");
    await assert.rejects(repo.publishBatch(publish));
    const pendingCommands = await db.query("SELECT * FROM chat.conversation_outbox WHERE published_at IS NULL AND subject=$1", [requestSubject]);
    assert.equal(pendingCommands.rows.length, 1, "队列满时保留数据库发件箱，不淘汰旧任务");
    assert.equal((await manager.streams.info(requestStream)).state.messages, 1);
  });

import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { connect } from "node:net";
import { once } from "node:events";
import { createStreamApp } from "../dsh-agent-stream/src/app.js";
import { alice } from "./helpers.js";

test("SSE: 尚未完成订阅的请求也计入连接上限", async t => {
  const id = randomUUID();
  const exp = Math.floor(Date.now() / 1000) + 60;
  let entered!: () => void, release!: () => void;
  const opened = new Promise<void>(resolve => { entered = resolve; });
  const waiting = new Promise<void>(resolve => { release = resolve; });
  const app = createStreamApp({
    authenticate: async () => ({ actor: alice, expiresAt: exp }), verifyCapability: async () => exp,
    maxConnections: 1,
    source: { async open() {
      entered(); await waiting;
      return { async close() {}, async *[Symbol.asyncIterator]() {} };
    } },
  });
  t.after(() => app.close());
  const first = app.inject({ url: "/events/v1/sessions/" + id, headers: { "x-session-capability": "fixture" } }).then(r => r);
  await opened;
  try {
    const second = await app.inject({ url: "/events/v1/sessions/" + id, headers: { "x-session-capability": "fixture" } });
    assert.equal(second.statusCode, 429);
  } finally { release(); }
  assert.equal((await first).statusCode, 200);
});

test("SSE: 慢客户端被断开，事件读取量保持有界", { timeout: 10000 }, async t => {
  const id = randomUUID();
  const exp = Math.floor(Date.now() / 1000) + 60;
  let released!: () => void, sent = 0;
  const closed = new Promise<void>(resolve => { released = resolve; });
  const app = createStreamApp({
    authenticate: async () => ({ actor: alice, expiresAt: exp }), verifyCapability: async () => exp,
    slowConsumerMs: 50,
    source: { async open() { return {
      async close() { released(); },
      async *[Symbol.asyncIterator]() {
        for (let sequence = 1; sequence <= 10000; sequence++) {
          sent++;
          yield { sequence, event: { eventId: randomUUID(), occurredAt: new Date().toISOString(),
            producer: "worker", tenantId: alice.tenantId, ownerUid: alice.uid, sessionId: id,
            subjectId: id, traceId: "trace", eventType: "run.output.delta.v1",
            payload: { runId: id, text: "x".repeat(32000) } } };
        }
      },
    }; } },
  });
  const address = new URL(await app.listen({ host: "127.0.0.1", port: 0 }));
  const socket = connect(Number(address.port), "127.0.0.1");
  t.after(async () => { socket.destroy(); await app.close(); });
  await once(socket, "connect");
  socket.pause();
  socket.write("GET /events/v1/sessions/" + id + " HTTP/1.1\r\nHost: localhost\r\nX-Session-Capability: fixture\r\n\r\n");
  await closed;
  assert.ok(sent < 10000, "must stop pulling events when the browser cannot receive them");
});

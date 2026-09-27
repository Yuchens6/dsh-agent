import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createStreamApp } from "../dsh-agent-stream/src/app.js";
import { capabilitySigner } from "../dsh-agent-chat/src/auth.js";
import { capabilityVerifier } from "../dsh-agent-stream/src/auth.js";
import { CursorExpired, type EventSource } from "../dsh-agent-stream/src/source.js";
import { alice, bob, capabilitySecret } from "./helpers.js";

test("SSE: 建立消息代理订阅期间凭据过期，拒绝开始发送事件", async t => {
  const id = randomUUID();
  let now = 1_800_000_000_000;
  t.mock.method(Date, "now", () => now);
  const exp = now / 1000 + 1;
  let closed = false;
  const app = createStreamApp({
    authenticate: async () => ({ actor: alice, expiresAt: exp }),
    verifyCapability: async () => exp,
    source: { async open() {
      await Promise.resolve();
      now += 2000;
      return { async close() { closed = true; }, async *[Symbol.asyncIterator]() {} };
    } },
  });
  t.after(() => app.close());
  const result = await app.inject({ url: "/events/v1/sessions/" + id, headers: { "x-session-capability": "fixture" } });
  assert.equal(result.statusCode, 401);
  assert.equal(closed, true);
});

test("SSE: 重放、游标、跨用户过滤和事件字段脱敏", async t => {
  const sessionId = randomUUID();
  const subscription = await capabilitySigner(capabilitySecret)(alice, sessionId);
  let closed = false, requestedAfter: number | undefined;
  const event = { eventId: randomUUID(), occurredAt: new Date().toISOString(), producer: "dsh-agent-chat",
    tenantId: alice.tenantId, ownerUid: alice.uid, sessionId, subjectId: sessionId, traceId: "trace",
    eventType: "conversation.created.v1", payload: { sessionId, apiKey: "should-never-leak" },
    internalPath: "/private/workspaces/bob" };
  const source: EventSource = { async open(_actor, _session, after) {
    requestedAfter = after;
    return { async close() { closed = true; },
      async *[Symbol.asyncIterator]() {
        yield { sequence: 4, event };
        yield { sequence: 5, event: { ...event, ownerUid: bob.uid } };
        yield { sequence: 6, event };
        yield { sequence: 6, event };
      } };
  } };
  const app = createStreamApp({ authenticate: async () => ({ actor: alice, expiresAt: subscription.expiresAt }),
    verifyCapability: capabilityVerifier(capabilitySecret), source });
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  t.after(() => app.close());
  const headers = { "x-session-capability": subscription.token, "last-event-id": sessionId + ":4" };
  const response = await fetch(address + "/events/v1/sessions/" + sessionId, { headers, signal: AbortSignal.timeout(5000) });
  assert.equal(response.status, 200);
  const body = await response.text();
  assert.equal(requestedAfter, 4);
  assert.equal((body.match(/\ndata:/g) ?? []).length, 1);
  assert.match(body, new RegExp(sessionId + ":6"));
  assert.doesNotMatch(body, /should-never-leak|internalPath|private\/workspaces/);
  assert.equal(closed, true);
  const invalid = await app.inject({ url: "/events/v1/sessions/" + sessionId,
    headers: { ...headers, "last-event-id": randomUUID() + ":4" } });
  assert.equal(invalid.statusCode, 400);
  const wrongToken = await capabilitySigner(capabilitySecret)(bob, sessionId);
  assert.equal((await app.inject({ url: "/events/v1/sessions/" + sessionId,
    headers: { "x-session-capability": wrongToken.token } })).statusCode, 401);
});

test("SSE: 过期游标必须显式返回 409", async t => {
  const id = randomUUID();
  const cap = await capabilitySigner(capabilitySecret)(alice, id);
  const app = createStreamApp({
    authenticate: async () => ({ actor: alice, expiresAt: cap.expiresAt }),
    verifyCapability: capabilityVerifier(capabilitySecret),
    source: { async open() { throw new CursorExpired(); } },
  });
  t.after(() => app.close());
  const r = await app.inject({ url: "/events/v1/sessions/" + id, headers: { "x-session-capability": cap.token } });
  assert.equal(r.statusCode, 409); assert.equal(r.json().error.code, "CURSOR_EXPIRED");
});

test("SSE: 心跳、凭据过期自动关闭并释放消费者", async t => {
  const id = randomUUID(); let closed = false;
  let release: (() => void) | undefined;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  const exp = Math.floor(Date.now() / 1000) + 2;
  const app = createStreamApp({
    authenticate: async () => ({ actor: alice, expiresAt: exp }),
    verifyCapability: async () => exp, heartbeatMs: 20,
    source: { async open() { return {
      async close() { closed = true; release!(); },
      async *[Symbol.asyncIterator]() { await waiting; },
    }; } },
  });
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  t.after(() => app.close());
  const response = await fetch(address + "/events/v1/sessions/" + id,
    { headers: { "x-session-capability": "fixture" }, signal: AbortSignal.timeout(5000) });
  const body = await response.text();
  assert.match(body, /: heartbeat/); assert.equal(closed, true);
});

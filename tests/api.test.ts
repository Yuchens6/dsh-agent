import test from "node:test";
import assert from "node:assert/strict";
import { SignJWT } from "jose";
import { ChatRepository } from "../dsh-agent-chat/src/repository.js";
import { createChatApp } from "../dsh-agent-chat/src/app.js";
import { serviceVerifier, capabilitySigner } from "../dsh-agent-chat/src/auth.js";
import { createApiApp } from "../dsh-agent-api/src/app.js";
import { identityVerifier } from "../dsh-agent-api/src/auth.js";
import { chatClient } from "../dsh-agent-api/src/chat-client.js";
import { capabilityVerifier } from "../dsh-agent-stream/src/auth.js";
import { alice, bob, otherTenant, database, identity, secret, capabilitySecret, testBinding } from "./helpers.js";

test("HTTP 链路: API → 服务凭证 → Chat → PostgreSQL", async t => {
  const { pg, db } = await database();
  const iam = await identity();
  const repo = new ChatRepository(db, testBinding);
  const chat = createChatApp({ repository: repo, authenticate: serviceVerifier(secret),
    signCapability: capabilitySigner(capabilitySecret), ready: async () => {} });
  const address = await chat.listen({ host: "127.0.0.1", port: 0 });
  const api = createApiApp({ authenticate: identityVerifier(iam.issuer, "agent-platform", iam.key),
    chat: chatClient(address, secret) });
  t.after(async () => { await api.close(); await chat.close(); await pg.close(); });
  const authorization = "Bearer " + await iam.token();
  assert.equal((await api.inject({ url: "/api/v1/me" })).statusCode, 401);
  const me = await api.inject({ url: "/api/v1/me", headers: {
    authorization, "x-user-id": "admin", "x-tenant-id": "other", "x-role": "admin" } });
  assert.deepEqual(me.json(), alice);
  assert.equal((await chat.inject({ url: "/internal/v1/sessions", headers: { authorization } })).statusCode, 401);
  const unsafe = await api.inject({ method: "POST", url: "/api/v1/sessions",
    headers: { authorization, "idempotency-key": "create-key-000" }, payload: { title: "x", tools: ["bash"] } });
  assert.equal(unsafe.statusCode, 400);
  const create = { method: "POST" as const, url: "/api/v1/sessions",
    headers: { authorization, "idempotency-key": "create-key-001" }, payload: { title: "你好" } };
  const created = await api.inject(create);
  assert.equal(created.statusCode, 201, created.body);
  assert.equal((await api.inject(create)).json().id, created.json().id);
  const id = created.json().id;
  const message = await api.inject({ method: "POST", url: "/api/v1/sessions/" + id + "/messages",
    headers: { authorization, "idempotency-key": "message-key-001" }, payload: { content: "消息" } });
  assert.equal(message.statusCode, 202, message.body);
  for (const foreign of [bob, otherTenant]) {
    const h = { authorization: "Bearer " + await iam.token(foreign) };
    assert.equal((await api.inject({ url: "/api/v1/sessions/" + id, headers: h })).statusCode, 404);
    assert.equal((await api.inject({ method: "POST", url: "/api/v1/sessions/" + id + "/subscription", headers: h })).statusCode, 404);
    assert.deepEqual((await api.inject({ url: "/api/v1/sessions", headers: h })).json().items, []);
  }
  const signed = await api.inject({ method: "POST", url: "/api/v1/sessions/" + id + "/subscription", headers: { authorization } });
  assert.equal(signed.statusCode, 200, signed.body);
  await capabilityVerifier(capabilitySecret)(signed.json().token, alice, id);
  await assert.rejects(capabilityVerifier(capabilitySecret)(signed.json().token, bob, id));
  assert.equal((await api.inject({ url: "/api/v1/sessions?limit=1000", headers: { authorization } })).statusCode, 400);
  assert.equal((await api.inject({ url: "/internal/v1/sessions", headers: { authorization } })).statusCode, 404);
});

test("IAM: 拒绝错误受众、过期令牌、缺少租户和错误签名", async () => {
  const iam = await identity();
  const verify = identityVerifier(iam.issuer, "agent-platform", iam.key);
  for (const [aud, exp] of [["wrong-audience", "1m"], ["agent-platform", "-1s"]]) {
    const token = await new SignJWT({ tenantId: alice.tenantId }).setProtectedHeader({ alg: "RS256", kid: "test-key" })
      .setIssuer(iam.issuer).setSubject(alice.uid).setAudience(aud!).setIssuedAt().setExpirationTime(exp!).sign(iam.privateKey);
    await assert.rejects(verify("Bearer " + token));
  }
  await assert.rejects(verify("Bearer " + await iam.token(alice, { tenantId: undefined })));
  const foreign = await identity();
  await assert.rejects(verify("Bearer " + await foreign.token()));
  await assert.rejects(verify("Bearer invalid"));
});

test("API: 内部错误与连接故障不泄漏实现细节", async t => {
  const api = createApiApp({ authenticate: async () => alice, chat: chatClient("http://127.0.0.1:1", secret) });
  t.after(() => api.close());
  const response = await api.inject({ url: "/api/v1/sessions" });
  assert.equal(response.statusCode, 503);
  assert.equal(response.json().error.code, "DEPENDENCY_UNAVAILABLE");
  assert.doesNotMatch(response.body, /127\.0\.0\.1|secret|ECONNREFUSED/);
});

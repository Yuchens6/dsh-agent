import test from "node:test";
import assert from "node:assert/strict";
import { SignJWT } from "jose";
import { createWorkspaceApp } from "../dsh-agent-workspace/src/app.js";
import { WorkspaceRepository } from "../dsh-agent-workspace/src/repository.js";
import { serviceVerifier as workspaceVerifier } from "../dsh-agent-workspace/src/auth.js";
import { createCatalogApp } from "../dsh-agent-catalog/src/app.js";
import { CatalogRepository } from "../dsh-agent-catalog/src/repository.js";
import { serviceVerifier as catalogVerifier } from "../dsh-agent-catalog/src/auth.js";
import { createChatApp } from "../dsh-agent-chat/src/app.js";
import { ChatRepository } from "../dsh-agent-chat/src/repository.js";
import { bindingResolver } from "../dsh-agent-chat/src/binding-client.js";
import { serviceVerifier, capabilitySigner } from "../dsh-agent-chat/src/auth.js";
import { createApiApp } from "../dsh-agent-api/src/app.js";
import { chatClient, serviceClient } from "../dsh-agent-api/src/chat-client.js";
import { identityVerifier } from "../dsh-agent-api/src/auth.js";
import { serviceDatabase, MemoryBlobs, definition, serviceSecrets as keys } from "./workspace-catalog-helpers.js";
import { alice, bob, otherTenant, identity, secret, capabilitySecret } from "./helpers.js";

test("HTTP: API → Chat → Workspace/Catalog 绑定、隔离、版本钉住和故障重放", async t => {
  const { pg, db } = await serviceDatabase("chat", "workspace", "catalog"); t.after(() => pg.close());
  const iam = await identity();
  const workspaceRepo = new WorkspaceRepository(db, new MemoryBlobs()), catalogRepo = new CatalogRepository(db);
  await catalogRepo.publish(definition, alice.tenantId, true);
  const workspace = createWorkspaceApp({ repository: workspaceRepo, ready: async () => {},
    authenticate: workspaceVerifier({ api: keys.apiWorkspace, chat: keys.chatWorkspace }) });
  const catalog = createCatalogApp({ repository: catalogRepo, ready: async () => {},
    authenticate: catalogVerifier({ api: keys.apiCatalog, chat: keys.chatCatalog }) });
  const workspaceUrl = await workspace.listen({ host: "127.0.0.1", port: 0 });
  const catalogUrl = await catalog.listen({ host: "127.0.0.1", port: 0 });
  t.after(async () => { await workspace.close(); await catalog.close(); });
  const chat = createChatApp({
    repository: new ChatRepository(db, bindingResolver({
      workspaceUrl, catalogUrl, workspaceSecret: keys.chatWorkspace, catalogSecret: keys.chatCatalog,
    })), ready: async () => {}, authenticate: serviceVerifier(secret), signCapability: capabilitySigner(capabilitySecret),
  });
  const chatUrl = await chat.listen({ host: "127.0.0.1", port: 0 });
  const api = createApiApp({
    authenticate: identityVerifier(iam.issuer, "agent-platform", iam.key),
    chat: chatClient(chatUrl, secret),
    workspace: serviceClient(workspaceUrl, keys.apiWorkspace, "dsh-agent-workspace"),
    catalog: serviceClient(catalogUrl, keys.apiCatalog, "dsh-agent-catalog"),
  });
  t.after(async () => { await api.close(); await chat.close(); });
  const headers = { authorization: "Bearer " + await iam.token(), "idempotency-key": "provision-session-001" };
  const create = { method: "POST" as const, url: "/api/v1/sessions", headers, payload: { title: "Bound session" } };
  const sessionResponse = await api.inject(create);
  assert.equal(sessionResponse.statusCode, 201, sessionResponse.body);
  const session = sessionResponse.json();
  assert.ok(session.workspaceId);
  assert.equal(session.agentDefinitionVersion, 1);
  assert.equal(session.workspaceId, (await api.inject({ method: "POST", url: "/api/v1/workspaces/ensure", headers })).json().id);
  const fileUrl = "/api/v1/workspaces/" + session.workspaceId + "/file";
  const put = await api.inject({ method: "PUT", url: fileUrl, headers,
    payload: { path: "notes/a.txt", content: "hello", expectedVersion: null } });
  assert.equal(put.statusCode, 200, put.body);
  assert.equal((await api.inject({ url: fileUrl + "?path=notes%2Fa.txt", headers })).json().content, "hello");
  assert.equal((await api.inject({ method: "PUT", url: fileUrl, headers,
    payload: { path: "notes/a.txt", content: "stale", expectedVersion: null } })).json().error.code, "VERSION_CONFLICT");
  for (const foreign of [bob, otherTenant]) {
    const h = { authorization: "Bearer " + await iam.token(foreign) };
    assert.equal((await api.inject({ url: fileUrl + "?path=notes%2Fa.txt", headers: h })).statusCode, 404);
    assert.equal((await api.inject({ method: "DELETE", url: fileUrl + "?path=notes%2Fa.txt&expectedVersion=" + put.json().version, headers: h })).statusCode, 404);
  }
  assert.equal((await api.inject({ method: "POST", url: "/api/v1/workspaces/ensure", headers, payload: { uid: "bob" } })).statusCode, 400);
  assert.equal((await api.inject({ method: "POST", url: create.url, headers,
    payload: { title: "x", workspaceId: session.workspaceId } })).statusCode, 400);
  const unauthorizedTenant = await api.inject({ ...create,
    headers: { ...headers, authorization: "Bearer " + await iam.token(otherTenant) } });
  assert.equal(unauthorizedTenant.statusCode, 503, "未获定义授权时不创建可运行会话");
  assert.equal((await db.query("SELECT * FROM chat.conversations")).rows.length, 1);
  await catalogRepo.publish({ ...definition, version: 2 }, alice.tenantId, true);
  assert.equal((await api.inject(create)).json().agentDefinitionVersion, 1);
  const newer = await api.inject({ ...create, headers: { ...headers, "idempotency-key": "provision-session-002" } });
  assert.equal(newer.json().agentDefinitionVersion, 2);
  assert.equal(newer.json().workspaceId, session.workspaceId);
  const definitions = await api.inject({ url: "/api/v1/definitions", headers });
  assert.equal(definitions.statusCode, 200, definitions.body);
  assert.equal(definitions.json().items.length, 2);
  await catalog.close();
  assert.equal((await api.inject(create)).statusCode, 201, "旧幂等请求不依赖定义中心");
  assert.equal((await api.inject({ ...create, headers: { ...headers, "idempotency-key": "provision-session-003" } })).statusCode, 503);
  assert.equal((await api.inject({ ...create, payload: { title: "different" } })).statusCode, 409);
});

test("服务认证: 错误签发者/受众/密钥被拒，Chat 凭据没有文件访问权", async t => {
  const { pg, db } = await serviceDatabase("workspace"); t.after(() => pg.close());
  const repository = new WorkspaceRepository(db, new MemoryBlobs());
  const { id } = await repository.ensure(alice);
  const app = createWorkspaceApp({ repository, ready: async () => {},
    authenticate: workspaceVerifier({ api: keys.apiWorkspace, chat: keys.chatWorkspace }) });
  t.after(() => app.close());
  async function token(issuer: string, audience: string, key: string, expires = "30s") {
    return new SignJWT({ actor: alice }).setProtectedHeader({ alg: "HS256" })
      .setIssuer(issuer).setAudience(audience).setIssuedAt().setExpirationTime(expires).sign(new TextEncoder().encode(key));
  }
  for (const invalid of [
    await token("dsh-agent-api", "dsh-agent-catalog", keys.apiWorkspace),
    await token("dsh-agent-chat", "dsh-agent-workspace", keys.apiWorkspace),
    await token("dsh-agent-api", "dsh-agent-workspace", keys.apiCatalog),
    await token("dsh-agent-api", "dsh-agent-workspace", keys.apiWorkspace, "-1s"),
  ]) assert.equal((await app.inject({ url: "/internal/v1/workspaces/" + id, headers: { authorization: "Bearer " + invalid } })).statusCode, 401);
  const authorization = "Bearer " + await token("dsh-agent-chat", "dsh-agent-workspace", keys.chatWorkspace);
  assert.equal((await app.inject({ method: "POST", url: "/internal/v1/workspaces/ensure", headers: { authorization } })).statusCode, 200);
  assert.equal((await app.inject({ url: "/internal/v1/workspaces/" + id + "/files", headers: { authorization } })).statusCode, 403);
  assert.equal((await app.inject({ method: "PUT", url: "/internal/v1/workspaces/" + id + "/file",
    headers: { authorization }, payload: { path: "a", content: "x", expectedVersion: null } })).statusCode, 403);
});

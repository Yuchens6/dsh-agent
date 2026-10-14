import test from "node:test";
import assert from "node:assert/strict";
import { SignJWT } from "jose";
import { AgentDefinition, StudioPublish } from "@dsh-agent/contracts";
import { CatalogRepository } from "../dsh-agent-catalog/src/repository.js";
import { StudioRepository } from "../dsh-agent-catalog/src/studio.js";
import { createCatalogApp } from "../dsh-agent-catalog/src/app.js";
import { serviceVerifier } from "../dsh-agent-catalog/src/auth.js";
import { createApiApp } from "../dsh-agent-api/src/app.js";
import { serviceClient } from "../dsh-agent-api/src/chat-client.js";
import { ChatRepository } from "../dsh-agent-chat/src/repository.js";
import { bindingResolver } from "../dsh-agent-chat/src/binding-client.js";
import { createWorkspaceApp } from "../dsh-agent-workspace/src/app.js";
import { WorkspaceRepository } from "../dsh-agent-workspace/src/repository.js";
import { serviceVerifier as workspaceVerifier } from "../dsh-agent-workspace/src/auth.js";
import { alice, bob, otherTenant } from "./helpers.js";
import { definition, serviceDatabase, serviceSecrets as keys, MemoryBlobs } from "./workspace-catalog-helpers.js";
const admin = { ...alice, roles: ["user", "tenant-admin"] };
const proposal = () => StudioPublish.parse({ slug: "researcher", expectedVersion: 0,
  base: { id: definition.id, version: 1 }, name: "租户研究助手", description: "测试文本技能与工作流",
  systemPrompt: "回答用户问题", tools: ["workspace.read"], skills: [{ id: "brief", version: 1, instructions: "简短回答。" }],
  workflow: { steps: [{ id: "draft", instructions: "先分析", maxTurns: 2, tools: ["workspace.read"] },
    { id: "final", instructions: "再总结", maxTurns: 1, tools: [] }] } });

test("Studio: 管理员受限发布、同租户可用、跨租户不可见且相同 slug 不碰撞", async t => {
  const { pg, db } = await serviceDatabase("catalog"); t.after(() => pg.close());
  const catalog = new CatalogRepository(db), studio = new StudioRepository(db);
  await catalog.publish(definition, alice.tenantId, true);
  await assert.rejects(studio.publish(alice, proposal()), /FORBIDDEN/);
  await assert.rejects(studio.publish({ ...otherTenant, roles: ["tenant-admin"] }, proposal()), /NOT_FOUND/);
  const published = await studio.publish(admin, proposal());
  assert.deepEqual(published.execution, definition.execution);
  assert.deepEqual(published.model, definition.model);
  assert.equal((await catalog.get(bob, published.id, 1)).workflow?.steps.length, 2);
  await assert.rejects(catalog.get(otherTenant, published.id, 1), /NOT_FOUND/);
  assert.equal((await catalog.getDefault(alice)).id, definition.id, "发布不改变租户默认值");
  assert.equal((await studio.state(alice)).canPublish, false);
  assert.equal((await studio.state(admin)).canPublish, true);
  assert.deepEqual((await studio.state(otherTenant)).items, []);
  await catalog.publish(definition, otherTenant.tenantId, true);
  const other = await studio.publish({ ...otherTenant, roles: ["tenant-admin"] }, proposal());
  assert.notEqual(other.id, published.id);
  assert.equal((await catalog.list(alice)).items.find(item => item.id === published.id)?.kind, "workflow");
});

test("Studio: 不可变版本、冲突重试、越权模板、调用预算和注入配置", async t => {
  const { pg, db } = await serviceDatabase("catalog"); t.after(() => pg.close());
  const catalog = new CatalogRepository(db), studio = new StudioRepository(db);
  await catalog.publish(definition, alice.tenantId, true);
  const first = await studio.publish(admin, proposal());
  assert.deepEqual(await studio.publish(admin, proposal()), first, "丢失响应可精确重放");
  await assert.rejects(studio.publish(admin, { ...proposal(), name: "冲突" }), /VERSION_CONFLICT/);
  const second = await studio.publish(admin, { ...proposal(), expectedVersion: 1, name: "新版" });
  assert.equal(second.version, 2);
  assert.equal((await catalog.get(alice, first.id, 1)).name, first.name);
  await assert.rejects(studio.publish(admin, proposal()), /VERSION_CONFLICT/);
  await assert.rejects(studio.publish(admin, { ...proposal(), slug: "nested", base: { id: second.id, version: 2 } }), /NOT_FOUND/);
  for (const patch of [
    { tools: ["knowledge.search"] }, { tools: ["workspace.read", "workspace.read"] },
    { tenantId: "another-tenant" }, { model: { provider: "evil", name: "bypass" } }, { execution: { maxTurns: 50 } },
    { skills: [{ id: "script", version: 1, instructions: "hi", resourceBase: { path: "C:/" } }] },
    { skills: [{ id: "../escape", version: 1, instructions: "hi" }] },
    { workflow: { steps: [{ id: "one", instructions: "x", maxTurns: 50, tools: [] }] } },
    { workflow: { steps: [{ id: "one", instructions: "x", maxTurns: 1, tools: ["workspace.write"] }] } },
    { workflow: { script: "process.exit()", steps: [] } },
  ]) await assert.rejects(studio.publish(admin, { ...proposal(), slug: "unsafe", ...patch }));
  assert.equal((await studio.state(admin)).items.length, 1);
  await catalog.revoke(alice.tenantId, definition.id, 1);
  await assert.rejects(studio.publish(admin, { ...proposal(), expectedVersion: 2 }), /NOT_FOUND/);
});

test("Studio HTTP: API 和 Catalog 双层角色检查，Chat 凭据不能发布，未启用时关闭写入口", async t => {
  const { pg, db } = await serviceDatabase("catalog"); t.after(() => pg.close());
  const repository = new CatalogRepository(db); await repository.publish(definition, alice.tenantId, true);
  const secrets = { api: keys.apiCatalog, chat: keys.chatCatalog };
  const catalog = createCatalogApp({ repository, studio: new StudioRepository(db), ready: async () => {},
    authenticate: serviceVerifier(secrets), authenticateStudio: serviceVerifier(secrets, ["dsh-agent-api"]) });
  const url = await catalog.listen({ host: "127.0.0.1", port: 0 }); t.after(() => catalog.close());
  const api = createApiApp({ authenticate: async header => header === "admin" ? admin : alice,
    chat: async () => { throw new Error("unused"); }, catalog: serviceClient(url, keys.apiCatalog, "dsh-agent-catalog") }); t.after(() => api.close());
  const request = { method: "POST" as const, url: "/api/v1/studio/agents", payload: proposal() };
  assert.equal((await api.inject({ ...request, headers: { authorization: "member" } })).statusCode, 403);
  const published = await api.inject({ ...request, headers: { authorization: "admin" } });
  assert.equal(published.statusCode, 200, published.body);
  const chatToken = await new SignJWT({ actor: admin }).setProtectedHeader({ alg: "HS256" }).setIssuer("dsh-agent-chat")
    .setAudience("dsh-agent-catalog").setIssuedAt().setExpirationTime("30s").sign(new TextEncoder().encode(keys.chatCatalog));
  assert.equal((await catalog.inject({ method: "POST", url: "/internal/v1/studio/agents", headers: { authorization: "Bearer " + chatToken }, payload: proposal() })).statusCode, 401);
  const disabled = createCatalogApp({ repository, authenticate: async () => admin, ready: async () => {} }); t.after(() => disabled.close());
  assert.equal((await disabled.inject({ url: "/internal/v1/studio" })).json().enabled, false);
  assert.equal((await disabled.inject({ method: "POST", url: "/internal/v1/studio/agents", payload: proposal() })).statusCode, 403);
});

test("会话选择: 租户成员使用授权工作流，拒绝外租户版本，选择进入幂等哈希", async t => {
  const { pg, db } = await serviceDatabase("catalog", "chat", "workspace"); t.after(() => pg.close());
  const repository = new CatalogRepository(db); await repository.publish(definition, alice.tenantId, true);
  const flow = AgentDefinition.parse({ ...definition, id: "provided-workflow", workflow: proposal().workflow });
  await repository.publish(flow, alice.tenantId, false);
  const catalog = createCatalogApp({ repository, ready: async () => {}, authenticate: serviceVerifier({ api: keys.apiCatalog, chat: keys.chatCatalog }) });
  const workspace = createWorkspaceApp({ repository: new WorkspaceRepository(db, new MemoryBlobs()), ready: async () => {},
    authenticate: workspaceVerifier({ api: keys.apiWorkspace, chat: keys.chatWorkspace }) });
  const catalogUrl = await catalog.listen({ host: "127.0.0.1", port: 0 }), workspaceUrl = await workspace.listen({ host: "127.0.0.1", port: 0 });
  t.after(async () => { await catalog.close(); await workspace.close(); });
  const chat = new ChatRepository(db, bindingResolver({ catalogUrl, workspaceUrl, catalogSecret: keys.chatCatalog, workspaceSecret: keys.chatWorkspace }));
  const selection = { id: flow.id, version: 1 };
  const session = await chat.create(alice, "Workflow", "workflow-session-001", crypto.randomUUID(), selection);
  assert.equal(session.agentDefinitionId, flow.id);
  assert.equal((await repository.getDefault(alice)).id, definition.id);
  await assert.rejects(chat.create(alice, "Workflow", "workflow-session-001", crypto.randomUUID(), { id: definition.id, version: 1 }), /IDEMPOTENCY_CONFLICT/);
  await assert.rejects(chat.create(otherTenant, "Denied", "workflow-session-002", crypto.randomUUID(), selection), /NOT_FOUND/);
  await repository.revoke(alice.tenantId, flow.id, 1);
  assert.equal((await chat.create(alice, "Workflow", "workflow-session-001", crypto.randomUUID(), selection)).id, session.id);
  await assert.rejects(chat.create(alice, "Revoked", "workflow-session-003", crypto.randomUUID(), selection), /NOT_FOUND/);
  assert.equal((await db.query("SELECT * FROM chat.conversations")).rows.length, 1);
});

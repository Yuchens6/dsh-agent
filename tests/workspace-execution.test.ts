import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import { decodeJwt, SignJWT } from "jose";
import { AgentDefinition, WorkspaceCapability, WorkspaceToolResult, type Principal } from "@dsh-agent/contracts";
import { RunRepository } from "../dsh-agent-run-control/src/repository.js";
import { createRunControlApp } from "../dsh-agent-run-control/src/app.js";
import { authenticators } from "../dsh-agent-run-control/src/auth.js";
import { workspaceCapabilitySigner, workspaceServiceVerifier } from "../dsh-agent-run-control/src/workspace-auth.js";
import { WorkspaceRepository } from "../dsh-agent-workspace/src/repository.js";
import { createWorkspaceApp } from "../dsh-agent-workspace/src/app.js";
import { serviceVerifier } from "../dsh-agent-workspace/src/auth.js";
import { executionAuthorizer } from "../dsh-agent-workspace/src/execution-auth.js";
import { serviceDatabase, MemoryBlobs, definition, serviceSecrets } from "./workspace-catalog-helpers.js";
import { alice, bob, otherTenant, secret } from "./helpers.js";
const capKey = "test-only-run-control-workspace-capability-32";
const authKey = "test-only-workspace-control-authorization-32";
const workerKey = "test-only-runtime-run-control-secret-32";
const signCapability = workspaceCapabilitySigner(capKey);
async function serviceToken(issuer: string, audience: string, key: string, payload: Record<string, unknown> = {}, sub = "worker-a") {
  return new SignJWT(payload).setProtectedHeader({ alg: "HS256", typ: "JWT" }).setIssuer(issuer).setAudience(audience)
    .setSubject(sub).setIssuedAt().setExpirationTime("30s").sign(new TextEncoder().encode(key));
}
class ObservedBlobs extends MemoryBlobs {
  afterPut?: () => Promise<void>;
  afterGet?: () => Promise<void>;
  override async put(key: string, data: Uint8Array) { await super.put(key, data); await this.afterPut?.(); }
  override async get(key: string, size: number) { const value = await super.get(key, size); await this.afterGet?.(); return value; }
}
async function fixture(t: TestContext) {
  const runDb = await serviceDatabase("run_control"), workspaceDb = await serviceDatabase("workspace");
  // 权限夹具会同时保留多个本用户运行，并发限制由独立调度测试验证。
  const runs = new RunRepository(runDb.db,undefined,{userActive:8,tenantActive:32,agingSeconds:60}), blobs = new ObservedBlobs(), workspace = new WorkspaceRepository(workspaceDb.db, blobs);
  const auth = authenticators(secret, workerKey);
  const runApp = createRunControlApp({ repository: runs, authenticateApi: auth.api, authenticateWorker: auth.worker,
    signWorkspaceCapability: signCapability, authenticateWorkspace: workspaceServiceVerifier(authKey), ready: async () => {} });
  const runUrl = await runApp.listen({ host: "127.0.0.1", port: 0 });
  const authorize = executionAuthorizer({ capabilitySecret: capKey, serviceSecret: authKey, runControlUrl: runUrl });
  const workspaceApp = createWorkspaceApp({ repository: workspace, authenticate: serviceVerifier({ api: serviceSecrets.apiWorkspace, chat: serviceSecrets.chatWorkspace }),
    authorizeExecution: authorize, ready: async () => {} });
  t.after(async () => { await workspaceApp.close(); await runApp.close(); await workspaceDb.pg.close(); await runDb.pg.close(); });
  async function claim(actor: Principal = alice, tools = definition.tools, withSnapshot = true) {
    const owned = await workspace.ensure(actor), messageId = randomUUID(), sessionId = randomUUID();
    const run = await runs.accept({ eventId: randomUUID(), eventType: "conversation.message.accepted.v1", producer: "dsh-agent-chat",
      tenantId: actor.tenantId, ownerUid: actor.uid, sessionId, subjectId: messageId, payload: { messageId }, occurredAt: new Date().toISOString(), traceId: "test" });
    const claimed = (await runs.claim("worker-a"))!;
    if (withSnapshot) await runs.input("worker-a", run.id, claimed.lease, async () => ({ runId: run.id,
      capturedAt: new Date().toISOString(), definition: AgentDefinition.parse({ ...definition, tools }),
      context: { sessionId, messageId, truncated: false,
        binding: { workspaceId: owned.id, agentDefinitionId: definition.id, agentDefinitionVersion: 1 },
        messages: [{ id: messageId, sessionId, role: "user", content: "test", createdAt: new Date().toISOString() }] } }));
    const workerHeaders = { authorization: "Bearer " + await serviceToken("dsh-agent-runtime-dsh", "dsh-agent-run-control", workerKey) };
    const issue = () => runApp.inject({ method: "POST", url: `/worker/v1/runs/${run.id}/workspace-capability`, headers: workerHeaders, payload: claimed.lease });
    return { run, claimed, owned, issue, reference: { runId: run.id, workerId: "worker-a", ...claimed.lease } };
  }
  const call = (token: string, payload: Record<string, unknown>) => workspaceApp.inject({ method: "POST", url: "/execution/v1/tools", headers: { authorization: "Bearer " + token }, payload });
  return { runs, runDb, workspaceDb, runApp, runUrl, workspaceApp, workspace, blobs, claim, call, authorize };
}

test("运行工具：按运行绑定工作区，名单限制、版本冲突和租户隔离", async t => {
  const f = await fixture(t), a = await f.claim();
  const capResponse = await a.issue(); assert.equal(capResponse.statusCode, 200, capResponse.body);
  const cap = WorkspaceCapability.parse(capResponse.json());
  assert.ok(cap.expiresAt <= Math.floor(Date.parse(a.claimed.leaseExpiresAt) / 1000));
  const payload = decodeJwt(cap.token);
  assert.ok(payload.exp! - payload.iat! <= 30);
  assert.deepEqual(payload.reference, a.reference);
  assert.equal(payload.actor, undefined); assert.equal(payload.workspaceId, undefined);
  for (const foreign of [bob, otherTenant]) {
    const owned = await f.workspace.ensure(foreign);
    await f.workspace.write(foreign, owned.id, { path: "private.txt", content: "foreign secret", expectedVersion: null });
    assert.equal((await f.call(cap.token, { tool: "workspace.read", arguments: { path: "private.txt", workspaceId: owned.id } })).statusCode, 400);
  }
  assert.equal((await f.call(cap.token, { tool: "workspace.read", arguments: { path: "private.txt" } })).statusCode, 404);
  const write = await f.call(cap.token, { tool: "workspace.write", arguments: { path: "notes/a.txt", content: "safe", expectedVersion: null } });
  assert.equal(write.statusCode, 200, write.body); WorkspaceToolResult.parse(write.json());
  assert.equal(write.headers["cache-control"], "no-store");
  const version = write.json().result.version;
  assert.equal((await f.call(cap.token, { tool: "workspace.write", arguments: { path: "notes/a.txt", content: "other", expectedVersion: null } })).statusCode, 409);
  const read = await f.call(cap.token, { tool: "workspace.read", arguments: { path: "notes/a.txt" } });
  assert.equal(read.json().result.content, "safe"); WorkspaceToolResult.parse(read.json());
  const list = await f.call(cap.token, { tool: "workspace.list", arguments: { prefix: "notes" } });
  assert.equal(list.json().result.items[0].version, version); WorkspaceToolResult.parse(list.json());
  for (const path of ["../other/file", "/absolute", "C:/host", "x%2fy", "a/../x", "a\\b"]) {
    assert.equal((await f.call(cap.token, { tool: "workspace.read", arguments: { path } })).statusCode, 400);
  }
  for (const tool of ["bash", "mcp", "workspace.delete"]) {
    assert.equal((await f.call(cap.token, { tool, arguments: {} })).statusCode, 400);
  }
  assert.equal((await f.call(cap.token, { tool: "workspace.list", arguments: {}, uid: bob.uid })).statusCode, 400);
  const readOnly = await f.claim(alice, ["workspace.read"]);
  const readCap = (await readOnly.issue()).json().token;
  assert.equal((await f.call(readCap, { tool: "workspace.write", arguments: { path: "x", content: "x", expectedVersion: null } })).statusCode, 403);
  assert.equal((await f.call(readCap, { tool: "workspace.read", arguments: { path: "notes/a.txt" } })).statusCode, 200);
  const noTools = await f.claim(alice, []);
  assert.equal((await noTools.issue()).statusCode, 403);
  const noSnapshot = await f.claim(alice, definition.tools, false);
  assert.equal((await noSnapshot.issue()).statusCode, 409);
});

test("运行工具认证：密钥/受众/入口分离，伪造租约与过期令牌拒绝", async t => {
  const f = await fixture(t), a = await f.claim();
  const cap = (await a.issue()).json().token as string;
  const list = { tool: "workspace.list", arguments: {} };
  for (const [issuer, audience, key, payload] of [
    ["dsh-agent-api", "dsh-agent-workspace", serviceSecrets.apiWorkspace, { actor: alice }],
    ["dsh-agent-chat", "dsh-agent-workspace", serviceSecrets.chatWorkspace, { actor: alice }],
    ["dsh-agent-runtime-dsh", "dsh-agent-run-control", workerKey, {}],
    ["dsh-agent-run-control", "wrong-audience", capKey, { scope: "workspace:execute", reference: a.reference }],
    ["dsh-agent-run-control", "dsh-agent-workspace-execution", authKey, { scope: "workspace:execute", reference: a.reference }],
  ] as const) assert.equal((await f.call(await serviceToken(issuer, audience, key, payload), list)).statusCode, 401);
  const bogus = cap.slice(0, -5) + "XXXXX";
  assert.equal((await f.call(bogus, list)).statusCode, 401);
  const malformedReference = { ...a.reference, uid: alice.uid };
  assert.equal((await f.call(await serviceToken("dsh-agent-run-control", "dsh-agent-workspace-execution", capKey,
    { scope: "workspace:execute", reference: malformedReference }), list)).statusCode, 401);
  const expired = await new SignJWT({ scope: "workspace:execute", reference: a.reference }).setProtectedHeader({ alg: "HS256" })
    .setIssuer("dsh-agent-run-control").setAudience("dsh-agent-workspace-execution").setIssuedAt(Math.floor(Date.now() / 1000) - 20)
    .setExpirationTime(Math.floor(Date.now() / 1000) - 1).sign(new TextEncoder().encode(capKey));
  assert.equal((await f.call(expired, list)).statusCode, 401);
  const longLived = await new SignJWT({ scope: "workspace:execute", reference: a.reference }).setProtectedHeader({ alg: "HS256" })
    .setIssuer("dsh-agent-run-control").setAudience("dsh-agent-workspace-execution").setIssuedAt()
    .setExpirationTime("5m").sign(new TextEncoder().encode(capKey));
  assert.equal((await f.call(longLived, list)).statusCode, 401);
  for (const bad of [{ ...a.reference, workerId: "worker-b" }, { ...a.reference, attempt: 2 }, { ...a.reference, runId: randomUUID() }]) {
    const forged = await signCapability(bad, Math.floor(Date.now() / 1000) + 30);
    assert.equal((await f.call(forged.token, list)).statusCode, 409);
  }
  assert.equal((await f.workspaceApp.inject({ url: `/internal/v1/workspaces/${a.owned.id}/files`, headers: { authorization: "Bearer " + cap } })).statusCode, 401);
  assert.equal((await f.runApp.inject({ method: "POST", url: "/authorization/v1/workspace", headers: { authorization: "Bearer " + cap }, payload: { ...a.reference, tool: "workspace.list" } })).statusCode, 401);
  const serviceCredential = await serviceToken("dsh-agent-workspace", "dsh-agent-run-control-authorization", authKey, { scope: "workspace:authorize" });
  assert.equal((await f.runApp.inject({ method: "POST", url: "/worker/v1/claim", headers: { authorization: "Bearer " + serviceCredential } })).statusCode, 401);
  const workerCredential = await serviceToken("dsh-agent-runtime-dsh", "dsh-agent-run-control", workerKey);
  assert.equal((await f.runApp.inject({ method: "POST", url: "/authorization/v1/workspace", headers: { authorization: "Bearer " + workerCredential }, payload: { ...a.reference, tool: "workspace.list" } })).statusCode, 401);
});

test("运行工具撤销：取消/终态/租约过期立即拒绝后续调用，不因续期延长旧令牌", async t => {
  const f = await fixture(t), a = await f.claim();
  const capability = (await a.issue()).json();
  await f.runs.heartbeat("worker-a", a.run.id, a.claimed.lease);
  assert.equal(decodeJwt(capability.token).exp, capability.expiresAt);
  await f.runs.cancel(alice, a.run.id);
  assert.equal((await f.call(capability.token, { tool: "workspace.list", arguments: {} })).statusCode, 409);
  assert.equal((await a.issue()).statusCode, 409);
  const b = await f.claim(); const bCap = (await b.issue()).json().token;
  await f.runs.finish("worker-a", b.run.id, { ...b.claimed.lease, state: "failed", failureCode: "EXECUTION_FAILED" });
  assert.equal((await f.call(bCap, { tool: "workspace.list", arguments: {} })).statusCode, 409);
  const c = await f.claim(); const cCap = (await c.issue()).json().token;
  await f.runDb.db.query("UPDATE run_control.runs SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [c.run.id]);
  assert.equal((await f.call(cCap, { tool: "workspace.list", arguments: {} })).statusCode, 409);
});

test("运行工具写入：上传期间取消或租约过期，保留原版本并回收暂存对象", async t => {
  const f = await fixture(t);
  for (const reason of ["cancel", "expire"] as const) {
    const a = await f.claim(), capability = (await a.issue()).json().token;
    const old = await f.workspace.write(alice, a.owned.id, { path: reason + ".txt", content: "original", expectedVersion: null });
    f.blobs.afterPut = async () => {
      if (reason === "cancel") await f.runs.cancel(alice, a.run.id);
      else await f.runDb.db.query("UPDATE run_control.runs SET deadline_at=clock_timestamp()-interval '1 second' WHERE id=$1", [a.run.id]);
    };
    const response = await f.call(capability, { tool: "workspace.write", arguments: { path: reason + ".txt", content: "late", expectedVersion: old.version } });
    assert.equal(response.statusCode, 409, response.body); assert.equal(response.json().error.code, "LEASE_LOST");
    f.blobs.afterPut = undefined;
    assert.equal((await f.workspace.read(alice, a.owned.id, reason + ".txt")).content, "original");
    assert.equal((await f.workspace.get(alice, a.owned.id)).usedBytes, reason === "cancel" ? 8 : 16);
  }
  assert.equal((await f.workspaceDb.db.query("SELECT * FROM workspace.blobs WHERE state='staged'")).rows.length, 2);
  await f.workspaceDb.db.query("UPDATE workspace.blobs SET created_at=now()-interval '2 hours' WHERE state='staged'");
  assert.equal(await f.workspace.collectOne(), true); assert.equal(await f.workspace.collectOne(), true);
  assert.equal(Number((await f.workspaceDb.db.query("SELECT reserved_bytes FROM workspace.workspaces")).rows[0]!.reserved_bytes), 0);
});

test("运行工具读取：对象读取期间取消不返回正文，授权服务故障拒绝操作", async t => {
  const f = await fixture(t), a = await f.claim(); const cap = (await a.issue()).json().token;
  await f.workspace.write(alice, a.owned.id, { path: "private.txt", content: "must not leak", expectedVersion: null });
  f.blobs.afterGet = async () => { await f.runs.cancel(alice, a.run.id); };
  const read = await f.call(cap, { tool: "workspace.read", arguments: { path: "private.txt" } });
  assert.equal(read.statusCode, 409); assert.doesNotMatch(read.body, /must not leak/);
  f.blobs.afterGet = undefined;
  const b = await f.claim(), bCap = (await b.issue()).json().token;
  f.blobs.afterPut = async () => { await f.runApp.close(); };
  const response = await f.call(bCap, { tool: "workspace.write", arguments: { path: "unavailable.txt", content: "blocked", expectedVersion: null } });
  assert.equal(response.statusCode, 503, response.body);
  await assert.rejects(f.workspace.read(alice, b.owned.id, "unavailable.txt"), /NOT_FOUND/);
  const puts = f.blobs.puts;
  assert.equal((await f.call(bCap, { tool: "workspace.write", arguments: { path: "other.txt", content: "blocked", expectedVersion: null } })).statusCode, 503);
  assert.equal(f.blobs.puts, puts);
});

test("取消边界：最终授权后的在途提交可能完成，后续调用仍拒绝", async t => {
  const f = await fixture(t), a = await f.claim(), cap = (await a.issue()).json().token;
  const transaction = f.workspaceDb.db.transaction.bind(f.workspaceDb.db);
  let canceled = false;
  f.workspaceDb.db.transaction = work => transaction(tx => work({ query: async (sql, values) => {
    // 模拟最终在线授权返回后、首个可见版本更新之前的取消窗口。
    if (!canceled && sql.startsWith("UPDATE workspace.blobs SET state='live'")) {
      canceled = true; await f.runs.cancel(alice, a.run.id);
    }
    return tx.query(sql, values);
  } }));
  const result = await f.call(cap, { tool: "workspace.write", arguments: { path: "admitted.txt", content: "already authorized", expectedVersion: null } });
  assert.equal(result.statusCode, 200, result.body);
  assert.equal((await f.runs.get(alice, a.run.id)).state, "canceled");
  assert.equal((await f.workspace.read(alice, a.owned.id, "admitted.txt")).content, "already authorized");
  assert.equal((await f.call(cap, { tool: "workspace.read", arguments: { path: "admitted.txt" } })).statusCode, 409);
});

test("授权客户端：不跟随重定向、有界响应、返回关联检查与失败关闭", async t => {
  const reference = { runId: randomUUID(), workerId: "worker-a", leaseId: randomUUID(), attempt: 1 };
  const cap = await signCapability(reference, Math.floor(Date.now() / 1000) + 30);
  const app = Fastify(); let mode = "valid", redirected = 0;
  app.post("/authorization/v1/workspace", async (req, reply) => {
    await workspaceServiceVerifier(authKey)(req.headers.authorization);
    assert.deepEqual(req.body, { ...reference, tool: "workspace.list" });
    if (mode === "redirect") return reply.redirect("/untrusted");
    if (mode === "oversized") return reply.type("application/json").send(" ".repeat(16 * 1024 + 1));
    if (mode === "error") return reply.code(500).send({ secret: "do not expose" });
    return { ...reference, runId: mode === "mismatch" ? randomUUID() : reference.runId, tool: "workspace.list",
      actor: alice, workspaceId: randomUUID(), leaseExpiresAt: new Date(Date.now() + (mode === "expired" ? -1000 : 30_000)).toISOString() };
  });
  app.get("/untrusted", async () => { redirected++; return {}; });
  const runControlUrl = await app.listen({ host: "127.0.0.1", port: 0 }); t.after(() => app.close());
  const authorize = executionAuthorizer({ capabilitySecret: capKey, serviceSecret: authKey, runControlUrl });
  assert.equal((await authorize("Bearer " + cap.token, "workspace.list")).actor.uid, alice.uid);
  for (mode of ["redirect", "oversized", "mismatch", "error"]) {
    await assert.rejects(authorize("Bearer " + cap.token, "workspace.list"), /DEPENDENCY_UNAVAILABLE/);
  }
  assert.equal(redirected, 0);
  mode = "expired";
  await assert.rejects(authorize("Bearer " + cap.token, "workspace.list"), /LEASE_LOST/);
});

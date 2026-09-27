import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { SignJWT } from "jose";
import { createRunControlApp } from "../dsh-agent-run-control/src/app.js";
import { authenticators } from "../dsh-agent-run-control/src/auth.js";
import { RunRepository } from "../dsh-agent-run-control/src/repository.js";
import { createApiApp } from "../dsh-agent-api/src/app.js";
import { serviceClient, chatClient } from "../dsh-agent-api/src/chat-client.js";
import { identityVerifier } from "../dsh-agent-api/src/auth.js";
import { serviceDatabase } from "./workspace-catalog-helpers.js";
import { alice, bob, otherTenant, identity, secret } from "./helpers.js";
const workerSecret = "test-only-runtime-worker-key-separate-32-bytes";
test("运行 HTTP: 前端身份隔离、执行端认证分离、结果查询及拒绝伪造租约", async t => {
  const { pg, db } = await serviceDatabase("run_control"); t.after(() => pg.close());
  const repository = new RunRepository(db), auth = authenticators(secret, workerSecret), iam = await identity();
  const service = createRunControlApp({ repository, authenticateApi: auth.api, authenticateWorker: auth.worker, ready: async () => {} });
  const url = await service.listen({ host: "127.0.0.1", port: 0 });
  const api = createApiApp({ authenticate: identityVerifier(iam.issuer, "agent-platform", iam.key),
    chat: chatClient("http://127.0.0.1:1", secret), runs: serviceClient(url, secret, "dsh-agent-run-control") });
  t.after(async () => { await api.close(); await service.close(); });
  const messageId = randomUUID();
  const run = await repository.accept({ eventId: randomUUID(), eventType: "conversation.message.accepted.v1",
    producer: "dsh-agent-chat", tenantId: alice.tenantId, ownerUid: alice.uid, sessionId: randomUUID(),
    subjectId: messageId, payload: { messageId }, occurredAt: new Date().toISOString(), traceId: "test" });
  const headers = { authorization: "Bearer " + await iam.token() };
  assert.equal((await api.inject({ url: "/api/v1/runs" })).statusCode, 401);
  assert.equal((await api.inject({ url: "/api/v1/runs/" + run.id, headers })).json().state, "queued");
  for (const actor of [bob, otherTenant]) {
    const h = { authorization: "Bearer " + await iam.token(actor), "x-user-id": "alice" };
    assert.deepEqual((await api.inject({ url: "/api/v1/runs", headers: h })).json().items, []);
    assert.equal((await api.inject({ method: "POST", url: "/api/v1/runs/" + run.id + "/cancel", headers: h })).statusCode, 404);
  }
  assert.equal((await api.inject({ method: "POST", url: "/worker/v1/claim", headers })).statusCode, 404);
  assert.equal((await service.inject({ method: "POST", url: "/worker/v1/claim", headers })).statusCode, 401);
  const apiToken = await new SignJWT({ actor: alice }).setProtectedHeader({ alg: "HS256" }).setIssuer("dsh-agent-api")
    .setAudience("dsh-agent-run-control").setIssuedAt().setExpirationTime("30s").sign(new TextEncoder().encode(secret));
  assert.equal((await service.inject({ method: "POST", url: "/worker/v1/claim", headers: { authorization: "Bearer " + apiToken } })).statusCode, 401);
  const workerToken = await new SignJWT({}).setProtectedHeader({ alg: "HS256" }).setIssuer("dsh-agent-runtime-dsh")
    .setAudience("dsh-agent-run-control").setSubject("worker-a").setIssuedAt().setExpirationTime("30s")
    .sign(new TextEncoder().encode(workerSecret));
  const workerHeaders = { authorization: "Bearer " + workerToken };
  assert.equal((await service.inject({ url: "/internal/v1/runs", headers: workerHeaders })).statusCode, 401);
  assert.equal((await service.inject({ method: "POST", url: "/worker/v1/claim", headers: workerHeaders, payload: { uid: bob.uid } })).statusCode, 400);
  const claimed = await service.inject({ method: "POST", url: "/worker/v1/claim", headers: workerHeaders });
  assert.equal(claimed.statusCode, 200, claimed.body);
  const claim = claimed.json().claim;
  const body = { ...claim.lease, state: "succeeded", output: "测试执行结果" };
  const resultPath = "/worker/v1/runs/" + run.id + "/result";
  assert.equal((await service.inject({ method: "POST", url: resultPath, headers: workerHeaders,
    payload: { ...body, leaseId: randomUUID() } })).statusCode, 409);
  assert.equal((await service.inject({ method: "POST", url: resultPath, headers: workerHeaders, payload: body })).statusCode, 200);
  const exposed = await api.inject({ url: "/api/v1/runs/" + run.id, headers });
  assert.equal(exposed.json().output, body.output);
  assert.doesNotMatch(exposed.body, /leaseId|workerId|worker_id/);
  const cancel = await api.inject({ method: "POST", url: "/api/v1/runs/" + run.id + "/cancel", headers });
  assert.equal(cancel.statusCode, 409); assert.equal(cancel.json().error.code, "INVALID_STATE");
  assert.equal((await api.inject({ url: "/api/v1/runs?limit=1000", headers })).statusCode, 400);
});

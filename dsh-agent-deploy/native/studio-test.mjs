// Native Studio acceptance. Uses the existing UI-published local fixture; never prints credentials.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { login, converse } from "./client.mjs";
import { settings, state } from "./platform.mjs";
import { parseFrames } from "../../dsh-agent-web/public/model.mjs";

assert.ok(process.argv.slice(2).every(arg => arg === "--live-model"), "Usage: studio-test.mjs [--live-model]");
const live = process.argv.includes("--live-model");
const origin = "http://localhost:3000";
const report = { startedAt: new Date().toISOString(), liveModel: live, checks: [], complete: false };
const pass = name => { report.checks.push(name); console.log("PASS " + name); };
async function request(token, method, path, body, expected = 200, key) {
  const response = await fetch(origin + "/api/v1" + path, { method, redirect: "error", signal: AbortSignal.timeout(15000),
    headers: { origin, ...(token ? { authorization: "Bearer " + token } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }), ...(key ? { "idempotency-key": key } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  assert.equal(response.status, expected, `${method} ${path.split("?")[0]} returned an unexpected HTTP status`);
  return response.json();
}
async function replay(token, sessionId, runId, after) {
  const capability = await request(token, "POST", `/sessions/${sessionId}/subscription`);
  const controller = new AbortController();
  const frames = [];
  try {
    const response = await fetch(origin + `/events/v1/sessions/${sessionId}`, { redirect: "error",
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]), headers: {
        authorization: "Bearer " + token, "x-session-capability": capability.token, ...(after ? { "last-event-id": after } : {}) } });
    assert.equal(response.status, 200, "Same-origin SSE proxy failed");
    const decoder = new TextDecoder(); let buffer = "";
    for await (const chunk of response.body) {
      buffer += decoder.decode(chunk, { stream: true });
      const parsed = parseFrames(buffer); buffer = parsed.buffer;
      for (const frame of parsed.frames) {
        frames.push(frame);
        if (frame.event.eventType === "run.completed.v1" && frame.event.payload.runId === runId) return frames;
      }
    }
    throw new Error("SSE ended before the terminal event");
  } finally { controller.abort(); }
}
try {
  const config = await settings();
  const adminIndex = config.users.findIndex(user => user.username === "studio-admin");
  assert.ok(adminIndex >= 0, "Enable Studio with studio.mjs setup first");
  const [member, other, admin] = await Promise.all([login(0), login(1), login(adminIndex)]);
  await request(null, "GET", "/studio", undefined, 401);
  const identities = await Promise.all([member, other, admin].map(token => request(token, "GET", "/me")));
  assert.ok(identities.slice(0, 2).every(actor => !actor.roles.includes("tenant-admin")));
  assert.ok(["user", "tenant-admin"].every(role => identities[2].roles.includes(role)));
  pass("Real IAM login, original members unchanged, separate administrator roles");
  const memberStudio = await request(member, "GET", "/studio"), adminStudio = await request(admin, "GET", "/studio");
  assert.ok(memberStudio.enabled && !memberStudio.canPublish && adminStudio.canPublish);
  const metadata = adminStudio.items.find(item => item.slug === "studio-local-check");
  assert.ok(metadata, "Publish the studio-local-check fixture through the UI before running this test");
  const document = await request(member, "GET", `/definitions/${metadata.id}/versions/${metadata.version}`);
  const base = await request(member, "GET", `/definitions/${metadata.base.id}/versions/${metadata.base.version}`);
  assert.deepEqual(document.model, base.model); assert.deepEqual(document.execution, base.execution);
  assert.deepEqual(document.tools, []);
  assert.deepEqual(document.workflow.steps.map(step => step.id), ["draft", "final"]);
  assert.ok(document.skills.some(skill => skill.instructions.includes("STUDIO-SKILL-OK")));
  pass("UI-published workflow persisted; inherited model/budget and custom skill readable by members");
  const proposal = { slug: metadata.slug, expectedVersion: metadata.version - 1, base: metadata.base,
    name: document.name, description: document.description, systemPrompt: document.systemPrompt,
    tools: document.tools, skills: document.skills, workflow: document.workflow };
  await request(member, "POST", "/studio/agents", proposal, 403);
  await request(other, "POST", "/studio/agents", proposal, 403);
  await request(admin, "POST", "/studio/agents", { ...proposal, model: { provider: "override", name: "override" } }, 400);
  pass("Both ordinary members cannot publish; administrator cannot override model configuration");
  const replayed = await request(admin, "POST", "/studio/agents", proposal);
  assert.equal(replayed.id, document.id); assert.equal(replayed.version, document.version);
  await request(admin, "POST", "/studio/agents", { ...proposal, name: document.name + " conflict" }, 409);
  const catalog = await request(member, "GET", "/definitions");
  assert.ok(catalog.items.some(item => item.id === "local-agent" && item.isDefault));
  assert.equal(catalog.items.filter(item => item.id === document.id).length, 1);
  pass("Exact publication replay returns the same immutable version; conflict rejected; default unchanged");
  const key = randomUUID(), selection = { id: document.id, version: document.version };
  const input = { title: "工作台接口验收 · " + new Date().toISOString(), definition: selection };
  const session = await request(member, "POST", "/sessions", input, 201, key);
  assert.equal(session.agentDefinitionId, selection.id); assert.equal(session.agentDefinitionVersion, selection.version);
  assert.equal((await request(member, "POST", "/sessions", input, 201, key)).id, session.id);
  await request(member, "POST", "/sessions", { ...input, definition: metadata.base }, 409, key);
  await request(other, "GET", `/sessions/${session.id}`, undefined, 404);
  await request(other, "POST", `/sessions/${session.id}/subscription`, undefined, 404);
  pass("Same-origin session selection, idempotency binding and cross-user history/subscription denial");
  report.definition = selection; report.sessionId = session.id;
  if (live) {
    const result = await converse(member, session, "/brief-answer\n请用中文简述共享工作流配置为何不会自动授予其他成员的私有文件访问权。这是本地部署验收，不要调用文件或知识库工具。");
    assert.match(result.answer, /STUDIO-SKILL-OK/);
    assert.ok(!result.events.some(event => event.payload?.tool));
    const run = await request(member, "GET", `/runs/${result.runId}`);
    assert.equal(run.state, "succeeded"); assert.equal(run.output, result.answer);
    const workflow = await request(member, "GET", `/runs/${result.runId}/workflow`);
    assert.deepEqual(workflow.steps.map(step => [step.id, step.state]), [["draft", "succeeded"], ["final", "succeeded"]]);
    pass("Real DeepSeek + native DSH skill + two-step workflow + durable final answer");
    const frames = await replay(member, session.id, result.runId);
    assert.ok(frames.some(frame => frame.event.eventType === "run.output.preview.v1"));
    const cutoff = frames.find(frame => frame.event.eventType === "run.status.v1");
    assert.ok(cutoff?.id);
    const resumed = await replay(member, session.id, result.runId, cutoff.id);
    assert.ok(resumed.length > 0 && resumed.every(frame => Number(frame.id.split(":")[1]) > Number(cutoff.id.split(":")[1])));
    pass("Same-origin SSE proxy replays output and resumes strictly after the supplied cursor");
    report.run = { id: result.runId, model: document.model.name, state: run.state, answer: result.answer,
      acceptedMs: result.acceptedMs, firstStatusMs: result.firstStatusMs, firstPreviewMs: result.firstPreviewMs,
      totalMs: result.totalMs, timingScope: "direct API/SSE client, not browser timing",
      steps: workflow.steps, proxyReplayFrames: frames.length, proxyResumedFrames: resumed.length };
  }
  report.complete = true;
} catch (error) {
  // Record only assertion headings/statuses; never include response payloads, tokens or settings.
  report.error = String(error.message).split("\n")[0]; process.exitCode = 1;
  console.error("Studio acceptance failed:", report.error);
} finally {
  report.finishedAt = new Date().toISOString();
  const output = resolve(state, "studio-verification-" + report.startedAt.replace(/[:.]/g, "-") + ".json");
  await writeFile(output, JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
  console.log(JSON.stringify({ complete: report.complete, passed: report.checks.length, output }));
}

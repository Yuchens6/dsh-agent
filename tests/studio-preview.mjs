// Disposable UI fixture only: no platform credentials, PostgreSQL, local IAM or external model access.
// Stop this process to discard all publications and conversations.
import Fastify from "fastify";
import { createWebApp } from "../dsh-agent-web/dist/app.js";
import { AgentDefinition, StudioPublish } from "../dsh-agent-contracts/dist/index.js";
import { randomUUID } from "node:crypto";
const mock = Fastify();
mock.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string" }, (_req, body, done) => done(null, body));
const base = { id: "document-agent", version: 1, name: "文档研究助手", description: "阅读工作区文档、提炼关键内容，将零散资料整理为有据可查的结论。", systemPrompt: "根据用户需求分析文档并简明作答。",
  model: { provider: "deepseek-official", name: "fixture-model" }, tools: ["workspace.list", "workspace.read"],
  skills: [{ id: "brief-answer", version: 1, description: "用简洁清晰的结构表达结论", instructions: "先给出结论，再列出关键依据。" }], execution: { maxTurns: 6, maxOutputTokens: 1024, timeoutSeconds: 90 } };
const workflow = { ...base, id: "review-flow", name: "文档审阅工作流", description: "初稿分析、条件复核和最终整理。每个步骤的权限与预算独立约束。", skills: [],
  workflow: { steps: [{ id: "draft", instructions: "分析", maxTurns: 2, tools: ["workspace.read"] }, { id: "review", instructions: "复核", maxTurns: 2, tools: [], whenPreviousContains: "需要复核" }, { id: "final", instructions: "总结", maxTurns: 1, tools: [] }] } };
const definitions = [base, workflow], studio = [], sessions = [], histories = new Map(), runs = [];
mock.get("/realms/ui-fixture/protocol/openid-connect/auth", async (req, reply) => reply.redirect("http://localhost:3080/callback?" + new URLSearchParams({ state: req.query.state, code: "fixture-code" })));
mock.post("/realms/ui-fixture/protocol/openid-connect/token", async () => ({ access_token: "fixture-access", refresh_token: "fixture-refresh", expires_in: 300 }));
mock.get("/api/v1/me", async () => ({ uid: "ui-admin", tenantId: "ui-fixture（内存演示）", roles: ["tenant-admin"] }));
mock.get("/api/v1/definitions", async () => ({ items: definitions.map(d => ({ id: d.id, version: d.version, name: d.name, description: d.description, tools: d.tools, isDefault: d.id === base.id, kind: d.workflow ? "workflow" : "agent" })) }));
mock.get("/api/v1/definitions/:id/versions/:version", async (req, reply) => definitions.find(d => d.id === req.params.id && d.version === Number(req.params.version)) ?? reply.code(404).send({ error: { code: "NOT_FOUND" } }));
mock.get("/api/v1/studio", async () => ({ enabled: true, canPublish: true, items: studio }));
mock.post("/api/v1/studio/agents", async req => {
  const data = StudioPublish.parse(req.body), template = definitions.find(d => d.id === data.base.id && d.version === data.base.version);
  const { slug, expectedVersion, base: reference, ...content } = data;
  const document = AgentDefinition.parse({ ...template, ...content, id: "ui-" + slug, version: expectedVersion + 1 });
  definitions.push(document); const previous = studio.find(item => item.id === document.id);
  const metadata = { id: document.id, slug: data.slug, version: document.version, base: data.base, updatedBy: "ui-admin", updatedAt: new Date().toISOString() };
  if (previous) Object.assign(previous, metadata); else studio.push(metadata);
  return document;
});
mock.get("/api/v1/sessions", async () => ({ items: sessions, nextCursor: null }));
mock.post("/api/v1/sessions", async req => {
  const session = { id: randomUUID(), title: req.body.title, agentDefinitionId: req.body.definition.id, agentDefinitionVersion: req.body.definition.version, workspaceId: randomUUID(), archived: false, revision: 1, createdAt: new Date().toISOString() };
  sessions.unshift(session); histories.set(session.id, []); return session;
});
mock.get("/api/v1/sessions/:id/history", async req => ({ items: histories.get(req.params.id), nextCursor: null }));
mock.post("/api/v1/sessions/:id/messages", async req => {
  const message = { id: randomUUID(), sessionId: req.params.id, role: "user", content: req.body.content, createdAt: new Date().toISOString() };
  histories.get(req.params.id).push(message);
  const run = { id: randomUUID(), sessionId: req.params.id, messageId: message.id, state: "running", output: null }; runs.unshift(run);
  setTimeout(() => { run.state = "succeeded"; run.output = "这是内存夹具的模拟回答，用于验证页面与状态交互，没有调用真实模型。";
    histories.get(req.params.id).push({ id: randomUUID(), sessionId: req.params.id, role: "assistant", replyToMessageId: message.id, content: run.output }); }, 2000);
  return message;
});
mock.get("/api/v1/runs", async req => ({ items: runs.filter(run => run.sessionId === req.query.sessionId), nextCursor: null }));
mock.get("/api/v1/runs/:id/workflow", async req => { const run = runs.find(item => item.id === req.params.id); return { runId: run.id, state: run.state, enabled: true, steps: [{ id: "draft", state: run.state === "succeeded" ? "succeeded" : "running" }] }; });
mock.post("/api/v1/sessions/:id/subscription", async () => ({ token: "fixture-capability" }));
mock.get("/events/v1/sessions/:id", async (req, reply) => {
  const run = runs.find(item => item.sessionId === req.params.id);
  return reply.type("text/event-stream").send("id: 1\ndata: " + JSON.stringify({ eventType: "run.status.v1", payload: { messageId: run.messageId, runId: run.id, phase: "waiting_model" } }) + "\n\n");
});
const backend = await mock.listen({ host: "127.0.0.1", port: 3081 });
const web = createWebApp({ apiUrl: backend, streamUrl: backend, publicOrigin: "http://localhost:3080", issuer: backend + "/realms/ui-fixture", clientId: "agent-web" });
await web.listen({ host: "127.0.0.1", port: 3080 });
console.log("Disposable UI fixture: http://localhost:3080 (in-memory only; no real identity, database or model)");
const stop = async () => { await web.close(); await mock.close(); };
process.once("SIGINT", () => void stop()); process.once("SIGTERM", () => void stop());

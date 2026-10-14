// Opt-in real-provider smoke test. Never run as part of the offline test suite.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import { ExecutionInput } from "@dsh-agent/contracts";
import { processExecutor } from "../dist/executor.js";

if (process.argv.length !== 3 || process.argv[2] !== "--live") {
  console.error("Explicit consent required: npm run test:live:model -- --live (uses paid model API)");
  process.exit(2);
}
const root = new URL("../../", import.meta.url);
const report = { startedAt: new Date().toISOString(), mode: "real-dsh-child-synthetic-input", tests: [], passed: false };
let key;
try {
  const env = parseEnv(await readFile(new URL(".env", root), "utf8"));
  const select = (native, alias) => {
    if (env[native] && env[alias] && env[native] !== env[alias]) throw new Error("Conflicting model configuration");
    return env[native] || env[alias];
  };
  key = select("DEEPSEEK_API_KEY", "LLM_API_KEY");
  const base = new URL(select("DEEPSEEK_BASE_URL", "LLM_BASE_URL") || "https://api.deepseek.com");
  const model = select("DEEPSEEK_MODEL", "LLM_MODEL");
  assert.ok(key && key.length <= 4096 && model, "Missing model configuration");
  assert.equal(base.origin, "https://api.deepseek.com", "This diagnostic only sends credentials to the official DeepSeek endpoint");
  assert.ok(!base.username && !base.password && !base.search && !base.hash && base.pathname === "/", "Expected a clean provider origin");
  report.endpoint = base.origin; report.model = model;
  console.log(JSON.stringify({ phase: "starting", endpoint: report.endpoint, model, credentials: "configured, hidden" }));
  const execute = processExecutor({ apiKey: key, baseUrl: base.href, maxToolCalls: 2,
    modelRetry: { maxRetries: 0, initialDelayMs: 500, maxDelayMs: 1000 } });
  const stop = new AbortController();
  const interrupt = () => stop.abort();
  process.once("SIGINT", interrupt); process.once("SIGTERM", interrupt);
  const input = (prompt, overrides = {}) => {
    const sessionId = randomUUID(), messageId = randomUUID();
    return ExecutionInput.parse({ runId: randomUUID(), capturedAt: new Date().toISOString(),
      definition: { id: "live-model-smoke", version: 1, name: "Real provider smoke", description: "Synthetic diagnostics only",
        systemPrompt: "Follow this synthetic diagnostic precisely. Return only the requested marker. Never access files, execute commands or request external resources.",
        model: { provider: "deepseek-official", name: model }, tools: [], skills: [],
        execution: { maxTurns: 1, maxOutputTokens: 256, timeoutSeconds: 60 }, ...overrides },
      context: { sessionId, messageId, binding: { workspaceId: randomUUID(), agentDefinitionId: "live-model-smoke", agentDefinitionVersion: 1 },
        truncated: false, messages: [{ id: messageId, sessionId, role: "user", content: prompt, createdAt: new Date().toISOString() }] } });
  };
  async function check(name, data, expected, verify = () => {}) {
    const started = performance.now(), events = [], usage = [];
    const entry = { name, passed: false, elapsedMs: 0, firstTextMs: null, usage, status: [] };
    report.tests.push(entry);
    console.log(JSON.stringify({ phase: "test-start", name }));
    try {
      const output = await execute(data, async () => { throw new Error("Remote tools are forbidden in diagnostics"); },
        AbortSignal.any([stop.signal, AbortSignal.timeout(60_000)]),
        async value => { usage.push(value); }, async value => {
          events.push(value);
          if (value.kind === "text") {
            if (entry.firstTextMs === null) {
              entry.firstTextMs = Math.round(performance.now() - started);
              console.log(JSON.stringify({ phase: "first-text", name, elapsedMs: entry.firstTextMs }));
            }
          } else entry.status.push(value.kind === "workflow" ? { kind: value.kind, stepId: value.stepId, state: value.state } : value);
        });
      entry.actualOutput = output.replaceAll(key, "[REDACTED]").slice(0, 1000);
      assert.equal(output.trim(), expected);
      const startedCalls = usage.filter(value => value.phase === "started");
      const finishedCalls = usage.filter(value => value.phase === "finished");
      assert.ok(startedCalls.length > 0 && startedCalls.length <= data.definition.execution.maxTurns, "Invalid request count");
      assert.deepEqual(finishedCalls.map(value => value.call), startedCalls.map(value => value.call), "Missing final usage reports");
      assert.ok(finishedCalls.every(value => value.tokens !== null), "Missing provider usage");
      verify(events);
      entry.output = expected; entry.passed = true;
    } catch (error) {
      entry.error = stop.signal.aborted ? "CANCELED" : error?.code === "ERR_ASSERTION" ? "ASSERTION_FAILED" : "EXECUTION_FAILED";
      if (entry.error === "ASSERTION_FAILED") return; // Record output mismatch; still exercise the remaining bounded scenarios.
      throw new Error("Smoke test failed");
    } finally {
      entry.elapsedMs = Math.round(performance.now() - started);
      console.log(JSON.stringify(entry));
    }
  }
  try {
    await check("plain-chat", input("Reply exactly OK"), "OK");
    const skills = [{ id: "smoke-check", version: 1, description: "Required for this diagnostic. Load to discover the exact output marker.",
      instructions: "Respond with exactly READY and no other text." }];
    await check("explicit-native-skill", input("/smoke-check Follow the loaded diagnostic instructions.", {
      skills: skills.map(skill => ({ ...skill, invocation: { modelInvocable: false, userInvocable: true } })),
    }), "READY", events => assert.ok(!events.some(event => event.kind === "tool")));
    await check("model-native-skill", input("First call the skill tool with name smoke-check. Then follow its loaded instructions. Do not guess its output marker.", {
      skills, execution: { maxTurns: 3, maxOutputTokens: 256, timeoutSeconds: 60 },
    }), "READY", events => assert.ok(events.some(event => event.kind === "tool" && event.tool === "skill")));
    await check("native-workflow", input("Run the approved diagnostic workflow and follow each step's output instruction.", {
      workflow: { steps: [
        { id: "first", instructions: "Reply exactly FIRST", maxTurns: 1, tools: [] },
        { id: "second", instructions: "Reply exactly READY", maxTurns: 1, tools: [], whenPreviousContains: "FIRST" },
      ] }, execution: { maxTurns: 2, maxOutputTokens: 256, timeoutSeconds: 60 },
    }), "READY", events => assert.deepEqual(events.filter(event => event.kind === "workflow").map(event => [event.stepId, event.state]),
      [["first", "running"], ["first", "succeeded"], ["second", "running"], ["second", "succeeded"]]));
    report.passed = report.tests.length === 4 && report.tests.every(test => test.passed);
    if (!report.passed) process.exitCode = 1;
  } finally {
    stop.abort(); process.removeListener("SIGINT", interrupt); process.removeListener("SIGTERM", interrupt);
  }
} catch {
  // Do not log arbitrary errors: provider/configuration errors can contain credentials or URLs.
  report.error = "LIVE_MODEL_CHECK_FAILED";
  process.exitCode = 1;
} finally {
  report.finishedAt = new Date().toISOString();
  const directory = new URL(".local/model-smoke/", root);
  await mkdir(directory, { recursive: true });
  const path = new URL("latest.json", directory);
  const serialized = JSON.stringify(report, null, 2) + "\n";
  await writeFile(new URL(report.startedAt.replaceAll(/[:.]/g, "-") + ".json", directory), serialized, { mode: 0o600, flag: "wx" });
  await writeFile(path, serialized, { mode: 0o600 });
  console.log(JSON.stringify({ passed: report.passed, reportPath: fileURLToPath(path) }));
}

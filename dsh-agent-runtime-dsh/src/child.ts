import { Start, ToolReply, UsageReply, ProgressReply } from "./protocol.js";
import type { ProgressReporter } from "./progress.js";
import type { UsageReporter } from "./usage.js";
import { runEngine } from "./engine.js";
import { runNativeWorkflow } from "./workflow.js";
import { deepseekProvider } from "./provider.js";
import type { AgentToolCall, AgentToolResult } from "@dsh-agent/contracts";
const stop = new AbortController();
let started = false, id = 0;
let pending: { id: number; resolve: (result: AgentToolResult) => void; reject: () => void } | undefined;
let usageId = 0, usagePending: { id: number; resolve: () => void; reject: () => void } | undefined;
const reportUsage: UsageReporter = report => new Promise((resolve, reject) => {
  if (usagePending || !process.connected) { reject(new Error("Usage channel unavailable")); return; }
  usagePending = { id: ++usageId, resolve, reject: () => reject(new Error("Usage unconfirmed")) };
  process.send?.({ kind: "usage", id: usageId, report }, error => { if (error) { usagePending?.reject(); usagePending = undefined; } });
});
let progressId = 0, progressPending: { id: number; resolve: () => void; reject: () => void } | undefined;
const reportProgress: ProgressReporter = report => new Promise((resolve, reject) => {
  if (stop.signal.aborted || progressPending || !process.connected) { reject(new Error("Progress channel unavailable")); return; }
  progressPending = { id: ++progressId, resolve, reject: () => reject(new Error("Progress unconfirmed")) };
  process.send?.({ kind: "progress", id: progressId, report }, error => { if (error) { progressPending?.reject(); progressPending = undefined; } });
});
const shutdown = () => { stop.abort(); pending?.reject(); usagePending?.reject(); usagePending = undefined; progressPending?.reject(); progressPending = undefined; };
process.on("SIGTERM", shutdown); process.on("SIGINT", shutdown); process.on("disconnect", shutdown);
async function tool(call: AgentToolCall): Promise<AgentToolResult> {
  stop.signal.throwIfAborted();
  if (pending || !process.send) throw new Error("IPC unavailable");
  return new Promise((resolve, reject) => {
    const current = ++id;
    pending = { id: current, resolve, reject: () => reject(new Error("Stopped")) };
    process.send!({ kind: "tool", id: current, call }, error => { if (error) { pending?.reject(); pending = undefined; } });
  });
}
process.on("message", raw => {
  if (!started) {
    const parsed = Start.safeParse(raw);
    if (!parsed.success) { process.exitCode = 1; process.disconnect(); return; }
    started = true;
    const { input, apiKey, baseUrl, maxToolCalls, modelRetry } = parsed.data;
    void (input.definition.workflow ? runNativeWorkflow : runEngine)(input, deepseekProvider(apiKey, baseUrl, modelRetry), tool, stop.signal, maxToolCalls, reportUsage, reportProgress).then(
      output => process.send?.({ kind: "result", output }, () => process.exit(0)),
      () => process.send?.({ kind: "failed" }, () => process.exit(1)),
    );
    return;
  }
  const progress = ProgressReply.safeParse(raw);
  if (progress.success) {
    if (!progressPending || progress.data.id !== progressPending.id) { shutdown(); return; }
    const current = progressPending; progressPending = undefined; current.resolve(); return;
  }
  const usage = UsageReply.safeParse(raw);
  if (usage.success) {
    if (!usagePending || usage.data.id !== usagePending.id) { shutdown(); return; }
    const current = usagePending; usagePending = undefined; current.resolve(); return;
  }
  const reply = ToolReply.safeParse(raw);
  if (!reply.success || !pending || reply.data.id !== pending.id) { shutdown(); return; }
  const current = pending; pending = undefined; current.resolve(reply.data.result);
});

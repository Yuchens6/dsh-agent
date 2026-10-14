import { setTimeout as pause } from "node:timers/promises";
import type { ClaimedRun, ExecutionInput, AgentToolCall, AgentToolResult, FinishRun } from "@dsh-agent/contracts";
import { RuntimeError, type RuntimeClient } from "./client.js";
import type { UsageReporter } from "./usage.js";
import type { ProgressReporter } from "./progress.js";
export type Executor = (input: ExecutionInput, tool: (call: AgentToolCall) => Promise<AgentToolResult>, signal: AbortSignal, reportUsage?: UsageReporter, reportProgress?: ProgressReporter) => Promise<string>;

export async function executeClaim(client: RuntimeClient, claim: ClaimedRun, execute: Executor, stopping: AbortSignal,
  config = { heartbeatMs: 5000, maxToolCalls: 100 }) {
  const canceled = new AbortController();
  let deadline = Date.parse(claim.deadlineAt), leaseEnd = Date.parse(claim.leaseExpiresAt), timedOut = false, lost = false;
  const signal = AbortSignal.any([canceled.signal, stopping]);
  const checkLimits = () => {
    if (Date.now() >= deadline) { timedOut = true; canceled.abort(); }
    else if (Date.now() >= leaseEnd) { lost = true; canceled.abort(); }
  };
  const timer = setInterval(checkLimits, 50);
  const heartbeat = (async () => {
    while (!signal.aborted) {
      try {
        // 先续期，随后根据实际剩余租约调节间隔，兼容服务端短租约。
        leaseEnd = Date.parse((await client.heartbeat(claim, signal)).leaseExpiresAt);
        await pause(Math.max(50, Math.min(config.heartbeatMs, (leaseEnd - Date.now()) / 3)), undefined, { signal });
      } catch { if (!signal.aborted) { lost = true; canceled.abort(); } return; }
    }
  })();
  let result: FinishRun;
  try {
    const input = await client.input(claim, signal);
    if (input.runId !== claim.run.id || input.context.messageId !== claim.run.messageId || input.context.sessionId !== claim.run.sessionId) throw new Error("Input mismatch");
    deadline = Math.min(deadline, Date.now() + input.definition.execution.timeoutSeconds * 1000);
    checkLimits();
    signal.throwIfAborted();
    let toolCalls = 0, toolActive = false;
    const tool: Parameters<Executor>[1] = async call => {
      checkLimits();
      signal.throwIfAborted();
      if (toolActive || ++toolCalls > config.maxToolCalls || !input.definition.tools.includes(call.tool)) { canceled.abort(); throw new RuntimeError("TOOL_DENIED"); }
      toolActive = true;
      try { return await client.tool(claim, call, signal); }
      catch (error) { canceled.abort(); throw error; }
      finally { toolActive = false; }
    };
    const reportUsage: UsageReporter = async report => {
      for (let attempt = 0; ; attempt++) {
        // 终态计量不使用执行取消信号；补记用量不会恢复执行权限。
        if (report.phase === "started") { checkLimits(); signal.throwIfAborted(); }
        try { await client.usage(claim, report, report.phase === "started" ? signal : undefined); return; }
        catch (error) {
          if (attempt >= 2 || error instanceof RuntimeError && error.status === 409) throw error;
          await pause(100 * (attempt + 1));
        }
      }
    };
    let sequence = 0;
    const reportProgress: ProgressReporter = async report => {
      const current = ++sequence;
      for (let attempt = 0; ; attempt++) {
        checkLimits(); signal.throwIfAborted();
        try { await client.progress(claim, current, report, signal); return; }
        catch (error) {
          if (attempt >= 2 || error instanceof RuntimeError && error.status >= 400 && error.status < 500) throw error;
          await pause(100 * (attempt + 1), undefined, { signal });
        }
      }
    };
    const output = await execute(input, tool, signal, reportUsage, reportProgress);
    checkLimits();
    signal.throwIfAborted();
    if (!output || output.length > 32_000 || !output.isWellFormed() || output.includes("\0")) throw new Error("Invalid output");
    result = { ...claim.lease, state: "succeeded", output };
  } catch (error) { result = { ...claim.lease, state: "failed", failureCode: timedOut ? "TIMEOUT" : error instanceof RuntimeError && error.status === 429 ? "QUOTA_EXCEEDED" : "EXECUTION_FAILED" }; }
  finally { clearInterval(timer); canceled.abort(); await heartbeat; }
  if (lost || stopping.aborted) return; // 不宣称进程之外的远程写操作已清空，不发送 release 确认。
  for (let attempt = 0; attempt < 3 && Date.now() < leaseEnd && Date.now() < Date.parse(claim.deadlineAt); attempt++) {
    try { await client.finish(claim, result); return; }
    catch (error) { if (error instanceof RuntimeError && error.status === 409) return; }
    await pause(200 * (attempt + 1)); // 只重传同一终态，不重跑模型或工具。
  }
}

import { SignJWT } from "jose";
import { ModelCallReport } from "@dsh-agent/contracts";
import { WorkflowNext, WorkflowStepResult, UsageRecorded } from "@dsh-agent/contracts";
import { z } from "zod";
import { ClaimResult, ExecutionInput, Run, WorkspaceCapability, WorkspaceToolResult, type ClaimedRun, type FinishRun, type WorkspaceToolCall } from "@dsh-agent/contracts";
export class RuntimeError extends Error {
  constructor(public code: string, public status = 0) { super(code); }
}
export function serviceOrigin(value: string) {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new Error("Expected service origin");
  return url;
}
export function runtimeClient(config: { runControlUrl: string; workspaceUrl: string; workerId: string; secret: string }) {
  const runUrl = serviceOrigin(config.runControlUrl), workspaceUrl = serviceOrigin(config.workspaceUrl), key = new TextEncoder().encode(config.secret);
  if (key.length < 32) throw new Error("Worker key requires at least 32 bytes");
  async function request<T>(url: URL, token: string, data: unknown, schema: z.ZodType<T>, signal?: AbortSignal, timeoutMs = 5000): Promise<T> {
    try {
      const response = await fetch(url, { method: "POST", redirect: "error",
        signal: AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])]),
        headers: { authorization: "Bearer " + token, ...(data === undefined ? {} : { "content-type": "application/json" }) },
        body: data === undefined ? undefined : JSON.stringify(data) });
      if (!response.ok) { await response.body?.cancel(); throw new RuntimeError(response.status === 409 ? "LEASE_LOST" : "REQUEST_FAILED", response.status); }
      const reader = response.body?.getReader(); if (!reader) throw new Error();
      const chunks: Uint8Array[] = []; let size = 0;
      try {
        while (true) { const part = await reader.read(); if (part.done) break;
          size += part.value.byteLength; if (size > 1024 * 1024) throw new Error("Response too large"); chunks.push(part.value); }
      } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
      return schema.parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    } catch (error) { if (error instanceof RuntimeError) throw error; throw new RuntimeError("DEPENDENCY_UNAVAILABLE"); }
  }
  async function control<T>(path: string, data: unknown, schema: z.ZodType<T>, signal?: AbortSignal) {
    const token = await new SignJWT({}).setProtectedHeader({ alg: "HS256", typ: "JWT" }).setIssuer("dsh-agent-runtime-dsh")
      .setAudience("dsh-agent-run-control").setSubject(config.workerId).setIssuedAt().setExpirationTime("30s").sign(key);
    return request(new URL("/worker/v1" + path, runUrl), token, data, schema, signal);
  }
  const path = (claim: ClaimedRun) => "/runs/" + claim.run.id;
  return {
    async claim(signal?: AbortSignal) { return (await control("/claim", undefined, ClaimResult, signal)).claim; },
    input: (claim: ClaimedRun, signal: AbortSignal) => control(path(claim) + "/input", claim.lease, ExecutionInput, signal),
    heartbeat: (claim: ClaimedRun, signal: AbortSignal) => control(path(claim) + "/heartbeat", claim.lease, z.object({ leaseExpiresAt: z.iso.datetime() }).strict(), signal),
    finish: (claim: ClaimedRun, data: FinishRun) => control(path(claim) + "/result", data, Run),
    workflowNext: (claim: ClaimedRun, signal: AbortSignal) => control(path(claim) + "/workflow/next", claim.lease, WorkflowNext, signal),
    workflowResult: (claim: ClaimedRun, stepId: string, output: string, signal: AbortSignal) => control(path(claim) + "/workflow/result", WorkflowStepResult.parse({ lease: claim.lease, stepId, output }), UsageRecorded, signal),
    usage: (claim: ClaimedRun, report: ModelCallReport, signal?: AbortSignal) => control(path(claim) + "/usage", { lease: claim.lease, report: ModelCallReport.parse(report) }, z.object({ recorded: z.literal(true) }).strict(), signal),
    release: (claim: ClaimedRun) => control(path(claim) + "/release", claim.lease, z.object({ released: z.literal(true) }).strict()),
    async tool(claim: ClaimedRun, call: WorkspaceToolCall, signal: AbortSignal) {
      // 不缓存能力，不自动重试写入；未知网络结果必须由上层终止运行并核对文件。
      const cap = await control(path(claim) + "/workspace-capability", claim.lease, WorkspaceCapability, signal);
      const result = await request(new URL("/execution/v1/tools", workspaceUrl), cap.token, call, WorkspaceToolResult, signal, 15_000);
      if (result.tool !== call.tool) throw new RuntimeError("INVALID_TOOL_RESPONSE");
      return result;
    },
  };
}
export type RuntimeClient = ReturnType<typeof runtimeClient>;

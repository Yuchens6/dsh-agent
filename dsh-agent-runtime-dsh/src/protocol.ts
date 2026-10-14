import { z } from "zod";
import { ExecutionInput, AgentToolCall, AgentToolResult, ModelCallReport, RunProgress } from "@dsh-agent/contracts";
import { ModelRetry } from "./retry.js";
export const Start = z.object({ kind: z.literal("start"), input: ExecutionInput,
  apiKey: z.string().min(1).max(4096), baseUrl: z.url(), maxToolCalls: z.number().int().min(1).max(1000),
  modelRetry: ModelRetry.optional() }).strict();
export const ChildMessage = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("result"), output: z.string().min(1).max(32_000) }).strict(),
  z.object({ kind: z.literal("failed") }).strict(),
  z.object({ kind: z.literal("usage"), id: z.number().int().positive(), report: ModelCallReport }).strict(),
  z.object({ kind: z.literal("progress"), id: z.number().int().min(1).max(4096), report: RunProgress }).strict(),
  z.object({ kind: z.literal("tool"), id: z.number().int().positive(), call: AgentToolCall }).strict(),
]);
export const ToolReply = z.object({ kind: z.literal("tool-result"), id: z.number().int().positive(), result: AgentToolResult }).strict();
export const UsageReply = z.object({ kind: z.literal("usage-ack"), id: z.number().int().positive() }).strict();
export const ProgressReply = z.object({ kind: z.literal("progress-ack"), id: z.number().int().positive() }).strict();

import { z } from "zod";
import { ExecutionInput, WorkspaceToolCall, WorkspaceToolResult, ModelCallReport } from "@dsh-agent/contracts";
export const Start = z.object({ kind: z.literal("start"), input: ExecutionInput,
  apiKey: z.string().min(1).max(4096), baseUrl: z.url(), maxToolCalls: z.number().int().min(1).max(1000) }).strict();
export const ChildMessage = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("result"), output: z.string().min(1).max(32_000) }).strict(),
  z.object({ kind: z.literal("failed") }).strict(),
  z.object({ kind: z.literal("usage"), id: z.number().int().positive(), report: ModelCallReport }).strict(),
  z.object({ kind: z.literal("tool"), id: z.number().int().positive(), call: WorkspaceToolCall }).strict(),
]);
export const ToolReply = z.object({ kind: z.literal("tool-result"), id: z.number().int().positive(), result: WorkspaceToolResult }).strict();
export const UsageReply = z.object({ kind: z.literal("usage-ack"), id: z.number().int().positive() }).strict();

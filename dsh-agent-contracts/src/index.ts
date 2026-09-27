import { z } from "zod";

// 协议包只定义线上的数据格式，不包含认证、数据库或服务调用实现。
export const IdentityId = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
export const ResourceId = z.uuid();
export const Principal = z.object({
  uid: IdentityId,
  tenantId: IdentityId,
  roles: z.array(z.string().max(80)).max(100),
}).strict();
export type Principal = z.infer<typeof Principal>;
const QuotaReference = z.object({ runId: ResourceId, actor: Principal }).strict();
export const QuotaClose = QuotaReference.extend({ expectedCalls: z.number().int().min(0).max(50).optional() });
export const QuotaReserve = QuotaReference.extend({ outputTokenBudget: z.number().int().positive().max(1_638_400), deadlineAt: z.iso.datetime(),
  billingModel: z.object({ provider: z.literal("deepseek-official"), name: IdentityId }).strict().optional() });
// 金额及积分最多六位小数；线上使用字符串，计算使用整数微单位。
export const FixedDecimal = z.string().regex(/^(0|[1-9][0-9]{0,11})(\.[0-9]{1,6})?$/);
export const PricingPolicy = z.object({ id: ResourceId, provider: z.literal("deepseek-official"), model: IdentityId,
  currency: z.literal("CNY"), inputPerMillion: FixedDecimal, cacheReadPerMillion: FixedDecimal, outputPerMillion: FixedDecimal,
  pointsPerYuan: FixedDecimal.refine(v => /[1-9]/.test(v), "Positive rate required"),
  reservePointsPerRun: FixedDecimal.refine(v => /[1-9]/.test(v), "Positive hold required") }).strict();
export type PricingPolicy = z.infer<typeof PricingPolicy>;
const FixedBalance = z.string().regex(/^(0|[1-9][0-9]*)\.[0-9]{6}$/);
export const PointsBalance = z.object({ balance: FixedBalance, held: FixedBalance, available: FixedBalance,
  billingEnabled: z.boolean(), pendingRuns: z.number().int().nonnegative() }).strict();
export const PointsLedgerPage = z.object({ items: z.array(z.object({ id: ResourceId, kind: z.enum(["grant","allocate","charge"]),
  delta: z.string().regex(/^-?(0|[1-9][0-9]*)\.[0-9]{6}$/), createdAt: z.iso.datetime(), runId: ResourceId.nullable(),
  attempt: z.number().int().positive().nullable(), call: z.number().int().min(1).max(50).nullable(),
  amountCny: FixedBalance.nullable(), pricingId: ResourceId.nullable() }).strict()), nextCursor: ResourceId.nullable() }).strict();
export const QuotaUsage = z.object({ active: z.number().int().nonnegative(), reservedOutputTokensToday: z.number().int().nonnegative(),
  activeLimit: z.number().int().positive(), dailyOutputTokenLimit: z.number().int().positive(), accounting: z.literal("conservative-reservation") }).strict();
export type QuotaUsage = z.infer<typeof QuotaUsage>;
// DSH 输入词元与缓存命中互斥；推理词元属于输出，不重复相加。
const TokenCount = z.number().int().min(0).max(1_000_000_000);
export const ModelTokens = z.object({ inputTokens: TokenCount, outputTokens: TokenCount,
  cacheReadTokens: TokenCount.optional(), reasoningTokens: TokenCount.optional() }).strict()
  .refine(v => v.reasoningTokens === undefined || v.reasoningTokens <= v.outputTokens, "Invalid reasoning count");
export type ModelTokens = z.infer<typeof ModelTokens>;
export const ModelCallReport = z.discriminatedUnion("phase", [
  z.object({ call: z.number().int().min(1).max(50), phase: z.literal("started") }).strict(),
  z.object({ call: z.number().int().min(1).max(50), phase: z.literal("finished"), tokens: ModelTokens.nullable() }).strict(),
]);
export type ModelCallReport = z.infer<typeof ModelCallReport>;
export const ModelUsageEvent = z.object({ eventId: ResourceId, runId: ResourceId, attempt: z.number().int().positive(),
  actor: Principal, provider: z.literal("deepseek-official"), model: IdentityId, startedAt: z.iso.datetime(),
  report: ModelCallReport }).strict();
export const ModelUsageQuery = z.object({ day: z.iso.date().optional() }).strict();
const DecimalCount = z.string().regex(/^(0|[1-9][0-9]*)$/);
export const ModelUsageSummary = z.object({ day: z.iso.date(), accounting: z.literal("provider-reported"),
  startedCalls: z.number().int().nonnegative(), reportedCalls: z.number().int().nonnegative(),
  unknownCalls: z.number().int().nonnegative(), pendingCalls: z.number().int().nonnegative(),
  inputTokens: DecimalCount, outputTokens: DecimalCount, cacheReadTokens: DecimalCount, reasoningTokens: DecimalCount,
  cacheReadReportedCalls: z.number().int().nonnegative(), reasoningReportedCalls: z.number().int().nonnegative(),
}).strict();
export const RunAuditRecord = z.object({ eventId: ResourceId, occurredAt: z.iso.datetime(), producer: z.literal("dsh-agent-run-control"),
  tenantId: IdentityId, ownerUid: IdentityId, runId: ResourceId, sessionId: ResourceId,
  action: z.enum(["run.accepted", "run.started", "run.completed", "run.failed", "run.canceled"]) }).strict();
export type RunAuditRecord = z.infer<typeof RunAuditRecord>;
export const ChatAuditRecord = z.object({ eventId: ResourceId, occurredAt: z.iso.datetime(), producer: z.literal("dsh-agent-chat"),
  tenantId: IdentityId, ownerUid: IdentityId, sessionId: ResourceId, subjectId: ResourceId,
  action: z.enum(["session.created", "session.updated", "message.accepted", "assistant.projected"]),
  revision: z.number().int().positive().optional(), archived: z.boolean().optional(), runId: ResourceId.optional() }).strict();
export type ChatAuditRecord = z.infer<typeof ChatAuditRecord>;
export const WorkspaceAuditRecord = z.object({ eventId: ResourceId, occurredAt: z.iso.datetime(), producer: z.literal("dsh-agent-workspace"),
  tenantId: IdentityId, ownerUid: IdentityId, workspaceId: ResourceId,
  action: z.enum(["workspace.created", "file.written", "file.deleted"]),
  version: ResourceId.optional(), previousVersion: ResourceId.optional(), sizeBytes: z.number().int().nonnegative().optional() }).strict();
export type WorkspaceAuditRecord = z.infer<typeof WorkspaceAuditRecord>;
export const AuditRecord = z.discriminatedUnion("producer", [RunAuditRecord, ChatAuditRecord, WorkspaceAuditRecord]);
export const AuditProducer = z.enum(["dsh-agent-run-control", "dsh-agent-chat", "dsh-agent-workspace"]);
export type AuditProducer = z.infer<typeof AuditProducer>;
export type AuditRecord = z.infer<typeof AuditRecord>;
export const AuditPage = z.object({ items: z.array(AuditRecord), nextCursor: ResourceId.nullable() }).strict();
export const CreateSession = z.object({
  title: z.string().trim().min(1).max(200),
}).strict();
export const UpdateSession = z.object({ expectedRevision: z.number().int().positive(), title: z.string().trim().min(1).max(200).optional(), archived: z.boolean().optional() }).strict()
  .refine(value => value.title !== undefined || value.archived !== undefined, "At least one change required");
export const SendMessage = z.object({
  content: z.string().trim().min(1).max(32_000),
}).strict();
export const IdempotencyKey = z.string().regex(/^[A-Za-z0-9_-]{8,128}$/);
export const Session = z.object({
  id: ResourceId,
  title: z.string(),
  agentDefinitionId: z.string(),
  agentDefinitionVersion: z.number().int().positive(),
  workspaceId: ResourceId.nullable(),
  archived: z.boolean().default(false), revision: z.number().int().positive().default(1),
  createdAt: z.string(),
}).strict();
export type Session = z.infer<typeof Session>;
export const Message = z.object({
  id: ResourceId,
  sessionId: ResourceId,
  role: z.enum(["user", "assistant"]),
  runId: ResourceId.optional(),
  replyToMessageId: ResourceId.optional(),
  content: z.string(),
  createdAt: z.string(),
}).strict();
export type Message = z.infer<typeof Message>;
export const PageQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  after: ResourceId.optional(),
}).strict();
export const SessionPage = z.object({
  items: z.array(Session), nextCursor: ResourceId.nullable(),
});
export const MessagePage = z.object({
  items: z.array(Message), nextCursor: ResourceId.nullable(),
});
export const Subscription = z.object({
  token: z.string(),
  expiresAt: z.number().int(),
  endpoint: z.string(),
});
export const ErrorCode = z.enum([
  "UNAUTHENTICATED", "NOT_FOUND", "INVALID_REQUEST", "IDEMPOTENCY_CONFLICT",
  "DEPENDENCY_UNAVAILABLE", "INTERNAL_ERROR", "TOO_MANY_CONNECTIONS", "CURSOR_EXPIRED",
  "VERSION_CONFLICT", "QUOTA_EXCEEDED", "FORBIDDEN", "LEASE_LOST", "INVALID_STATE",
]);
export type ErrorCode = z.infer<typeof ErrorCode>;
export const ErrorEnvelope = z.object({
  error: z.object({ code: ErrorCode, message: z.string(), requestId: z.string() }),
});
const eventBase = {
  eventId: ResourceId,
  occurredAt: z.string(),
  producer: z.string(),
  tenantId: IdentityId,
  ownerUid: IdentityId,
  sessionId: ResourceId,
  subjectId: ResourceId,
  traceId: z.string(),
};
// 公共事件使用白名单字段；上游额外字段（工具参数、内部路径、密钥等）会被剔除。
export const PublicEvent = z.discriminatedUnion("eventType", [
  z.object({ ...eventBase, eventType: z.literal("conversation.created.v1"),
    payload: z.object({ sessionId: ResourceId }) }),
  z.object({ ...eventBase, eventType: z.literal("conversation.message.accepted.v1"),
    payload: z.object({ messageId: ResourceId }) }),
  z.object({ ...eventBase, eventType: z.literal("run.output.delta.v1"),
    payload: z.object({ runId: ResourceId, text: z.string().max(32_000) }) }),
  z.object({ ...eventBase, eventType: z.enum(["run.completed.v1", "run.failed.v1", "run.canceled.v1"]),
    payload: z.object({ runId: ResourceId }) }),
]);
export type PublicEvent = z.infer<typeof PublicEvent>;

// 路径是虚拟键，不是宿主路径；拒绝点段、编码分隔符、盘符及控制字符。
export const WorkspacePath = z.string().min(1).max(512).regex(
  /^(?!\.{1,2}(?:\/|$))(?!.*\/\.{1,2}(?:\/|$))[^/\\%:\u0000-\u001f\u007f]+(?:\/[^/\\%:\u0000-\u001f\u007f]+)*$/u,
);
export const Workspace = z.object({
  id: ResourceId, directoryName: IdentityId, usedBytes: z.number().int().nonnegative(),
  fileCount: z.number().int().nonnegative(), createdAt: z.string(),
}).strict();
export type Workspace = z.infer<typeof Workspace>;
export const FileMetadata = z.object({
  path: WorkspacePath, version: ResourceId, sizeBytes: z.number().int().nonnegative(),
  updatedAt: z.string(),
}).strict();
export type FileMetadata = z.infer<typeof FileMetadata>;
export const TextFile = FileMetadata.extend({ content: z.string() });
export const WriteTextFile = z.object({
  path: WorkspacePath, content: z.string().max(65_536), expectedVersion: ResourceId.nullable(),
}).strict();
export const FileQuery = z.object({ path: WorkspacePath }).strict();
export const DeleteFileQuery = FileQuery.extend({ expectedVersion: ResourceId });
export const DeleteFileResult = z.object({ deleted: z.literal(true) }).strict();
export const FileListQuery = z.object({
  prefix: WorkspacePath.optional(), after: WorkspacePath.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
}).strict();
export const FilePage = z.object({ items: z.array(FileMetadata), nextCursor: WorkspacePath.nullable() }).strict();
export const WorkspaceTool = z.enum(["workspace.list", "workspace.read", "workspace.write"]);
export const WorkflowStep = z.object({ id: IdentityId, instructions: z.string().min(1).max(4000),
  maxTurns: z.number().int().min(1).max(50), tools: z.array(WorkspaceTool).max(3),
  whenPreviousContains: z.string().min(1).max(200).optional() }).strict();
export const WorkflowDefinition = z.object({ steps: z.array(WorkflowStep).min(1).max(8) }).strict();
export const AgentDefinition = z.object({
  id: IdentityId, version: z.number().int().positive(), name: z.string().min(1).max(100),
  description: z.string().max(1000), systemPrompt: z.string().min(1).max(16_000),
  model: z.object({ provider: z.literal("deepseek-official"), name: IdentityId }).strict(),
  tools: z.array(WorkspaceTool).max(3),
  skills: z.array(z.object({
    id: IdentityId, version: z.number().int().positive(), instructions: z.string().min(1).max(8000),
  }).strict()).max(10),
  execution: z.object({
    maxTurns: z.number().int().min(1).max(50), maxOutputTokens: z.number().int().min(1).max(32_768),
    timeoutSeconds: z.number().int().min(1).max(120),
  }).strict(),
  workflow: WorkflowDefinition.optional(),
}).strict().superRefine((value, ctx) => {
  if (!value.workflow) return;
  const steps = value.workflow.steps;
  if (new Set(steps.map(s => s.id)).size !== steps.length || steps[0]?.whenPreviousContains !== undefined ||
    steps.reduce((sum, s) => sum + s.maxTurns, 0) > value.execution.maxTurns ||
    steps.some(s => new Set(s.tools).size !== s.tools.length || s.tools.some(tool => !value.tools.includes(tool)) ||
      value.systemPrompt.length + s.instructions.length + 64 > 16_000)) {
    ctx.addIssue({ code: "custom", message: "Invalid workflow identity, budget, tools or prompt size", path: ["workflow"] });
  }
});
export type AgentDefinition = z.infer<typeof AgentDefinition>;
export const DefinitionSummary = z.object({ id: AgentDefinition.shape.id, version: AgentDefinition.shape.version,
  name: AgentDefinition.shape.name, description: AgentDefinition.shape.description, tools: AgentDefinition.shape.tools,
  isDefault: z.boolean() });
export const DefinitionPage = z.object({ items: z.array(DefinitionSummary) }).strict();
export const SessionBinding = z.object({
  workspaceId: ResourceId, agentDefinitionId: IdentityId, agentDefinitionVersion: z.number().int().positive(),
}).strict();
export type SessionBinding = z.infer<typeof SessionBinding>;

export const RunState = z.enum(["queued", "running", "succeeded", "failed", "canceled"]);
export const RunFailure = z.enum(["EXECUTION_FAILED", "TIMEOUT", "LEASE_EXPIRED", "QUOTA_EXCEEDED"]);
export const Run = z.object({
  id: ResourceId, sessionId: ResourceId, messageId: ResourceId, state: RunState,
  attempt: z.number().int().nonnegative(), output: z.string().max(32_000).nullable(),
  failureCode: RunFailure.nullable(), createdAt: z.string(), updatedAt: z.string(),
}).strict();
export type Run = z.infer<typeof Run>;
export const RunPage = z.object({ items: z.array(Run), nextCursor: ResourceId.nullable() }).strict();
export const RunListQuery = PageQuery.extend({ sessionId: ResourceId.optional() });
export const RunRequest = z.object({
  eventId: ResourceId, eventType: z.literal("conversation.message.accepted.v1"),
  producer: z.literal("dsh-agent-chat"), tenantId: IdentityId, ownerUid: IdentityId,
  sessionId: ResourceId, subjectId: ResourceId, occurredAt: z.string(), traceId: z.string().max(128),
  payload: z.object({ messageId: ResourceId }).strict(),
}).strict();
export type RunRequest = z.infer<typeof RunRequest>;
export const RunLease = z.object({ leaseId: ResourceId, attempt: z.number().int().positive() }).strict();
export type RunLease = z.infer<typeof RunLease>;
export const WorkerUsageReport = z.object({ lease: RunLease, report: ModelCallReport }).strict();
export const UsageRecorded = z.object({ recorded: z.literal(true) }).strict();
export const ClaimedRun = z.object({
  run: Run, actor: Principal, lease: RunLease, leaseExpiresAt: z.string(), deadlineAt: z.string(),
}).strict();
export type ClaimedRun = z.infer<typeof ClaimedRun>;
export const ClaimResult = z.object({ claim: ClaimedRun.nullable() }).strict();
export const FinishRun = z.discriminatedUnion("state", [
  RunLease.extend({ state: z.literal("succeeded"), output: z.string().min(1).max(32_000) }).strict(),
  RunLease.extend({ state: z.literal("failed"), failureCode: z.enum(["EXECUTION_FAILED", "TIMEOUT", "QUOTA_EXCEEDED"]) }).strict(),
]);
export type FinishRun = z.infer<typeof FinishRun>;

// 执行输入仅通过持有有效租约的工作进程接口下发，不属于前端查询协议。
export const ExecutionContext = z.object({
  sessionId: ResourceId, messageId: ResourceId, binding: SessionBinding,
  messages: z.array(Message.extend({ content: z.string().min(1).max(32_000) })).min(1).max(40),
  truncated: z.boolean(),
}).strict();
export type ExecutionContext = z.infer<typeof ExecutionContext>;
export const ExecutionInput = z.object({
  runId: ResourceId, context: ExecutionContext, definition: AgentDefinition, capturedAt: z.iso.datetime(),
}).strict();
export type ExecutionInput = z.infer<typeof ExecutionInput>;
export const WorkflowNext = z.discriminatedUnion("complete", [
  z.object({ complete: z.literal(false), step: WorkflowStep, previousOutput: z.string().max(32_000).nullable() }).strict(),
  z.object({ complete: z.literal(true), output: z.string().min(1).max(32_000) }).strict(),
]);
export type WorkflowNext = z.infer<typeof WorkflowNext>;
export const WorkflowStepResult = z.object({ lease: RunLease, stepId: IdentityId, output: z.string().min(1).max(32_000) }).strict();
export const WorkflowProgress = z.object({ runId: ResourceId, state: RunState, enabled: z.boolean(),
  steps: z.array(z.object({ id: IdentityId, state: z.enum(["pending", "running", "succeeded", "skipped", "interrupted"]),
    startedAt: z.iso.datetime().nullable(), completedAt: z.iso.datetime().nullable() }).strict()).max(8) }).strict();
export const AssistantResult = z.object({
  runId: ResourceId, messageId: ResourceId, output: z.string().min(1).max(32_000),
}).strict();
export type AssistantResult = z.infer<typeof AssistantResult>;
export const AssistantMessage = Message.extend({
  role: z.literal("assistant"), runId: ResourceId, replyToMessageId: ResourceId,
});

// 令牌携带租约引用，不接受模型指定用户、租户或工作区。
export const WorkspaceRunReference = RunLease.extend({ runId: ResourceId, workerId: IdentityId }).strict();
export type WorkspaceRunReference = z.infer<typeof WorkspaceRunReference>;
export const WorkspaceCapability = z.object({ token: z.string(), expiresAt: z.number().int().positive() }).strict();
export type WorkspaceCapability = z.infer<typeof WorkspaceCapability>;
export const WorkspaceAuthorizationRequest = WorkspaceRunReference.extend({ tool: WorkspaceTool }).strict();
export type WorkspaceAuthorizationRequest = z.infer<typeof WorkspaceAuthorizationRequest>;
export const WorkspaceAuthorization = WorkspaceAuthorizationRequest.extend({
  actor: Principal, workspaceId: ResourceId, leaseExpiresAt: z.iso.datetime(),
}).strict();
export type WorkspaceAuthorization = z.infer<typeof WorkspaceAuthorization>;
export const WorkspaceToolCall = z.discriminatedUnion("tool", [
  z.object({ tool: z.literal("workspace.list"), arguments: FileListQuery }).strict(),
  z.object({ tool: z.literal("workspace.read"), arguments: FileQuery }).strict(),
  z.object({ tool: z.literal("workspace.write"), arguments: WriteTextFile }).strict(),
]);
export type WorkspaceToolCall = z.infer<typeof WorkspaceToolCall>;
export const WorkspaceToolResult = z.discriminatedUnion("tool", [
  z.object({ tool: z.literal("workspace.list"), result: FilePage }).strict(),
  z.object({ tool: z.literal("workspace.read"), result: TextFile }).strict(),
  z.object({ tool: z.literal("workspace.write"), result: FileMetadata }).strict(),
]);
export type WorkspaceToolResult = z.infer<typeof WorkspaceToolResult>;

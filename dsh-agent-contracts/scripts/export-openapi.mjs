import { writeFile } from "node:fs/promises";
import { z } from "zod";
import * as c from "../dist/index.js";
const names = ["Principal", "CreateSession", "Session", "SessionPage", "SendMessage", "Message",
  "MessagePage", "Subscription", "ErrorEnvelope", "PublicEvent", "Workspace", "FileMetadata", "PointsBalance", "PointsLedgerPage",
  "TextFile", "WriteTextFile", "FilePage", "DeleteFileResult", "AgentDefinition", "DefinitionPage", "Run", "RunPage", "UpdateSession", "QuotaUsage", "AuditPage", "ModelUsageSummary", "WorkflowProgress"];
const schemas = Object.fromEntries(names.map(name => {
  const schema = z.toJSONSchema(c[name], { target: "draft-2020-12" });
  delete schema.$schema;
  return [name, schema];
}));
const ref = name => ({ $ref: "#/components/schemas/" + name });
const json = name => ({ content: { "application/json": { schema: ref(name) } } });
const response = name => ({ description: "成功（Success）", ...json(name) });
const errors = Object.fromEntries([400, 401, 403, 404, 409, 413, 429, 503].map(status =>
  [status, { description: "请求错误（Request error）", ...json("ErrorEnvelope"),
    ...([429,503].includes(status)?{headers:{"Retry-After":{description:"建议重试等待秒数；公开聚合接口过载或限流时提供，重试写入须保留原幂等键。",schema:{type:"integer",minimum:1}}}}:{}) }]));
const id = { in: "path", name: "sessionId", required: true, schema: { type: "string", format: "uuid" } };
const key = { in: "header", name: "Idempotency-Key", required: true,
  schema: { type: "string", pattern: "^[A-Za-z0-9_-]{8,128}$" } };
const page = [
  { in: "query", name: "limit", schema: { type: "integer", minimum: 1, maximum: 100, default: 20 } },
  { in: "query", name: "after", schema: { type: "string", format: "uuid" } },
];
const usageDay = [{ in: "query", name: "day", schema: { type: "string", format: "date" }, description: "UTC（协调世界时）调用开始日期，默认当天。" }];
const operation = (name, status = 200, extra = {}) => ({
  ...extra, responses: { [status]: response(name), ...errors },
});
const workspaceId = { in: "path", name: "workspaceId", required: true, schema: { type: "string", format: "uuid" } };
const filePath = { in: "query", name: "path", required: true, schema: { type: "string", maxLength: 512 },
  description: "虚拟相对路径；不得包含点段、反斜线、百分号、盘符或控制字符。" };
const fileVersion = { in: "query", name: "expectedVersion", required: true, schema: { type: "string", format: "uuid" } };
const document = {
  openapi: "3.1.0", info: { title: "DSH Agent 公共接口（Public API）", version: "0.1.0" },
  security: [{ bearerAuth: [] }],
  paths: {
    "/api/v1/me": { get: operation("Principal") },
    "/api/v1/points": { get: operation("PointsBalance",200,{description:"本人积分余额、冻结、可用及待结算运行数；十进制定点字符串，默认不开启积分计费。"}) },
    "/api/v1/points/ledger": { get: operation("PointsLedgerPage",200,{parameters:page,description:"本人积分入账及扣费流水；已结算项含人民币金额及冻结的计价版本。没有公开发放、分配或扣费接口。"}) },
    "/api/v1/quota": { get: operation("QuotaUsage", 200, { description: "当前用户的并发和保守输出词元预留，不是模型账单。" }) },
    "/api/v1/usage": { get: operation("ModelUsageSummary", 200, { parameters: usageDay, description: "本人模型上报用量，最终一致；待上报与未知用量单独计数。词元总数为十进制字符串，缓存输入与普通输入互斥，推理属于输出子集。不是账单，不退还保守预留。" }) },
    "/api/v1/runs/{runId}/workflow": { parameters: [{ in: "path", name: "runId", required: true, schema: { type: "string", format: "uuid" } }], get: operation("WorkflowProgress",200,{ description: "仅本人步骤进度，不包含中间回答。输入尚未冻结时工作流未加载；运行失败/取消后的活动步骤显示中断，不自动恢复执行。" }) },
    "/api/v1/audit": { get: operation("AuditPage", 200, { parameters: page, description: "仅当前用户的运行、会话及工作区变更审计元数据，无提示词、文件路径、正文或输出文本。" }) },
    "/api/v1/runs": { get: operation("RunPage", 200, { parameters: [...page,
      { in: "query", name: "sessionId", schema: { type: "string", format: "uuid" } }],
      description: "当前用户的运行列表。消息接受到任务入队是异步的，短时间内可能查不到任务。" }) },
    "/api/v1/runs/{runId}": { parameters: [{ in: "path", name: "runId", required: true, schema: { type: "string", format: "uuid" } }],
      get: operation("Run") },
    "/api/v1/runs/{runId}/cancel": { parameters: [{ in: "path", name: "runId", required: true, schema: { type: "string", format: "uuid" } }],
      post: operation("Run", 200, { description: "不带正文。撤销排队/运行任务；运行取消不证明远程进程已停止。终态成功/失败不可取消。" }) },
    "/api/v1/workspaces/ensure": { post: operation("Workspace", 200, {
      description: "为当前身份分配或取得唯一工作区。不接受用户/租户标识；没有请求正文。",
    }) },
    "/api/v1/workspaces/{workspaceId}": { parameters: [workspaceId], get: operation("Workspace") },
    "/api/v1/workspaces/{workspaceId}/files": {
      parameters: [workspaceId], get: operation("FilePage", 200, { parameters: [
        { in: "query", name: "limit", schema: { type: "integer", minimum: 1, maximum: 100, default: 20 } },
        { in: "query", name: "prefix", schema: { type: "string" }, description: "目录前缀，不带末尾斜线；省略表示全部文件。" },
        { in: "query", name: "after", schema: { type: "string" }, description: "上页返回的文件路径游标。" },
      ] }),
    },
    "/api/v1/workspaces/{workspaceId}/file": {
      parameters: [workspaceId],
      get: operation("TextFile", 200, { parameters: [filePath] }),
      put: operation("FileMetadata", 200, {
        description: "UTF-8（统一字符编码）文本，最多 64 KiB。expectedVersion 为 null 时仅创建，否则为读取到的版本；冲突返回 409。",
        requestBody: { required: true, ...json("WriteTextFile") },
      }),
      delete: operation("DeleteFileResult", 200, { parameters: [filePath, fileVersion] }),
    },
    "/api/v1/definitions": { get: operation("DefinitionPage", 200, {
      description: "当前租户获得授权的已发布定义摘要，最多 100 个版本。不允许客户端发布或编辑。",
    }) },
    "/api/v1/definitions/{id}/versions/{version}": {
      parameters: [
        { in: "path", name: "id", required: true, schema: { type: "string" } },
        { in: "path", name: "version", required: true, schema: { type: "integer", minimum: 1 } },
      ],
      get: operation("AgentDefinition"),
    },
    "/api/v1/sessions": {
      get: operation("SessionPage", 200, { parameters: page }),
      post: operation("Session", 201, { parameters: [key], requestBody: { required: true, ...json("CreateSession") } }),
    },
    "/api/v1/sessions/{sessionId}": { parameters: [id], get: operation("Session"), patch: operation("Session", 200, {
      requestBody: { required: true, ...json("UpdateSession") }, description: "标题修改、归档和恢复；expectedRevision 是读取到的修订号，冲突返回 409；归档不取消已接受任务。" }) },
    "/api/v1/sessions/{sessionId}/history": { parameters: [id], get: operation("MessagePage", 200, { parameters: page }) },
    "/api/v1/sessions/{sessionId}/messages": { parameters: [id],
      post: operation("Message", 202, { parameters: [key], requestBody: { required: true, ...json("SendMessage") },
        description:"202 仅表示消息与运行请求已持久化。按认证主体跨副本限制新消息频率与未投递积压；429/503 应按 Retry-After（重试等待时间）退避并复用原幂等键，不能立即无限重试。" }) },
    "/api/v1/sessions/{sessionId}/subscription": { parameters: [id], post: operation("Subscription") },
    "/events/v1/sessions/{sessionId}": { parameters: [id],
      get: {
        description: "服务器发送事件（SSE）。凭据有效期最长 60 秒，到期重新申请订阅凭据并使用游标重连。",
        security: [{ bearerAuth: [], sessionCapability: [] }],
        parameters: [{ in: "header", name: "Last-Event-ID", schema: { type: "string" },
          description: "最后事件标识：sessionId:streamSequence" }],
        responses: { 200: { description: "事件流（Event stream）",
          content: { "text/event-stream": { schema: { type: "string" } } } }, ...errors },
      } },
  },
  components: { schemas, securitySchemes: {
    bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT" },
    sessionCapability: { type: "apiKey", in: "header", name: "X-Session-Capability" },
  } },
};
await writeFile(new URL("../openapi.json", import.meta.url), JSON.stringify(document, null, 2) + "\n");

// 内部执行协议独立成文档，不能据此在公网网关创建路由。
const internalNames = ["RunLease", "ClaimResult", "FinishRun", "ExecutionContext", "ExecutionInput", "AssistantResult", "AssistantMessage",
  "WorkspaceCapability", "WorkspaceAuthorizationRequest", "WorkspaceAuthorization", "WorkspaceToolCall", "WorkspaceToolResult", "WorkerUsageReport", "UsageRecorded", "WorkflowNext", "WorkflowStepResult"];
const internalSchemas = { ...schemas, ...Object.fromEntries(internalNames.map(name => {
  const schema = z.toJSONSchema(c[name], { target: "draft-2020-12" }); delete schema.$schema;
  return [name, schema];
})) };
const workerId = { in: "path", name: "runId", required: true, schema: { type: "string", format: "uuid" } };
const body = name => ({ required: true, ...json(name) });
const internal = {
  openapi: "3.1.0", info: { title: "DSH Agent 内部执行协议（Internal Execution API）", version: "0.1.0",
    description: "worker 与 authorization 路径位于运行控制服务；execution/sessions 位于会话服务；execution/tools 位于工作区服务。不同签发者、受众和独立密钥，严禁公开代理。" },
  security: [{ workerAuth: [] }],
  paths: {
    "/worker/v1/claim": { post: operation("ClaimResult") },
    "/worker/v1/runs/{runId}/workflow/next": { parameters: [workerId], post: operation("WorkflowNext",200,{ requestBody: body("RunLease"), description: "有效租约下启动或返回当前步骤，服务端基于最近成功输出判断条件并记录跳过；不是崩溃后自动恢复授权。" }) },
    "/worker/v1/runs/{runId}/workflow/result": { parameters: [workerId], post: operation("UsageRecorded",200,{ requestBody: body("WorkflowStepResult"), description: "幂等保存当前步骤输出；至少一次模型调用且计量报告完整到达。只重传结果，不重跑步骤。" }) },
    "/worker/v1/runs/{runId}/usage": { parameters: [workerId], post: operation("UsageRecorded", 200, { requestBody: body("WorkerUsageReport"), description: "开始调用必须持有有效租约；最终计量允许同一执行身份在租约失效后补报已经开始的调用，不恢复执行权限。同一调用最终数据不可改写。" }) },
    "/worker/v1/runs/{runId}/input": { parameters: [workerId], post: operation("ExecutionInput", 200, { requestBody: body("RunLease") }) },
    "/worker/v1/runs/{runId}/workspace-capability": { parameters: [workerId], post: operation("WorkspaceCapability", 200, { requestBody: body("RunLease"),
      description: "仅有效租约且已保存输入快照、定义允许工具时签发。令牌最长三十秒，不超过当前租约和运行截止时间。" }) },
    "/authorization/v1/workspace": { post: operation("WorkspaceAuthorization", 200, { security: [{ workspaceServiceAuth: [] }], requestBody: body("WorkspaceAuthorizationRequest") }) },
    "/execution/v1/tools": { post: operation("WorkspaceToolResult", 200, { security: [{ workspaceCapability: [] }], requestBody: body("WorkspaceToolCall"),
      description: "列目录、读取和条件写入；用户/租户/工作区由运行控制解析。每次在线授权，写入提交前再次授权。不是跨服务原子撤销，最终授权后的在途提交仍可能完成。" }) },
    "/worker/v1/runs/{runId}/result": { parameters: [workerId], post: operation("Run", 200, { requestBody: body("FinishRun") }) },
    "/worker/v1/runs/{runId}/heartbeat": { parameters: [workerId], post: { requestBody: body("RunLease"), responses: {
      200: { description: "续期后的到期时间", content: { "application/json": { schema: { type: "object", required: ["leaseExpiresAt"], properties: { leaseExpiresAt: { type: "string", format: "date-time" } } } } } }, ...errors,
    } } },
    "/worker/v1/runs/{runId}/release": { parameters: [workerId], post: { requestBody: body("RunLease"), responses: {
      200: { description: "取消后的停止确认", content: { "application/json": { schema: { type: "object", required: ["released"], properties: { released: { const: true } } } } } }, ...errors,
    } } },
    "/execution/v1/sessions/{sessionId}/messages/{messageId}/context": { parameters: [id,
      { in: "path", name: "messageId", required: true, schema: { type: "string", format: "uuid" } }],
      get: operation("ExecutionContext", 200, { security: [{ runControlAuth: [] }] }) },
    "/execution/v1/sessions/{sessionId}/assistant-results": { parameters: [id],
      post: operation("AssistantMessage", 200, { security: [{ runControlAuth: [] }], requestBody: body("AssistantResult") }) },
  }, components: { schemas: internalSchemas, securitySchemes: {
    workerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT", description: "执行服务签发，受众为运行控制；主体为执行节点。" },
    runControlAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT", description: "运行控制签发，受众为会话服务；携带经授权的用户主体。" },
    workspaceServiceAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT", description: "工作区服务签发，独立授权查询凭据，执行器不可持有。" },
    workspaceCapability: { type: "http", scheme: "bearer", bearerFormat: "JWT", description: "运行控制签发的三十秒运行能力令牌，不能调用文件管理接口。" },
  } },
};
await writeFile(new URL("../execution-openapi.json", import.meta.url), JSON.stringify(internal, null, 2) + "\n");
const supportSchemas = Object.fromEntries(["QuotaReserve", "QuotaClose", "QuotaUsage", "AuditRecord", "AuditPage", "ErrorEnvelope", "ModelUsageEvent", "ModelUsageSummary", "PointsBalance", "PointsLedgerPage"].map(name => {
  const schema = z.toJSONSchema(c[name]); delete schema.$schema; return [name, schema];
}));
const ack = field => ({
  responses: {
    200: {
      description: "幂等确认",
      content: { "application/json": { schema: {
        type: "object", required: [field], additionalProperties: false, properties: { [field]: { const: true } },
      } } },
    },
    ...errors,
  },
});
const support = { openapi: "3.1.0", info: { title: "配额与审计内部协议（Support API）", version: "0.1.0" },
  security: [{ controlAuth: [] }], paths: {
    "/control/v1/reserve": { post: { requestBody: body("QuotaReserve"), ...ack("reserved"), description: "预留保守输出预算；开启积分后冻结模型计价版本与员工积分，缺价或余额不足不放行。不退还当日词元预算。" } },
    "/control/v1/close": { post: { requestBody: body("QuotaClose"), ...ack("closed"), description: "释放并发；未知运行保留关闭墓碑。expectedCalls 是运行控制确定的调用总数，全部计量结清后才释放积分余留。" } },
    "/control/v1/usage": { post: { requestBody: body("ModelUsageEvent"), ...ack("recorded"), description: "运行控制提供已验证调用元数据；核对预留所有者，乱序去重。已有积分快照的运行按次原子扣费，未知用量/不足余额保留待结算；确认只表示可靠入库。" } },
    "/control/v1/records": { post: { security: [{ producerAuth: [] }], requestBody: body("AuditRecord"), ...ack("recorded"), description: "位于审计服务。接收运行、会话及工作区变更元数据白名单；生产者必须与验证后的签发身份一致，同事件标识的不同正文冲突。" } },
    "/internal/v1/quota": { get: operation("QuotaUsage", 200, { security: [{ apiAuth: [] }] }) },
    "/internal/v1/points": { get: operation("PointsBalance",200,{security:[{apiAuth:[]}]}) },
    "/internal/v1/points/ledger": { get: operation("PointsLedgerPage",200,{security:[{apiAuth:[]}],parameters:page}) },
    "/internal/v1/usage": { get: operation("ModelUsageSummary", 200, { security: [{ apiAuth: [] }], parameters: usageDay }) },
    "/internal/v1/audit": { get: operation("AuditPage", 200, { security: [{ apiAuth: [] }], parameters: page }) },
  }, components: { schemas: supportSchemas, securitySchemes: {
    controlAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT", description: "运行控制签发，配额和审计使用不同受众及不同密钥；不能被执行器凭据替代。" },
    producerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT", description: "运行控制、会话、工作区分别使用独立密钥签发，只允许写入自身生产者记录；不能用于本人查询。" },
    apiAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT", description: "前端聚合服务签发，携带已验证用户，只能查询本人数据，不能预留或写审计。" },
  } } };
await writeFile(new URL("../support-openapi.json", import.meta.url), JSON.stringify(support, null, 2) + "\n");

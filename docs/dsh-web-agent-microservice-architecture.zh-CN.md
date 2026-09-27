# 基于 DeepSeek Harness 的多租户 Web Agent 微服务架构设计

> 文档状态：架构基线  
> 适用阶段：可实施设计、项目拆分、开发排期、部署评审  
> 核心目标：构建基于 DeepSeek Harness 的多租户 Web Agent 系统，使每个用户只能访问自己的会话与工作区，并支持在 Kubernetes 中按负载扩容，而不是为每个注册用户永久创建一个 Pod。

## 1. 文档目的

本文档用于统一产品、后端、平台、安全和运维团队对系统边界的理解，明确：

- 系统由哪些服务组成；
- 每个服务的项目名、职责和禁止承担的职责；
- 每类数据由哪个服务拥有；
- 服务之间采用哪些同步接口和异步事件；
- DeepSeek Harness（深度求索智能体执行框架，简称 DSH）被封装在哪一层；
- 如何实现用户身份、会话、工作区和文件隔离；
- 如何避免共享数据库、共享业务代码和分布式事务造成的耦合；
- 第一阶段如何落地，以及后续如何扩容。

本文所称“用户不能使用 Bash（命令解释器）、MCP（模型上下文协议）、Code Mode（代码执行模式）或自行安装插件”，是当前安全设计成立的重要前提。未来开放这些能力时，必须增加独立执行沙箱。

## 2. 架构原则

1. **数据所有权唯一**：每类核心数据只有一个权威服务，其他服务不得直接读取其数据表。
2. **DSH 实现不外泄**：只有执行工作服务依赖 DSH SDK（软件开发工具包）、插件协议和原生事件。
3. **认证与授权分离**：身份服务回答“用户是谁”，资源所属服务回答“用户能否操作该资源”。
4. **路径不是权限凭据**：服务间不依靠 `/workspaces/<uid>` 字符串证明权限，而使用短期 Capability Token（能力令牌）。
5. **异步优先**：必须立即得到结果的操作使用同步接口，已发生的业务事实使用事件传播。
6. **不使用分布式事务**：跨服务流程使用 Saga（分布式补偿事务）、状态机和补偿动作。
7. **至少一次投递、幂等消费**：使用 Transactional Outbox（事务发件箱）、Inbox Deduplication（收件箱去重）和 Idempotency Key（幂等键）。
8. **失败关闭**：身份、归属、能力令牌、文件路径或 Worker Lease（工作节点租约）无法确认时一律拒绝。

## 3. 总体架构

```text
                         Internet（互联网）
                                │
                    Ingress / WAF（入口网关/防火墙）
                                │
                     dsh-agent-api（前端聚合服务）
                  ┌─────────────┼─────────────┐
                  │             │             │
           dsh-agent-iam   dsh-agent-chat   dsh-agent-workspace
            身份访问服务      会话消息服务       工作区服务
                                │                  │
                         message.accepted          │
                                ↓                  │
                    NATS JetStream（事件流）       │
                                ↓                  │
                      dsh-agent-run-control ───────┘
                         运行控制服务
                                │
                         调度与运行租约
                                │
                       dsh-agent-runtime-dsh
                         DSH 执行工作服务
                                │
                  Remote Rooted FS Provider
                    远程根目录文件系统提供器
                                │
                      dsh-agent-workspace

DSH 执行事件 ──→ NATS JetStream ──→ dsh-agent-stream ──→ Browser（浏览器）
                                      │
                                      ├──→ dsh-agent-quota
                                      └──→ dsh-agent-audit
```

系统分为：

- Control Plane（控制面）：身份、前端聚合、会话、智能体定义、运行控制、配额和审计；
- Data Plane（数据面）：DSH 执行工作服务、工作区文件访问和流式事件传输。

DSH 执行工作服务不对互联网开放，只接受运行控制服务的内部请求。

## 4. 服务与项目清单

| 项目名 | 中文名称 | 类型 | 核心职责 |
|---|---|---|---|
| `dsh-agent-edge` | 智能体边缘接入项目 | 基础设施 | 域名、TLS、入口路由、基础限流和网络防护 |
| `dsh-agent-iam` | 身份与访问管理服务 | 核心服务 | 登录、令牌、用户、租户和平台角色 |
| `dsh-agent-api` | 智能体前端聚合服务 | 核心服务 | 面向 Web 前端的统一业务接口 |
| `dsh-agent-chat` | 智能体会话消息服务 | 核心服务 | 会话、消息、归属关系和历史记录 |
| `dsh-agent-catalog` | 智能体定义中心 | 核心服务 | Agent Preset（智能体预设）、工具、技能和工作流版本 |
| `dsh-agent-workspace` | 智能体工作区服务 | 核心服务 | 工作区归属、文件、版本、快照和能力令牌 |
| `dsh-agent-run-control` | 智能体运行控制服务 | 核心服务 | Run（运行任务）、调度、租约、取消和恢复 |
| `dsh-agent-runtime-dsh` | DSH 执行工作服务 | 数据面服务 | 封装 DSH SDK 并实际执行智能体 |
| `dsh-agent-stream` | 智能体事件流网关 | 数据面服务 | SSE（服务器发送事件）/WebSocket（网页双向通信）推送 |
| `dsh-agent-quota` | 智能体配额与用量服务 | 支撑服务 | 并发、Token（令牌计量）、存储和预算 |
| `dsh-agent-audit` | 智能体审计服务 | 支撑服务 | 不可变审计记录、查询和合规导出 |
| `dsh-agent-contracts` | 智能体公共协议项目 | 代码库，不部署 | 接口定义、事件结构、错误码和生成代码 |
| `dsh-agent-deploy` | 智能体部署工程 | 基础设施 | Kubernetes、Helm（应用打包工具）和可观测性配置 |

`dsh-agent-contracts` 只能保存协议，不得保存业务逻辑、数据库访问代码或 DSH 实现。

## 5. 服务详细设计

### 5.1 `dsh-agent-edge`：智能体边缘接入项目

**负责：**

- TLS（传输层安全协议）证书终止；
- 域名、路径和版本路由；
- WAF（Web 应用防火墙）；
- 请求体大小、连接数和基础频率限制；
- CORS（跨源资源共享）和安全响应头；
- 普通接口转发到 `dsh-agent-api`；
- 事件连接转发到 `dsh-agent-stream`；
- 阻止互联网访问 DSH Worker（DSH 工作节点）和内部服务。

**不负责：**密码校验、会话所有权、工作区所有权、业务配额和 Agent 调度。

**推荐实现：**Kubernetes Ingress（Kubernetes 入口控制器）配合 Nginx、Envoy 或 APISIX。

### 5.2 `dsh-agent-iam`：身份与访问管理服务

**负责：**

- 注册、登录和退出；
- JWT（JSON Web Token，JSON 网络令牌）签发、刷新和吊销；
- Tenant（租户）、用户和租户成员关系；
- 平台级 Role（角色）；
- OIDC（开放身份连接）/OAuth 2.0（开放授权协议）接入；
- 登录安全审计。

**不负责：**判断会话、工作区或运行任务是否属于用户，也不保存 Agent Session（智能体会话）。

**权威数据：**`users`、`tenants`、`tenant_members`、`roles`、`refresh_tokens`、`login_audits`。

**输出身份：**

```json
{
  "sub": "user-1001",
  "tenantId": "tenant-a",
  "roles": ["user"],
  "aud": "agent-platform",
  "exp": 1788000000
}
```

第一阶段可采用 Keycloak（开源身份与访问管理平台），项目保存 Realm（身份域）配置、主题和部署文件。

### 5.3 `dsh-agent-api`：智能体前端聚合服务

BFF（Backend for Frontend，面向前端的后端）是浏览器唯一可调用的业务入口。

**负责：**

- 验证访问令牌并建立可信 Principal（调用主体）；
- 请求参数、分页和接口版本兼容；
- 聚合会话、运行、工作区和用量信息；
- 接收 `Idempotency-Key`（幂等键）；
- 将内部错误转换为稳定的前端错误；
- 协调文件上传和下载；
- 签发短期事件订阅凭据。

**不负责：**

- 直接访问业务数据库；
- 保存会话所有权；
- 拼接宿主机文件路径；
- 直接调用 DSH 原生 Web/RPC（远程过程调用）；
- 接受前端提交的完整 Preset、工具列表或权限模式。

**对外接口：**

```text
GET    /api/v1/me
POST   /api/v1/sessions
GET    /api/v1/sessions
GET    /api/v1/sessions/{sessionId}
DELETE /api/v1/sessions/{sessionId}
POST   /api/v1/sessions/{sessionId}/messages
POST   /api/v1/runs/{runId}/cancel
GET    /api/v1/sessions/{sessionId}/history
POST   /api/v1/workspaces/{workspaceId}/files
GET    /api/v1/workspaces/{workspaceId}/files
GET    /api/v1/workspaces/{workspaceId}/files/content
DELETE /api/v1/workspaces/{workspaceId}/files
```

该服务无状态，可直接水平扩容。

### 5.4 `dsh-agent-chat`：智能体会话消息服务

该服务是产品侧会话和消息的权威来源。DSH Session 只是执行投影，不是产品数据真相。

**负责：**

- 创建、查询、重命名、归档和删除会话；
- Session Ownership（会话所有权）；
- 用户消息持久化；
- 助手消息和工具摘要的事件投影；
- Fork（派生会话）关系；
- 会话标题和 Agent Definition Version（智能体定义版本）；
- 签发 Session Capability（会话能力令牌）。

**不负责：**执行模型请求、分配 Worker、读写文件或保存 DSH 进程状态。

**权威数据：**`conversations`、`conversation_messages`、`conversation_forks`、`conversation_outbox`、`conversation_inbox`。

**核心约束：**

- 所有查询同时包含 `tenant_id` 和 `owner_uid`；
- 会话固定引用 `agent_definition_id + agent_definition_version`；
- 用户消息与 Outbox Event（发件箱事件）在同一 PostgreSQL 事务中提交；
- 同一 `session_id + idempotency_key` 只能接受一次消息。

**领域事件：**

- `conversation.created.v1`：会话已创建；
- `conversation.message.accepted.v1`：用户消息已持久化；
- `conversation.archived.v1`：会话已归档；
- `conversation.deleted.v1`：会话已进入删除流程。

### 5.5 `dsh-agent-catalog`：智能体定义中心

**负责：**

- Agent Definition（智能体定义）；
- System Prompt（系统提示词）版本；
- Tool Allowlist（工具白名单）；
- Skill（技能）绑定；
- Workflow（工作流）定义；
- 模型选择策略；
- 最大轮数、超时和输出限制；
- 配置发布、回滚和灰度；
- 定义的安全校验和签名。

**不负责：**运行 Agent、修改正在运行的会话、接收普通用户插件/MCP/Skill 或保存用户消息。

会话必须引用不可变版本，例如 `document-agent@3`。`latest`（最新版本）只能用于新建会话时解析。

**安全基线示例：**

```json
{
  "id": "document-agent",
  "version": 3,
  "tools": [
    "workspace.read",
    "workspace.list",
    "workspace.write",
    "workspace.edit"
  ],
  "disabledCapabilities": [
    "bash",
    "terminal",
    "run_code",
    "mcp",
    "plugin_install"
  ],
  "maxRounds": 30,
  "timeoutSeconds": 900
}
```

### 5.6 `dsh-agent-workspace`：智能体工作区服务

该服务是工作区文件权限的最终权威边界。

**负责：**

- 创建用户默认工作区；
- Workspace Ownership（工作区所有权）；
- 虚拟目录、文件元数据和内容；
- 上传、下载、列表、读取、写入和编辑；
- 文件版本、快照、软删除和容量统计；
- 签发 Workspace Capability（工作区能力令牌）；
- 路径规范化和越权拒绝；
- 文件内容保存到 MinIO/S3（对象存储），元数据保存到 PostgreSQL。

**不负责：**执行 Agent、保存聊天消息、信任调用方提交的 UID/宿主机路径，或把 MinIO Bucket（对象存储桶）暴露给浏览器和 Worker。

**内部接口：**

```text
POST /internal/v1/fs/resolve
POST /internal/v1/fs/stat
POST /internal/v1/fs/list
POST /internal/v1/fs/read
POST /internal/v1/fs/write
POST /internal/v1/fs/edit
POST /internal/v1/fs/delete
```

**能力令牌：**

```json
{
  "workspaceId": "ws-1001",
  "uid": "user-1001",
  "sessionId": "session-1",
  "runId": "run-1",
  "permissions": ["read", "write"],
  "aud": "workspace-service",
  "exp": 1788000100
}
```

令牌有效期建议不超过十分钟，必须包含 Audience（目标受众）、Run ID（运行标识）和具体权限。

**路径规则：**

- 只接受相对路径；
- 拒绝盘符、以 `/` 开头的路径、`..`、空字节和非法 Unicode（统一码）；
- 禁止符号链接和硬链接；
- 每次操作从 `workspace_id` 开始解析；
- 读取、搜索、图片和附件走同一权限路径；
- 写入和编辑采用 Optimistic Concurrency Control（乐观并发控制）；
- 无法确认版本或权限时拒绝操作。

当前阶段 Worker 不挂载共享 `/workspaces`，而通过 Remote Rooted FS Provider（远程根目录文件系统提供器）调用该服务，从结构上避免读取同机其他用户目录。

### 5.7 `dsh-agent-run-control`：智能体运行控制服务

第一阶段将 Orchestrator（编排器）和 Scheduler（调度器）合并，减少部署和同步依赖；调度吞吐成为独立瓶颈后再拆分。

**负责：**

- 消费 `conversation.message.accepted.v1`；
- 创建 Run（运行任务）和 Attempt（执行尝试）；
- 向配额服务预留资源；
- 获取不可变 Agent Definition；
- 申请 Workspace Capability；
- 选择 DSH Worker；
- 签发和续约 Worker Lease；
- 启动、取消、超时和终止任务；
- Worker 故障检测和恢复；
- Run 状态机、用量结算和最终事件。

**不负责：**保存完整用户消息、直接读取文件、理解 DSH 原生事件或暴露 Worker 地址。

**运行状态机：**

```text
ACCEPTED（已接受）
    ↓
QUOTA_RESERVED（已预留配额）
    ↓
QUEUED（排队中）
    ↓
DISPATCHED（已派发）
    ↓
RUNNING（运行中）
 ┌──┴──────────┐
 ↓             ↓
COMPLETED     CANCELING
已完成          取消中
 ↓             ↓
FAILED        CANCELED
已失败          已取消
```

**调度与租约：**

- 使用 PostgreSQL `FOR UPDATE SKIP LOCKED` 实现多实例无主调度；
- 每次派发产生新的 `attempt_id` 和短期 `lease_token`；
- Worker 定期上报 Heartbeat（心跳）；
- 只接受当前 Attempt 和 Lease 的事件；
- Lease 过期后拒绝旧 Worker 的迟到事件；
- 已产生文件副作用且结果不确定的任务不盲目重试，标记 `UNKNOWN`（结果不确定）。

**领域事件：**`run.queued.v1`、`run.started.v1`、`run.completed.v1`、`run.failed.v1`、`run.canceling.v1`、`run.canceled.v1`、`run.lease.expired.v1`。

### 5.8 `dsh-agent-runtime-dsh`：DSH 执行工作服务

这是唯一直接依赖 DeepSeek Harness 的服务。

**负责：**

- 加载审核后的固定 DSH Composition（DSH 组合配置）；
- 使用 DSH SDK 创建、恢复和运行 Session；
- 调用模型；
- 使用 Remote Rooted FS Provider 访问工作区；
- 将 DSH 内部事件转换为平台 Agent Event（智能体事件）；
- 执行取消和超时；
- 上报 Worker Heartbeat、负载和 Token Usage（令牌用量）；
- 控制单 Worker 最大并发。

**不负责：**认证外部用户、查询业务数据库、决定资源所有权、允许用户安装插件/Skill/MCP，或暴露 DSH Web UI（网页界面）与原生 RPC。

**固定安全配置：**

- 禁用 Bash、PowerShell、Terminal 和 Code Mode；
- 禁用用户 MCP、插件安装和动态 Preset；
- 禁用本地 `fs-local` 文件系统提供器；
- 只注册服务端批准的工具；
- 文件搜索通过 Workspace Service，不能调用宿主机 `grep`；
- 模型不能切换到 `danger-full-access`（危险的完全访问模式）；
- Worker 镜像、插件和依赖锁定版本与摘要。

Worker 按活跃 Run 数量扩容，不按注册用户数创建。未来开放 Bash、MCP 或用户代码后，再引入 Sandbox Manager（沙箱管理器），为活跃 Run 创建短生命周期微虚机或 Pod。

### 5.9 `dsh-agent-stream`：智能体事件流网关

**负责：**

- 提供 SSE 和可选 WebSocket；
- 验证身份和 Session Capability；
- 从 NATS JetStream 订阅平台事件；
- 按 Session 过滤事件；
- 事件序号、心跳和断线重连；
- `Last-Event-ID`（最后事件标识）续传；
- Backpressure（背压）和慢消费者断开；
- 对工具参数、内部路径和密钥脱敏。

**不负责：**直接连接 Worker、执行模型、保存所有权或修改 Run 状态。

**对外接口：**

```text
GET /events/v1/sessions/{sessionId}
```

### 5.10 `dsh-agent-quota`：智能体配额与用量服务

**负责：**

- 用户和租户并发任务数；
- 每日、每月 Token 和费用预算；
- 单任务最大时间和轮数；
- Workspace Storage Quota（工作区存储配额）；
- Reserve（预留）、Settle（结算）和 Release（释放）；
- 用量账本和套餐规则。

高频计数保存在 Redis，最终账本保存在 PostgreSQL。配额先预留再执行，避免并发请求同时穿透上限。

实施补充（第十一阶段）：当前配额与积分直接使用 PostgreSQL 行锁及事务，不依赖 Redis。
同一服务拥有公司未分配余额、员工独立积分、模型计价版本、运行冻结和按次扣费账本；运行控制只提供可信用量及调用总数，聚合服务只代理本人查询。
公司积分先分配给员工，不共用随机消费池；按实际报告用量乘配置单价，再按配置比例换算积分。
支付充值、退款与公司管理员授权尚未实现，默认不开启积分计费。具体协议、精度、启用流程与风险见 [积分计费说明](points-billing.zh-CN.md)。

实施补充（第十二阶段）：前端聚合服务限制本副本在途请求；会话服务用自身数据库执行跨副本新消息限流和未投递积压保护；
运行控制实施全局、公司、用户调度并发及等待老化，执行服务使用固定数量执行槽。配额服务仍最终裁决预算及积分。
服务间不读取彼此的容量表，调度限制不等于完整配额感知排队。消息消费分片、全局队列容量和万级端到端验收尚未完成，见 [高并发说明](high-concurrency.zh-CN.md)。

### 5.11 `dsh-agent-audit`：智能体审计服务

**负责：**

- 消费身份、会话、运行、文件和安全事件；
- 保存不可变审计记录；
- 管理员检索和合规导出；
- 异常访问检测；
- 数据保留和归档。

审计服务不参与主请求授权，写入失败不能阻塞 Agent。不得保存访问令牌、Cookie（浏览器会话凭据）、模型密钥或不必要的文件内容。

## 6. 数据所有权与数据库隔离

| 数据 | 唯一所有者 | 其他服务访问方式 |
|---|---|---|
| 用户、租户、角色 | `dsh-agent-iam` | JWT、身份接口 |
| 会话、消息、归属 | `dsh-agent-chat` | 接口、领域事件、能力令牌 |
| 智能体定义和版本 | `dsh-agent-catalog` | 版本接口、只读缓存 |
| 工作区和文件 | `dsh-agent-workspace` | 文件接口、能力令牌 |
| Run、Attempt、Lease | `dsh-agent-run-control` | 内部接口、领域事件 |
| DSH 进程内状态 | `dsh-agent-runtime-dsh` | Worker 协议、标准事件 |
| 配额、预留和用量 | `dsh-agent-quota` | Reserve/Settle 接口、用量事件 |
| 审计记录 | `dsh-agent-audit` | 事件写入、查询接口 |

### 6.1 PostgreSQL 布局

第一阶段共用一个 PostgreSQL 集群，但每个服务使用独立 Schema（模式）和数据库账号：

```text
iam schema          → iam_db_role
chat schema         → chat_db_role
catalog schema      → catalog_db_role
workspace schema    → workspace_db_role
run_control schema  → run_control_db_role
quota schema        → quota_db_role
audit schema        → audit_db_role
```

强制规则：

- 禁止跨 Schema 查询；
- 禁止跨服务外键；
- 数据库账号仅拥有自身 Schema 权限；
- 所有多租户表包含 `tenant_id`；
- 用户资源表包含 `owner_uid`；
- 主键采用 UUIDv7（第七版通用唯一标识符）；
- 审计和大规模事件表按时间分区；
- PostgreSQL RLS（行级安全）可作为第二道防线，不能代替应用授权。

## 7. 通信与事件规范

### 7.1 外部接口

浏览器只访问：

- `dsh-agent-api` 的 REST API（表述性状态转移接口）；
- `dsh-agent-stream` 的 SSE/WebSocket。

### 7.2 内部同步接口

推荐 gRPC（通用远程过程调用）或内部 REST，仅用于必须立即得到结果的场景：身份验证、资源授权、定义查询、能力令牌申请、配额预留、Worker 派发和取消。

所有内部调用携带：

- `request_id`（请求标识）；
- `trace_id`（链路标识）；
- 调用服务身份；
- Audience（目标受众）；
- 超时；
- 适用时的幂等键。

### 7.3 异步事件

NATS JetStream（NATS 持久化事件流）负责事件传递。事件采用版本化名称：

```text
conversation.created.v1
conversation.message.accepted.v1
run.queued.v1
run.started.v1
run.completed.v1
run.failed.v1
run.canceled.v1
workspace.file.changed.v1
usage.recorded.v1
security.access.denied.v1
```

标准事件信封：

```json
{
  "eventId": "0198...",
  "eventType": "run.completed.v1",
  "occurredAt": "2026-08-29T12:00:00Z",
  "producer": "dsh-agent-run-control",
  "tenantId": "tenant-a",
  "traceId": "trace-1",
  "subjectId": "run-1",
  "payload": {}
}
```

事件只描述已发生的事实，不把同步命令伪装成事件。

## 8. 核心业务流程

### 8.1 创建会话

1. 浏览器调用 API；
2. API 验证 IAM JWT；
3. API 获取或创建用户默认工作区；
4. API 从 Catalog Service（定义中心）解析允许的智能体定义；
5. API 调用 Chat Service 创建会话；
6. Chat Service 保存不可变定义版本和 `workspace_id`；
7. 返回平台 `session_id`。

工作区创建接口必须幂等，会话创建失败时不删除已有默认工作区。

### 8.2 发送消息并运行 Agent

1. 浏览器提交消息和幂等键；
2. API 验证身份并调用 Chat Service；
3. Chat Service 同一事务写入消息和 Outbox；
4. 返回 `202 Accepted`（已接受）；
5. Run Control 消费消息接受事件；
6. 创建 Run，并向 Quota Service 预留额度；
7. 获取 Agent Definition 和 Workspace Capability；
8. 选择 Worker 并创建 Attempt/Lease；
9. Worker 执行 Agent，通过远程文件系统访问 Workspace Service；
10. Worker 发布标准化流式事件；
11. Stream Gateway 将事件推送给浏览器；
12. Run Control 更新最终状态并结算配额；
13. Chat Service 消费完成事件并持久化助手消息投影；
14. Audit Service 异步保存审计。

### 8.3 取消任务

1. API 验证用户身份；
2. Run Control 在 SQL 条件更新中校验 `run_id + tenant_id + owner_uid`；
3. 状态切换为 `CANCELING`；
4. 向当前 Worker 发送带 Lease 的取消命令；
5. Worker 中止 DSH Turn（智能体轮次）；
6. Run Control 更新为 `CANCELED`；
7. Quota Service 释放剩余额度。

### 8.4 Worker 故障

1. Run Control 发现 Heartbeat 超时；
2. Lease 过期，旧 Attempt 失效；
3. 无外部副作用且满足策略的 Run 创建新 Attempt；
4. 已产生不确定文件副作用的 Run 标记 `UNKNOWN`；
5. 旧 Worker 恢复后的迟到事件因 Lease 不匹配被拒绝。

## 9. 安全边界

### 9.1 网络

- 只有 Edge、API 和 Stream 可被 Ingress 访问；
- Worker、Workspace 和 Run Control 仅集群内部可达；
- 使用 Kubernetes NetworkPolicy（网络策略）限制服务间访问；
- 内部使用 mTLS（双向传输层安全）或 SPIFFE（安全生产身份框架）标识服务身份。

### 9.2 文件

- Worker 不挂载所有用户共享文件根目录；
- Workspace 不信任单独的 UID、路径或文件标识；
- 每次文件操作验证短期能力令牌；
- 禁止符号链接、硬链接和宿主机绝对路径；
- DSH 文件读取、图片、附件和搜索走同一提供器；
- BFF/Nginx 不直接暴露 MinIO 或工作区目录。

### 9.3 DSH

- 使用独立 Agent Preset，不使用通用开发 Agent；
- 插件白名单并锁定版本；
- 普通用户不能修改 Preset、权限模式、Credential（凭据）、Skill、MCP 或插件；
- 不加载本地 Bash、Terminal、Code Mode 和本地文件系统工具；
- DSH Web 控制面不对用户开放。

### 9.4 密钥

- 模型 API Key（应用程序接口密钥）放入 Vault（密钥保险库）或 Kubernetes Secret（密钥对象）；
- 日志不记录 Authorization Header（授权请求头）、Cookie、能力令牌或模型密钥；
- Workspace Capability 与 Worker Lease 使用不同签名密钥和 Audience。

## 10. 可观测性

使用 OpenTelemetry（开放遥测标准）统一 Trace（链路）、Metric（指标）和 Log（日志）。

必须贯穿：

```text
request_id → session_id → message_id → run_id → attempt_id → worker_id
```

关键指标：

- API 成功率和 P95/P99（第 95/99 百分位延迟）；
- 在线 SSE/WebSocket 连接数；
- 排队 Run 数和排队时间；
- Worker 并发、CPU、内存和事件延迟；
- 模型首 Token 延迟和总耗时；
- Workspace 错误率和存储容量；
- 配额拒绝数；
- Lease 过期和 UNKNOWN Run 数；
- NATS Consumer Lag（消费者积压）。

## 11. 部署与扩容

| 服务 | 初始副本 |
|---|---:|
| `dsh-agent-api` | 2 |
| `dsh-agent-chat` | 2 |
| `dsh-agent-catalog` | 2 |
| `dsh-agent-workspace` | 3 |
| `dsh-agent-run-control` | 2 |
| `dsh-agent-runtime-dsh` | 3～20，自动扩容 |
| `dsh-agent-stream` | 3 |
| `dsh-agent-quota` | 2 |
| `dsh-agent-audit` | 1～2 |

自动扩容策略：

- API 按 CPU 和请求量扩容；
- Stream 按连接数和出站流量扩容；
- Workspace 按延迟和吞吐扩容；
- Worker 按队列长度、活跃 Run 数和内存扩容；
- 使用 HPA（水平 Pod 自动扩缩器）和自定义指标；
- 保留 Warm Pool（预热工作节点池）降低首任务延迟。

一千个在线用户不等于一千个 Worker Pod。若同时有一百个活跃 Run、每个 Worker 安全承载十个 Run，通常只需约十到二十个 Worker Pod，并预留故障和峰值容量。

## 12. 降低耦合的强制规则

1. 只有 `dsh-agent-runtime-dsh` 可以依赖 DSH 包。
2. 服务不得直接查询其他服务的 Schema。
3. `dsh-agent-contracts` 只包含协议和生成代码，不包含业务实现。
4. 服务间不传宿主机路径，只传资源 ID 和能力令牌。
5. 会话引用不可变 Agent Definition Version。
6. 所有创建和命令接口支持幂等键。
7. 所有事件包含版本号，不改变既有事件含义。
8. 禁止分布式数据库事务，使用状态机、Outbox 和补偿操作。
9. 同步调用必须有超时，禁止无限重试。
10. 禁止前端直接调用 DSH、MinIO、PostgreSQL 或内部 gRPC。
11. 业务服务不依赖具体消息系统对象，由 Adapter（适配器）封装 NATS。
12. 每个服务拥有自己的数据库迁移、运行手册和告警规则。

## 13. 项目目录建议

独立仓库方案：

```text
dsh-agent-api/
dsh-agent-chat/
dsh-agent-catalog/
dsh-agent-workspace/
dsh-agent-run-control/
dsh-agent-runtime-dsh/
dsh-agent-stream/
dsh-agent-quota/
dsh-agent-audit/
dsh-agent-contracts/
dsh-agent-deploy/
```

第一阶段若使用 Monorepo（单一代码仓库），仍保持独立构建和部署：

```text
services/
  agent-api/
  agent-chat/
  agent-catalog/
  agent-workspace/
  agent-run-control/
  agent-runtime-dsh/
  agent-stream/
  agent-quota/
  agent-audit/
packages/
  contracts/
deploy/
  helm/
  observability/
  migrations/
```

禁止服务通过相对路径导入另一个服务的内部代码。

## 14. 分阶段实施

### 阶段一：安全闭环

- IAM、API、Chat、Catalog、Workspace、Run Control、Runtime Worker、Stream；
- PostgreSQL、Redis、NATS JetStream、MinIO；
- Remote Rooted FS Provider；
- Bash/MCP/Code Mode 全部禁用；
- 完成 UID、Session、Workspace 隔离测试。

### 阶段二：规模化

- Worker 自动扩容和预热池；
- 完整配额与用量；
- 审计查询；
- Worker 故障恢复；
- 断线事件续传；
- 灰度发布和容量压测。

### 阶段三：高风险工具

- 引入 Sandbox Manager；
- 每个活跃 Run 使用短生命周期微虚机或 Pod；
- 支持受控 Bash、MCP 和用户代码；
- 工作区快照进入沙箱，执行后通过差异清单回写；
- 沙箱网络出口和凭据按 Capability 控制。

## 15. 上线验收条件

### 功能

- 用户可创建会话、发送消息、接收流式响应和取消任务；
- Worker 重启后产品侧会话数据不丢失；
- 文件上传、读取、编辑和下载可用；
- Agent Definition 可发布和回滚。

### 安全

- A 用户无法查询、订阅、取消或导出 B 用户会话；
- A 用户无法读取、搜索、覆盖或删除 B 用户文件；
- 绝对路径、`..`、编码变体和符号链接攻击均失败；
- 普通用户无法调用 DSH 原生 RPC；
- 普通用户无法启用 Bash、MCP、Code Mode 或完全访问模式；
- 旧 Worker Lease 无法上报有效事件；
- 所有越权拒绝产生审计事件。

### 可靠性

- 消息重复投递不会重复创建 Run；
- API 重试不会重复写入用户消息；
- NATS 短暂不可用时 Outbox 可恢复发送；
- Worker 故障不会让 Run 永久停在 RUNNING；
- SSE 断线可根据 Last-Event-ID 续传。

## 16. 中英文术语表

| 英文术语 | 中文翻译 |
|---|---|
| Agent | 智能体 |
| Agent Definition | 智能体定义 |
| Agent Preset | 智能体预设 |
| Adapter | 适配器 |
| API | 应用程序接口 |
| API Key | 应用程序接口密钥 |
| API Gateway | 应用程序接口网关 |
| APISIX | 开源应用程序接口网关 |
| Attempt | 执行尝试 |
| Audience | 目标受众 |
| Authorization Header | 授权请求头 |
| Authentication | 身份认证 |
| Authorization | 权限授权 |
| Backpressure | 背压 |
| Bash | 命令解释器 |
| BFF / Backend for Frontend | 面向前端的后端 |
| Browser | 浏览器 |
| Bucket | 对象存储桶 |
| Capability Token | 能力令牌 |
| Catalog Service | 智能体定义中心 |
| Chat Service | 智能体会话消息服务 |
| Code Mode | 代码执行模式 |
| Consumer Lag | 消费者积压 |
| Control Plane | 控制面 |
| Cookie | 浏览器会话凭据 |
| CORS | 跨源资源共享 |
| CPU | 中央处理器 |
| Credential | 凭据 |
| Data Plane | 数据面 |
| DeepSeek Harness / DSH | 深度求索智能体执行框架 |
| DSH Worker | DSH 执行工作节点 |
| Edge | 边缘接入层 |
| Event Bus | 事件总线 |
| Envoy | 开源服务代理 |
| gRPC | 通用远程过程调用 |
| Heartbeat | 心跳 |
| Helm | Kubernetes 应用打包工具 |
| HPA | 水平 Pod 自动扩缩器 |
| IAM | 身份与访问管理 |
| ID | 标识符 |
| Idempotency Key | 幂等键 |
| Inbox Deduplication | 收件箱去重 |
| Ingress | 入口控制器 |
| JSON | JavaScript 对象表示法数据格式 |
| JWT | JSON 网络令牌 |
| Keycloak | 开源身份与访问管理平台 |
| Kubernetes | 容器编排平台 |
| Lease | 租约 |
| Log | 日志 |
| MCP | 模型上下文协议 |
| Metric | 指标 |
| MinIO | 兼容 S3 的对象存储系统 |
| Monorepo | 单一代码仓库 |
| mTLS | 双向传输层安全 |
| NATS JetStream | NATS 持久化事件流 |
| NetworkPolicy | 网络策略 |
| Nginx | 开源 Web 服务器和反向代理 |
| OAuth 2.0 | 开放授权协议 |
| OIDC | 开放身份连接 |
| OpenTelemetry | 开放遥测标准 |
| Optimistic Concurrency Control | 乐观并发控制 |
| Outbox / Transactional Outbox | 事务发件箱 |
| P95/P99 | 第 95/99 百分位延迟 |
| Pod | Kubernetes 最小部署单元 |
| PostgreSQL | 开源关系型数据库 |
| PowerShell | 微软命令与自动化环境 |
| Principal | 调用主体 |
| Provider | 能力提供器 |
| Quota Service | 配额与用量服务 |
| Realm | 身份域 |
| Redis | 内存数据结构存储系统 |
| REST | 表述性状态转移接口风格 |
| RLS | 行级安全 |
| Role | 角色 |
| Rooted FS | 根目录受限文件系统 |
| RPC | 远程过程调用 |
| Run | 运行任务 |
| Run Control | 运行控制服务 |
| S3 | 简单存储服务兼容协议 |
| Saga | 分布式补偿事务 |
| Sandbox | 沙箱 |
| Sandbox Manager | 沙箱管理器 |
| Scheduler | 调度器 |
| Schema | 数据库模式 |
| SDK | 软件开发工具包 |
| Session | 会话 |
| Skill | 技能 |
| SQL | 结构化查询语言 |
| SPIFFE | 安全生产身份框架 |
| SSE | 服务器发送事件 |
| Stream Gateway | 事件流网关 |
| System Prompt | 系统提示词 |
| Tenant | 租户 |
| TLS | 传输层安全协议 |
| Token Usage | 令牌用量 |
| Tool | 工具 |
| Trace | 调用链路 |
| UUIDv7 | 第七版通用唯一标识符 |
| UID | 用户唯一标识符 |
| Vault | 密钥保险库 |
| WAF | Web 应用防火墙 |
| Warm Pool | 预热工作节点池 |
| Web Agent | Web 智能体 |
| WebSocket | 网页双向通信协议 |
| Worker | 执行工作节点 |
| Workflow | 工作流 |
| Workspace | 工作区 |

## 17. 最终边界总结

- `dsh-agent-iam` 证明用户身份；
- `dsh-agent-chat` 管理会话及其所有权；
- `dsh-agent-catalog` 管理不可变智能体定义；
- `dsh-agent-workspace` 实施文件权限和内容隔离；
- `dsh-agent-run-control` 管理任务、调度和租约；
- `dsh-agent-runtime-dsh` 封装 DSH 并执行 Agent；
- `dsh-agent-stream` 管理长连接和事件续传；
- `dsh-agent-quota` 管理资源预算；
- `dsh-agent-audit` 保存安全与业务审计；
- `dsh-agent-api` 只负责面向前端的协议聚合。

这组边界使身份系统、DSH、文件存储、消息系统和模型提供商都可以独立替换，而不会迫使其他服务理解其内部实现。

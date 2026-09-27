# DSH 多租户智能体平台

本工作区保存独立服务项目，使用 TypeScript（带类型的 JavaScript）和 npm workspaces（包工作区）
进行本地联调。每个服务独立编译、独立启动，仅依赖公共协议包，不导入其他服务的内部代码。
上游 `deepseek-harness`（DeepSeek 智能体执行框架）保持独立。

## 已实现的链路

用户令牌 → `dsh-agent-api`（前端聚合服务）→ `dsh-agent-chat`（会话服务）→
PostgreSQL（关系型数据库）事务发件箱 → NATS JetStream（持久化消息流）→
`dsh-agent-stream`（事件流服务）。

当前可以创建会话、提交消息、查询历史、申请订阅凭证和接收持久化事件。
新增工作区文件管理和定义中心：Chat 向 Workspace（工作区服务）取得授权工作区，
向 Catalog（定义中心）取得租户默认版本，创建会话时保存绑定。
新增 Run Control（运行控制服务）：消息同时保存独立运行请求，由持久队列进入调度器，
支持执行租约、取消、结果回传和运行状态查询。已接入 DSH 子进程执行器，默认关闭；尚未调用真实外部模型验收。
执行输入已支持按有效租约获取、精确定义版本授权和快照冻结；
成功回答通过可靠投影写回会话，投影完成前同一会话不启动下一轮。
执行器工具入口已提供运行绑定能力令牌、在线租约检查和受限文件操作；
能力令牌不等于宿主文件权限，执行器不挂载用户共享目录、不注册本地命令工具。
`202` 只表示消息与待发布运行请求已保存，没有执行端时任务保持排队。
新会话的 `workspaceId` 已绑定；旧数据空绑定保留兼容，未擅自回填。

| 项目 | 本轮交付 |
| --- | --- |
| `dsh-agent-edge` | 既有网关；增加订阅凭证请求头和令牌受众约束 |
| `dsh-agent-contracts` | 请求、响应、事件协议及 OpenAPI（开放接口描述规范）文档 |
| `dsh-agent-api` | 身份校验、输入验证、内部调用、错误映射 |
| `dsh-agent-chat` | 数据归属、分页、幂等写入、事务发件箱、订阅授权、执行上下文与助手历史 |
| `dsh-agent-stream` | 订阅认证、事件重放、心跳、背压、连接释放 |
| `dsh-agent-iam` | Keycloak（身份管理平台）本地身份域和客户端配置 |
| `dsh-agent-workspace` | 用户工作区、S3（简单存储服务）文本对象、版本检查、额度、垃圾回收与运行受限工具 |
| `dsh-agent-catalog` | 已审核定义、不可变版本、租户授权与默认版本 |
| `dsh-agent-run-control` | 独立持久任务队列、调度、租约、取消、输入快照、结果投影、事件和工作区能力授权 |
| `dsh-agent-runtime-dsh` | 最小 DSH 核心、单次运行子进程、已审核技能、受限工具、预算与取消 |
| `dsh-agent-quota` | 用户/租户并发、保守预算、供应商用量、公司分配员工积分、可配置计价与幂等结算、本人余额/流水 |
| `dsh-agent-audit` | 运行、会话与文件变更元数据审计、独立生产者认证、可靠投递、追加写保护与本人查询 |
| `dsh-agent-deploy` | 容器构建、本地依赖、数据库角色、集群清单及内部监控告警模板 |

## 构建与测试

需要 Node.js 24（JavaScript 运行环境）和 npm（包管理工具）。

```powershell
npm ci
npm run check
```

默认运行数据库和服务测试。数据库测试使用 PGlite（基于 WebAssembly 的 PostgreSQL 引擎），
执行实际迁移和事务 SQL（结构化查询语言），不依赖 Docker（容器运行工具）。
这不能替代原生 PostgreSQL 多连接锁竞争测试。
测试文件并行数固定为 4，避免同时初始化大量兼容数据库和子进程导致本机资源争抢；各测试内部并发断言仍执行。

如果有 NATS Server（NATS 消息服务器）可执行文件，可启用真实消息代理集成测试：

```powershell
$env:NATS_SERVER_BIN = "绝对路径/nats-server.exe"
npm run check
```

测试会启动仅监听本机回环地址的独立进程，使用独立临时目录，并在结束时清理。
未设置变量时，这一项会明确标记为跳过。

## 本地启动

启动 Docker 引擎后，在本目录运行：

```powershell
node dsh-agent-deploy/init-dev.mjs
# 按部署说明配置已有 S3 兼容存储及私有桶后，再启动全部服务。
docker compose --env-file dsh-agent-deploy/.env -f dsh-agent-deploy/compose.yaml up --build -d
```

初始化脚本生成随机凭据并补充缺失设置，不覆盖已有配置。S3 占位配置需手工替换。
已有数据库卷须先运行新增角色升级步骤，不要删除数据卷重新初始化。凭据文件已经从版本控制和
容器构建上下文中排除。

本地 API 地址为 `http://localhost:8080`，IAM（身份与访问管理）地址为
`http://localhost:8081`，事件服务地址为 `http://localhost:8082`。数据库、消息代理和
Chat、Workspace、Catalog 和 Run Control 没有宿主机端口。这个部署用于本地调试，不代替公网 TLS（传输层安全）
网关部署，也未包含前端页面。

执行器默认不领取任务，启用前需配置模型密钥并检查已有排队任务；详见
[DSH 执行服务](dsh-agent-runtime-dsh/README.md)。接口定义见 [OpenAPI 文档](dsh-agent-contracts/openapi.json)，联调方式见
[部署说明](dsh-agent-deploy/README.md)，实际完成范围见
[实现状态](docs/implementation-status.zh-CN.md)。

第七阶段新增配额和审计基础版，运行控制下发输入之前强制预留；配额故障不允许无预算执行。
会话支持标题修改、归档/恢复和修订号冲突检查；定义中心支持受控命令撤销指定租户的版本授权。
归档与撤销都不等于取消已接受任务，配额预留不等于真实模型账单。
第八阶段增加会话与工作区的事务审计发件箱，以及三个关键服务的独立凭据监控端点。
已提供 [监控接入与告警模板](dsh-agent-deploy/monitoring/README.md)，但未部署监控服务器或通知接收器。
第九阶段接入 [模型用量采集与统计](docs/model-usage.zh-CN.md)：逐次记录调用，显式区分未知和待报用量，
通过 `GET /api/v1/usage` 查询本人日统计；不接支付、不退还保守预留，未调用真实模型验收。
第十阶段增加 [服务端工作流](docs/workflow.zh-CN.md)：顺序步骤、条件跳过、持久进度与步骤工具子集。
不提供任意代码、并行图编排或自动恢复；示例定义不会自动发布，已有会话不切换版本。
第十一阶段增加 [积分账户与结算](docs/points-billing.zh-CN.md)：实际报告用量乘配置价格，再按可配置比例换算积分；
公司积分硬分配到员工账户，运行前固定计价版本，按次幂等扣费。默认关闭，须先执行配额第三版迁移并配置价格和账户。
没有支付充值、退款或公司管理员自助接口；单次冻结额不保证实际费用绝不超出。
第十二阶段新增 [高并发保护](docs/high-concurrency.zh-CN.md)：入口在途限制、跨副本新消息限流、未投递积压门禁、
数据库等待上限、连续并行投递、主体调度并发与等待老化、多执行槽。新增本机合成负载脚本及失败记录，不宣称一万 QPS 已达标。
其余非前端缺口见 [后端后续清单](docs/backend-remaining.zh-CN.md)。

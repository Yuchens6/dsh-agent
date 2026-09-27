# dsh-agent-api：前端聚合服务

本服务为 BFF（Backend for Frontend，面向前端的后端），监听 8080 端口。
它校验 IAM（身份与访问管理）签发的 JWT（JSON 网络令牌），建立调用主体，
验证请求后通过内部 HTTP（超文本传输协议）调用 Chat（会话服务）、Workspace（工作区服务）
与 Catalog（定义中心）、Run Control（运行控制服务）。每条服务调用边使用独立密钥。

本服务不持有数据库、不保存会话归属，也不接受客户端传入的用户或租户身份请求头。
内部调用使用独立服务密钥签发最长 30 秒的令牌，固定 Issuer（签发者）和 Audience（受众）。
Chat 重新验证该凭证后，从服务签名中读取用户身份。

| 接口 | 含义 |
| --- | --- |
| `GET /api/v1/me` | 当前已认证主体 |
| `POST /api/v1/sessions` | 创建会话，仅允许标题字段 |
| `GET /api/v1/sessions` | 当前用户会话列表 |
| `GET /api/v1/sessions/:sessionId` | 会话详情 |
| `POST /api/v1/sessions/:sessionId/messages` | 保存消息并返回 202 |
| `GET /api/v1/sessions/:sessionId/history` | 按顺序分页读取历史 |
| `POST /api/v1/sessions/:sessionId/subscription` | 申请最长 60 秒的订阅凭证 |
| `POST /api/v1/workspaces/ensure` | 幂等分配当前主体工作区，不接受身份参数 |
| `GET /api/v1/workspaces/:workspaceId` | 工作区概况 |
| `GET /api/v1/workspaces/:workspaceId/files` | 文件列表 |
| `GET/PUT/DELETE /api/v1/workspaces/:workspaceId/file` | 按虚拟路径读取、写入、删除文本文件 |
| `GET /api/v1/definitions` | 当前租户已授权定义摘要 |
| `GET /api/v1/definitions/:id/versions/:version` | 已授权精确版本 |
| `GET /api/v1/runs` | 当前用户运行列表，可按会话过滤 |
| `GET /api/v1/runs/:runId` | 运行状态及最终结果 |
| `POST /api/v1/runs/:runId/cancel` | 无正文，取消排队或运行任务 |

创建会话和提交消息必须携带 `Idempotency-Key`（幂等键）。列表接受
`limit`（页大小，1～100）与 `after`（上一页游标），不使用无界查询。

运行配置：

| 环境变量 | 含义 |
| --- | --- |
| `IAM_ISSUER` | 令牌签发者 |
| `IAM_JWKS_URL` | 公共验证密钥集地址 |
| `IAM_AUDIENCE` | 受众，默认 `agent-platform` |
| `CHAT_URL` | 内部会话服务地址 |
| `API_CHAT_SECRET` | API 到 Chat 的独立签名密钥，至少 32 字节 |
| `WORKSPACE_URL`、`API_WORKSPACE_SECRET` | 工作区服务地址与专用签名密钥 |
| `CATALOG_URL`、`API_CATALOG_SECRET` | 定义中心地址与专用签名密钥 |
| `RUN_CONTROL_URL`、`API_RUN_CONTROL_SECRET` | 运行控制地址与专用签名密钥 |
| `PORT` | 监听端口，默认 8080 |
| `API_MAX_IN_FLIGHT` | 单副本在途业务请求上限，默认 128；不代表全局用户限流 |

内部请求超时为 5 秒，不自动重试命令；浏览器断开会取消下游请求。
日志隐藏身份凭证，错误响应不透传内部 URL（统一资源定位符）或堆栈。
`/health/live` 和 `/health/ready` 是内部探针，不位于公网 API 前缀内。
API 的就绪探针检查本进程；业务依赖故障通过 503 明确返回。

先在根目录构建，然后运行 `npm start -w @dsh-agent/api`。
本服务不代理 `/worker/v1`（执行端协议）接口，不持有执行端签名密钥。
提交消息与任务入队是异步的；客户端用会话标识查询运行列表并按消息标识关联，不能将 202 当成执行完成。

新增 `GET /api/v1/usage?day=YYYY-MM-DD`（查询本人指定 UTC 日期的模型用量），默认当天。
沿用 `QUOTA_URL`（配额服务地址）及 `API_QUOTA_SECRET`（配额查询密钥），不增加执行端凭据。
响应含已知词元累计及未知/待报调用计数；十进制累计值使用字符串，不是货币账单。
禁止提交用户或租户覆盖参数；仅查询身份令牌对应主体。详见 [用量说明](../docs/model-usage.zh-CN.md)。

## 并发保护

认证/正文解析前限制本副本在途请求，满载返回 503 与 `Retry-After`（重试等待秒数）。
透传会话服务已验证的 429 及重试等待时间；写请求必须保留原幂等键重试。
客户端断开释放槽位；健康探针不占业务槽位。请求接收超时 30 秒、连接无活动超时 15 秒。
具体限流、容量和未完成项见 [高并发说明](../docs/high-concurrency.zh-CN.md)。

# dsh-agent-edge 架构

## 1. 项目定位

`dsh-agent-edge`（DSH 智能体边缘网关）是 Web Agent（Web 智能体）系统中唯一面向公网的
基础设施项目。它把互联网流量转换为受控的内部流量，但不判断某个用户是否拥有某个
Workspace（工作区）或 Agent Run（智能体运行实例）。

```text
浏览器
  │ HTTPS（超文本传输安全协议）
  ▼
云 WAF（Web Application Firewall，Web 应用防火墙）
  │
  ▼
dsh-agent-edge
  ├── /api/v1/*    ──> dsh-agent-api
  └── /events/v1/* ──> dsh-agent-stream

dsh-agent-api / dsh-agent-stream
  │ 内部授权后的调用
  ▼
身份、工作区、运行控制、DSH Runtime（DSH 运行时）等内部服务
```

## 2. 组件及归属

| 组件 | 中文含义 | 本项目是否负责 | 职责 |
| --- | --- | --- | --- |
| GatewayClass | 网关类 | 是 | 指定 Envoy Gateway 控制器 |
| Gateway | 网关实例 | 是 | HTTPS 监听和证书引用 |
| HTTPRoute | HTTP 路由 | 是 | 白名单公共路径和后端映射 |
| SecurityPolicy | 安全策略 | 是 | JWT 的签发者和签名验证 |
| BackendTrafficPolicy | 后端流量策略 | 是 | 超时、事件流和粗粒度限流 |
| NetworkPolicy | 网络策略 | 是 | 限制公共后端的入站来源 |
| WAF | Web 应用防火墙 | 外部依赖 | 恶意请求、机器人和常见攻击防护 |
| IAM | Identity and Access Management，身份与访问管理 | 否 | 登录、令牌签发、密钥轮换 |
| BFF | Backend for Frontend，面向前端的后端 | 否 | 业务 API 聚合和最终资源授权 |
| DSH Runtime | DSH 运行时 | 否 | 执行 Agent（智能体）任务 |

## 3. 请求处理顺序

1. WAF（Web 应用防火墙）执行互联网侧基础防护。
2. Gateway（网关）完成 TLS（传输层安全）终止。
3. HTTPRoute（HTTP 路由）仅接受已声明的主机名和路径前缀。
4. SecurityPolicy（安全策略）验证 JWT 的签发者和签名。
5. BackendTrafficPolicy（后端流量策略）执行超时和入口限流。
6. 路由过滤器删除外部传入的内部身份请求头。
7. 请求进入 `dsh-agent-api` 或 `dsh-agent-stream`。
8. 后端再次验证令牌，并执行用户、租户、工作区和资源级授权。

第 8 步不可省略。边缘认证成功只说明令牌可信，不说明调用者拥有目标资源。

## 4. API 与事件流分离

普通 API 和 SSE（Server-Sent Events，服务器发送事件）具有不同的连接特征，因此使用
两条 HTTPRoute 和两份 BackendTrafficPolicy：

| 项目 | 普通 API | SSE 事件流 |
| --- | --- | --- |
| 公共前缀 | `/api/v1` | `/events/v1` |
| 默认请求超时 | 30 秒 | 禁用总请求时长限制 |
| 空闲超时 | 控制器默认值 | 90 秒 |
| 本地限流 | 每网关实例每分钟 300 次 | 每网关实例每分钟 60 次连接请求 |
| 请求体 | 缓冲并限制为 10 MiB | 不启用缓冲 |

SSE 服务应在 30 秒内至少发送一次 heartbeat（心跳），否则 90 秒空闲超时会关闭连接。
客户端应使用支持 `Authorization`（授权）请求头的 `fetch` 流式读取方式；原生
`EventSource` 无法稳定添加该请求头，不作为首版标准客户端。

普通 API 的 10 MiB 上限用于防止超大请求占用后端资源。大文件不得通过该路由直接上传，
应由 `dsh-agent-api` 签发对象存储的短期上传凭据。SSE 路由不能启用请求缓冲，否则会破坏
流式通信。

## 5. 限流演进

当前 Local Rate Limiting（本地限流）用于保护单个 Envoy（Envoy 代理）实例，优点是没有
外部依赖，适合首版和故障降级。它不是精确的全局用户配额。

达到多副本生产规模后，应增加 Global Rate Limiting（全局限流）：

- Envoy Gateway Rate Limit Service（Envoy 网关限流服务）统一计数；
- Redis（Redis 缓存）保存分布式计数；
- 以已验证的用户标识、租户和路由为 key（键）；
- `dsh-agent-api` 继续执行套餐配额、并发运行数等业务限额。

全局限流上线前，不应把浏览器提交的 `X-User-Id` 当作计数依据。

## 6. 配置分层

- `base`（基础层）：环境无关的资源与安全不变量。
- `overlays`（环境覆盖层）：域名、身份提供商地址和环境标签。

development（开发）环境只启用本机跨域策略，不启用边缘 JWT，便于最小集群联调，
但后端仍应认证。staging（预发布）和 production（生产）在同一 SecurityPolicy 中
增加 JWT 校验，并通过脚本阻止 `change-me` 占位配置进入发布。

## 7. 设计约束

- 不在本项目保存证书私钥、JWT 密钥或任何 Kubernetes Secret（密钥对象）的明文。
- 不配置指向 DSH Runtime、Worker（执行工作器）或数据组件的 HTTPRoute。
- 不从 URL（统一资源定位符）路径直接推导本地文件系统路径。
- 不在边缘层实现工作区归属判断。
- 不允许内部服务因“请求来自网关”而跳过自身授权。

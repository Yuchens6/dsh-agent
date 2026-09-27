# 公共后端接入契约

`dsh-agent-api` 和 `dsh-agent-stream` 接入边缘网关时必须满足本契约。

## Kubernetes 资源约定

| 后端 | Namespace（命名空间） | Service（服务） | Pod 标签 | 端口 |
| --- | --- | --- | --- | --- |
| API | `agent-platform` | `dsh-agent-api` | `app.kubernetes.io/name=dsh-agent-api` | 8080 |
| SSE（服务器发送事件） | `agent-platform` | `dsh-agent-stream` | `app.kubernetes.io/name=dsh-agent-stream` | 8080 |

Service 必须使用稳定的 ClusterIP（集群内部地址）。公共后端不得使用
NodePort（节点端口）或 LoadBalancer（负载均衡器）类型绕过 `dsh-agent-edge`。

## HTTP 契约

- 所有业务端点位于分配的版本化前缀下；
- API 不得在 `/api/v1` 下实现只供内部调用的管理接口；
- SSE 服务必须使用 `text/event-stream` 内容类型；
- SSE 心跳间隔不超过 30 秒；
- 后端应接受并传播 `traceparent`（分布式追踪上下文）和请求标识；
- 后端不得根据 `X-Edge-Route` 授权，该请求头只用于诊断。

## 身份与授权

- staging（预发布）和 production（生产）请求由边缘层先验证 JWT；
- 后端必须再次验证 JWT 或验证由受信任身份服务签发的内部凭证；
- `sub`（主体）、tenant（租户）和角色声明必须经过服务端解析；
- 对每个 `workspaceId`、`threadId`、`runId` 和文件标识执行资源归属检查；
- 返回 401 表示未认证，403 表示已认证但无权访问，404 可用于隐藏敏感资源是否存在。

## 超时与取消

- API 应在 30 秒内返回，耗时任务必须转为异步 Run（运行实例）；
- 客户端断开时，API 应取消不再需要的下游请求；
- SSE 断开不应自动取消 Agent Run，取消运行必须使用经过授权的显式命令；
- 事件服务应支持断线续传标识，避免重连后丢失或重复处理关键事件。

## 发布验收

后端团队需证明：

1. Service 名称、端口和 Pod 标签符合约定；
2. 无网关路径可访问内部管理端点；
3. 伪造用户或工作区请求头不会改变授权结果；
4. 跨用户读取同一资源标识返回 403 或 404；
5. NetworkPolicy 生效后，非边缘命名空间无法连接公共后端；
6. SSE 心跳、重连和令牌过期行为已通过集成测试。


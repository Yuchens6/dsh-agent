# 安全边界

## 1. 信任原则

`dsh-agent-edge` 只能建立“请求来自经过认证的令牌”这一事实，不能替代业务授权。
每个后端服务必须采用 Zero Trust（零信任）原则：每次访问都验证身份、租户和资源归属。

## 2. 必须删除的外部请求头

公共路由在转发前删除以下请求头：

- `X-User-Id`：用户标识；
- `X-Tenant-Id`：租户标识；
- `X-Role`：角色；
- `X-Workspace-Id`：工作区标识；
- `X-Internal-User`：内部用户标记；
- `X-Service-Identity`：服务身份；
- `X-Runtime-Session-Id`：运行时会话标识。

边缘层只增加不可用于授权的 `X-Edge-Route` 诊断头。后端服务必须从已验证 JWT
或服务间身份中获取主体信息，不能信任上述浏览器可控请求头。

## 3. 多租户文件隔离责任

用户工作区隔离不由网关实现。完整防护至少需要：

1. `dsh-agent-api` 校验 `uid`（用户唯一标识）对工作区的所有权；
2. `dsh-agent-run-control` 只接受内部服务身份，并重新校验任务与用户映射；
3. `dsh-agent-workspace` 使用不可由用户拼接的内部 workspace ID（工作区标识）；
4. DSH Harness（DSH 执行框架）进程使用工作区根目录、工具白名单和路径钩子；
5. 执行容器使用非 root（非超级用户）身份、只挂载一个工作区；
6. 对高风险代码执行使用 Pod（容器工作负载实例）或 Sandbox（沙箱）级隔离。

边缘路径白名单可以减少攻击面，但无法阻止已进入运行时的目录穿越、符号链接逃逸或
恶意工具调用。

## 4. Kubernetes 网络边界

基础 NetworkPolicy（网络策略）仅允许 `agent-edge-system` 命名空间访问
`dsh-agent-api` 和 `dsh-agent-stream` 的 8080 端口。前提条件：

- 集群 CNI（Container Network Interface，容器网络接口）插件支持 NetworkPolicy；
- 边缘命名空间只能部署受控工作负载；
- 后端 Pod 使用清单约定的 `app.kubernetes.io/name` 标签。

如果共享边缘命名空间，必须在部署后确认 Envoy 数据面 Pod 的稳定标签，再将
`podSelector`（Pod 选择器）加入入站来源规则，不能只依赖命名空间。

## 5. TLS 和密钥

- 公网只监听 443 端口，不创建明文 HTTP 监听；
- API 请求体超过 10 MiB 时由网关返回 413；
- CORS 只允许配置中的精确前端 Origin（来源），不允许通配符；
- 所有公共响应设置 HSTS（HTTP 严格传输安全）、禁止内容嗅探和禁止缓存等安全头；
- TLS Secret `agent-public-tls` 位于 `agent-edge-system`；
- 私钥由 cert-manager（证书管理器）或云证书服务写入；
- Git（版本控制系统）中不得提交 Secret 明文；
- JWT 使用 remote JWKS（远程 JSON 网络密钥集）验证，并由身份服务轮换签名密钥。

## 6. 生产发布阻断项

出现任意一项都不得发布：

- 清单中仍包含 `change-me`；
- 预发布或生产环境缺少 SecurityPolicy；
- 新增了 `/internal`、`/runtime`、`/debug`、`/metrics` 等公共路由；
- HTTPRoute 指向 API 和 Stream 以外的服务；
- 后端服务未执行资源级授权；
- CNI 不执行 NetworkPolicy；
- TLS Secret 不存在或证书不可用；
- SSE 没有心跳和断线重连上限。

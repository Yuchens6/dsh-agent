# 运维手册

## 1. 发布前配置

在目标环境的 `kustomization.yaml` 中替换：

- Gateway（网关）的公网 hostname（主机名）；
- 两条 HTTPRoute（HTTP 路由）的 hostname；
- JWT issuer（JWT 签发者）；
- remote JWKS URI（远程 JSON 网络密钥集统一资源标识符）。

确认证书系统已经创建：

```powershell
kubectl -n agent-edge-system get secret agent-public-tls
```

然后执行严格校验：

```powershell
./scripts/validate.ps1 -Environment staging
./scripts/validate.ps1 -Environment production
```

## 2. 部署

```powershell
kubectl apply -k manifests/overlays/staging
kubectl apply -k manifests/overlays/production
```

发布系统应保存 `kubectl kustomize` 的渲染产物，以便审计和回滚。不要在集群里手工修改
由 Kustomize（Kubernetes 配置定制工具）管理的字段。

## 3. 部署后检查

检查 Gateway 和路由状态：

```powershell
kubectl -n agent-edge-system get gateway agent-public -o yaml
kubectl -n agent-platform get httproute
kubectl -n agent-platform get securitypolicy
kubectl -n agent-platform get backendtrafficpolicy
```

需要确认：

- Gateway 的 `Programmed`（已编程）条件为 `True`；
- HTTPRoute 的 `Accepted`（已接受）和 `ResolvedRefs`（引用已解析）条件为 `True`；
- TLS 证书有效；
- 未带令牌请求返回 401；
- 有效令牌但无资源权限的请求由后端返回 403；
- 不存在的公共路径返回 404；
- SSE 建立后能持续收到心跳，断网后客户端采用带抖动的指数退避重连。

## 4. 最小冒烟测试

以下地址均使用实际域名替换：

```powershell
curl.exe -i https://agent.example.com/api/v1/health
curl.exe -i -H "Authorization: Bearer <token>" https://agent.example.com/api/v1/me
curl.exe -N -H "Authorization: Bearer <token>" https://agent.example.com/events/v1/stream
curl.exe -i https://agent.example.com/internal/health
```

最后一个请求必须返回 404，而不是被转发到内部服务。健康检查是否公开由
`dsh-agent-api` 决定；边缘项目不会为它创建绕过认证的专用路由。

## 5. 常见故障

| 现象 | 首要检查项 |
| --- | --- |
| Gateway 未进入 Programmed | Envoy Gateway 控制器、GatewayClass 名称、TLS Secret |
| HTTPRoute 未进入 Accepted | namespace（命名空间）标签、parentRefs（父级引用）、hostname |
| HTTPRoute 的 ResolvedRefs 为 False | 后端 Service（服务）名称和 8080 端口 |
| 所有请求均为 401 | issuer、JWKS 地址、令牌 audience（受众）策略 |
| 网关返回 503 | 后端 Endpoint（端点）、NetworkPolicy、Pod 健康状态 |
| SSE 约 90 秒断开 | 心跳未发送、代理链存在更短空闲超时 |
| 单实例限流效果不一致 | 当前是 Local Rate Limiting，应升级为全局限流 |

## 6. 回滚

回滚应重新应用上一份经过审计的渲染清单，而不是删除 Gateway。删除 Gateway 会立即中断
所有 API 和 SSE 连接。路由或策略变更时采用滚动发布，并在预发布环境先验证状态条件和
冒烟测试。

## 7. 观测指标

至少采集：

- 每条 Route（路由）的请求数、状态码和延迟；
- JWT 校验失败数；
- 429 限流响应数；
- 上游连接失败和 5xx 响应；
- SSE 当前连接数、连接时长和异常断开数；
- TLS 握手错误和证书到期时间。

日志中可以记录请求标识、路由、状态码和耗时，但不得记录完整 JWT、Cookie（浏览器
会话数据）、用户提示词或文件内容。


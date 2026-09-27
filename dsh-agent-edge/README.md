# dsh-agent-edge

`dsh-agent-edge`（DSH 智能体边缘网关）是 DSH Web Agent（Web 智能体）平台的公网入口项目。
它负责传输层安全、公共路由、粗粒度身份校验、流量保护和入口审计，不承载业务编排，
也不会把 DeepSeek Harness（DeepSeek 执行框架，简称 DSH）运行时直接暴露给互联网。

## 当前实现

- Kubernetes Gateway API（Kubernetes 网关应用程序接口）
- Envoy Gateway（Envoy 网关控制器）
- `/api/v1/*` 到 `dsh-agent-api`
- `/events/v1/*` 到 `dsh-agent-stream`
- HTTPS（超文本传输安全协议）终止
- JWT（JSON Web Token，JSON 网络令牌）验证策略
- API（应用程序编程接口）与事件流的独立限流、超时策略
- API 请求体 10 MiB（兆二进制字节）上限
- 精确来源的 CORS（跨源资源共享）和安全响应头
- 防止伪造内部身份请求头
- 只允许边缘网关访问公共后端 Pod（容器工作负载实例）的网络策略
- development（开发）、staging（预发布）、production（生产）三套环境覆盖
- 渲染和静态安全校验脚本

## 安全边界

浏览器只能访问两个公共前缀：

| 公共路径 | 后端服务 | 用途 |
| --- | --- | --- |
| `/api/v1/*` | `dsh-agent-api:8080` | 登录后的业务 API |
| `/events/v1/*` | `dsh-agent-stream:8080` | SSE（Server-Sent Events，服务器发送事件）流 |

任何 DSH Runtime（DSH 运行时）、Workspace（工作区）、Worker（执行工作器）、PostgreSQL
（PostgreSQL 数据库）、Redis（Redis 缓存）或 NATS（NATS 消息系统）服务都不允许配置公网路由。

边缘层的 JWT 校验和限流只是第一层保护。`dsh-agent-api` 与 `dsh-agent-stream`
仍必须自行验证用户身份、租户、工作区和资源归属；不能信任来自浏览器的
`X-User-Id`、`X-Tenant-Id`、`X-Workspace-Id` 等请求头。

## 目录

```text
dsh-agent-edge/
├── manifests/
│   ├── base/                 # 环境无关资源
│   └── overlays/             # 各环境配置
├── scripts/                  # 渲染与校验脚本
└── docs/                     # 架构、安全和运维说明
```

## 前置条件

- Kubernetes 1.33、1.34、1.35 或 1.36
- Gateway API 1.6.1 的自定义资源定义
- Envoy Gateway 1.9.1
- PowerShell 7（运行项目脚本时）
- `kubectl`

上述组合是当前开发基线。升级任一组件前，都必须按照 Envoy Gateway 官方兼容矩阵
一起验证 Kubernetes、Gateway API 和 Envoy Gateway 的版本。

## 本地渲染

```powershell
./scripts/render.ps1 -Environment development
./scripts/validate.ps1 -Environment development
```

预发布和生产环境故意保留 `CHANGE-ME` 占位值。在真实域名、JWT 签发者和
JWKS（JSON Web Key Set，JSON 网络密钥集）地址配置完成前，严格校验会失败：

```powershell
./scripts/validate.ps1 -Environment production
```

开发早期仅检查清单结构时可显式允许占位值：

```powershell
./scripts/validate.ps1 -Environment production -AllowPlaceholders
```

## 部署顺序

1. 安装 Gateway API 自定义资源定义和 Envoy Gateway。
2. 为 `agent-public-tls` 创建 TLS（传输层安全）Secret（密钥对象），或启用
   cert-manager（证书管理器）功能清单。
3. 替换目标环境中的域名、JWT issuer（签发者）与 remote JWKS（远程密钥集）地址。
4. 运行严格校验。
5. 先部署后端服务，再应用目标环境清单。
6. 执行 [部署后验证](docs/operations-runbook.md)。

```powershell
kubectl apply -k manifests/overlays/production
```

生产发布前的详细约束见 [安全边界](docs/security-boundary.md) 和
[运维手册](docs/operations-runbook.md)。API 和事件服务的接入要求见
[公共后端接入契约](docs/backend-contract.md)。

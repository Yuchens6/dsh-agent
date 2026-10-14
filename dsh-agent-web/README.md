# dsh-agent-web：智能体工作台

独立的 Web（网页）前端，采用浏览器原生 JavaScript（脚本语言）、CSS（层叠样式表）及 TypeScript（类型化脚本语言）静态服务，复用既有依赖，不请求外部字体或图标资源。

功能：租户智能体／工作流目录、技能库、文本技能编辑及导入、工作流配置、受限版本发布、指定版本会话、实时对话和步骤状态。完整设计、权限与启用步骤见[工作台说明](../docs/agent-studio.zh-CN.md)。

```powershell
# 仓库根目录执行
npm run build
npm run dev:web
```

默认访问 `http://localhost:3000`。需要已启动并升级后的后端及 Keycloak（身份平台）；只启动网页不会自动迁移数据库、创建管理员或启用发布。

| 环境变量 | 默认值及用途 |
| --- | --- |
| `HOST`、`PORT` | `127.0.0.1`、`3000`；仅本机监听 |
| `WEB_ORIGIN` | `http://localhost:3000`；校验请求主机和来源 |
| `API_URL` | `http://127.0.0.1:8080`；业务聚合接口 |
| `STREAM_URL` | `http://127.0.0.1:8082`；事件服务 |
| `IAM_ISSUER` | `http://127.0.0.1:8081/realms/agent-local` |
| `IAM_CLIENT_ID` | `agent-web`；公共授权码客户端 |

网页进程不需要模型密钥、数据库连接串或内部签名密钥。只转发浏览器访问令牌及事件能力令牌；浏览器令牌仅在内存保存，刷新页面需重新登录。

隔离 UI（用户界面）夹具：构建后执行 `node tests/studio-preview.mjs`，访问 `http://localhost:3080`。其账号、发布、会话和回答均为内存模拟，不连接真实平台，停止即丢弃，不可用作部署方式。

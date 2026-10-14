# Windows（视窗操作系统）原生部署与验收

首次验证日期：2026-10-10；2026-10-11 电脑重启后已恢复服务并再次通过全链路验证。工作区：`D:\code\dsh`。不使用 Docker（容器运行工具）或 Kubernetes／K8s（容器编排平台）。

## 1. 当前可用状态

已启动 10 个 Node.js（脚本运行环境）应用服务及 PostgreSQL（关系型数据库）、Keycloak（身份管理平台）、NATS JetStream（持久化消息系统）、SeaweedFS（文件与对象存储）4 个基础服务。

这是一套**本机开发与部署验证环境**：所有监听均限制为 `127.0.0.1`（本机回环地址）；没有前端页面，没有公网入口，也没有启用生产网关。API（应用程序接口）根路径不是聊天页面。

| 组件 | 本机地址／端口 | 用途 |
| --- | --- | --- |
| `dsh-agent-api` | `http://127.0.0.1:8080` | 业务接口；健康检查 `/health/ready` |
| Keycloak | `http://127.0.0.1:8081` | 登录与管理；身份域 `agent-local` |
| `dsh-agent-stream` | `http://127.0.0.1:8082` | SSE（服务器发送事件）流式订阅 |
| `dsh-agent-chat` | 8083 | 会话、消息、历史、事务发件箱 |
| `dsh-agent-workspace` | 8084 | 用户文件、版本与访问控制 |
| `dsh-agent-run-control` | 8085 | 排队、租约、运行状态与结果投影 |
| `dsh-agent-catalog` | 8086 | 已审核 Agent（智能体）定义和 Workflow（工作流） |
| `dsh-agent-quota` | 8087 | 配额、模型用量、积分接口 |
| `dsh-agent-audit` | 8088 | 追加式审计 |
| `dsh-agent-runtime-dsh` | 8089 | DSH（DeepSeek 智能体执行框架）原生执行器 |
| `dsh-agent-knowledge` | 8090 | 无向量 RAG（检索增强生成）知识访问 |
| PostgreSQL | 5432 | `agent` 数据库；11 个服务角色 |
| NATS | 4222 | 经令牌认证的任务和事件消息 |
| SeaweedFS S3（简单存储服务） | `http://127.0.0.1:8333` | 私有桶 `dsh-workspaces` |

SeaweedFS 的内部控制端口为 8888、9333、9340、18333、18888、19333、19340，也仅监听本机。Keycloak 可能有本机动态内部端口，不应为这些端口开放防火墙。

## 2. 现在如何使用

在工作区根目录的 PowerShell（命令行外壳）运行：

```powershell
cd D:\code\dsh

# 查询状态；不调用模型
.\dsh-agent-deploy\native\platform.ps1 -Action Status

# 直接在终端对话，会调用真实模型并显示状态和正文预览
node dsh-agent-deploy/native/client.mjs ask "你好，请简短介绍你能做什么"

# 仅验证登录，不显示密码或访问令牌
node dsh-agent-deploy/native/client.mjs login

# 停止／再次启动
.\dsh-agent-deploy\native\platform.ps1 -Action Stop
.\dsh-agent-deploy\native\platform.ps1 -Action Start
```

如 PowerShell 的执行策略阻止脚本，可使用当前进程的显式启动方式，不需修改全局策略：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File dsh-agent-deploy/native/platform.ps1 -Action Status
```

每次 `ask` 创建一个新会话。会话保存在数据库中；命令行程序不是完整的多轮聊天界面。客户端通过 Authorization Code（授权码）及 PKCE（授权码交换证明密钥）登录；没有开放 Password Grant（密码直授）给业务客户端，没有绕过身份服务自行签发令牌。

本地普通用户为 `local-user`，另有用于隔离测试的 `isolation-test`。用户密码和 `admin`（管理员）密码位于 **`.local/native/platform.json`**：`users` 保存普通用户，`admin` 保存管理登录信息。该文件含其他内部密钥，只在本机查看，不要粘贴到聊天、截图、工单或仓库。浏览器管理入口为 `http://127.0.0.1:8081/admin/`。

## 3. 已完成的安装与配置

| 软件 | 使用版本／路径 |
| --- | --- |
| Node.js、npm（包管理器） | 24.14.0、11.9.0；已有安装 |
| PostgreSQL | 18.6；直接使用用户解压目录 `D:\postgresql\postgresql-18.6-4-windows-x64-binaries\pgsql\bin` |
| Java／JDK（Java 开发工具包） | `D:\jdk23`；实际版本为 **OpenJDK 21.0.8**，目录名不代表版本；未使用系统默认的 Java 8 |
| Keycloak | 26.7.4；下载到 `.tools/keycloak-26.7.4`，已校验 SHA-256（安全散列校验值） |
| NATS Server（消息服务器） | 2.15.0；使用 `.tools/nats-2.15.0` 下已有程序 |
| SeaweedFS | 4.47；使用 `.tools/seaweedfs-4.47/bin/weed.exe` |

根目录 `.env` 原文件未改写。启动器只读取模型字段：优先 `DEEPSEEK_API_KEY`，兼容 `LLM_API_KEY`；地址兼容 `DEEPSEEK_BASE_URL`／`LLM_BASE_URL`。本次使用 `deepseek-v4-flash`，密钥仅注入运行器，不注入其他业务服务或浏览器。

原生数据库和对象存储继续使用 `.local/native/.env` 的已有凭据，**没有拿容器部署的 `.env` 覆盖已有数据库密码**。新增知识库所有者、只读账号及各服务独立调用密钥。在线 Catalog（定义中心）使用只读账号，Audit（审计服务）使用追加写账号，Knowledge（知识服务）使用只读账号。

已执行业务迁移：会话 5、工作区 2、定义中心 1、运行控制 7、配额 3、审计 2、知识 1。知识服务迁移已修复 PostgreSQL 的数据库级权限检查问题：已有专属 Schema（数据库模式）时不再重复发起建模式语句，不授予其创建其他模式的权限。

SeaweedFS 改用 `server`（组合服务）启动模式，保留原数据布局。4.47 的 `mini`（便捷启动）模式即使禁用管理页面，仍会启动非回环管理端口；本部署不使用该模式。首次初始化只通过本机管理接口创建专用桶，业务 S3 账号没有扩大到其他桶。

## 4. 初始化与日常启动的区别

本机已经初始化，日常使用 `Start`，不要每次执行 `Setup`。

```powershell
# 重新准备开发环境／首次安装时使用；先安装 Node.js 24+、兼容 JDK 和 PostgreSQL 程序
npm ci
.\dsh-agent-deploy\native\platform.ps1 -Action Setup `
  -PostgresBin "D:\postgresql\postgresql-18.6-4-windows-x64-binaries\pgsql\bin" `
  -JavaHome "D:\jdk23"
```

`Setup`（初始化）会准备固定版本依赖、必要时初始化专属数据目录、补齐随机凭据、编译、迁移、发布本地定义和合成示例语料、启动服务。已存在的凭据不会自动轮换；Keycloak 身份域存在时不会覆盖用户。不要在有真实用户并发写入时运行迁移。发布采用不可变版本；更新模型名称、工具或技能应显式发布新版本，不是修改已发布版本。

`Start`（启动）仅复用已初始化配置，确保基础服务、消息流和业务进程就绪；不自动编译、迁移或重新发布。`Status`（状态）检查进程与健康接口。`Stop`（停止）先停运行器和业务服务，再停基础设施；应用通过受 ACL（访问控制列表）保护的控制文件触发现有优雅停止处理，超时才终止已核实身份的进程树。PostgreSQL 使用 `pg_ctl`（数据库进程管理程序）停机；Keycloak、NATS、SeaweedFS 在 Windows 下仍采用进程终止，不能代替生产无损停机机制。

进程记录包含 PID（进程标识）、可执行文件和启动时间，防止误停复用同一标识的其他进程。端口已被不受管理的进程占用时脚本报错，不会自动杀掉该进程。启动失败保留日志和数据供排查，不自动删除或重建数据库。

没有安装 Windows Service（系统服务）或开机任务；电脑重启后需重新运行 `Start`。没有配置进程自动拉起、日志轮转、备份和监控值守。启动器重新启动某项服务会重建该项标准输出／错误日志，重要诊断请先另存。

## 5. 知识、技能与工作流

默认定义为 `local-agent` 第 1 版，允许工作区列表、读取、写入及 `knowledge.search`（知识搜索）。包含 `document-review`（文档审阅）和 `brief-answer`（简短回答）原生 Skills（技能）。示例：

```powershell
node dsh-agent-deploy/native/client.mjs ask "/brief-answer 请解释 PostgreSQL 的用途"
node dsh-agent-deploy/native/client.mjs ask "请检索 local-handbook，说明 DSH平台与 PostgreSQL 的关系，并给出依据"
```

知识源配置文件是 `.local/native/knowledge-sources.json`，当前 `backend=postgres`（数据库后端）、`ragMode=hybrid`（混合检索）。使用仓库内已审核的合成示例 `company-handbook`（公司手册），**没有导入用户私人文档**。管理员可将模式改为 `fulltext`（全文）、`structured`（结构化）、`graph`（纯图谱）或 `hybrid`（混合），重启知识服务后生效；均不需要向量模型。当前访问名单仅授权 `local-user` 的实际用户标识，新用户不会自动获得该知识库权限。

`local-workflow` 第 1 版也已发布，使用 DSH 原生工作流：`draft`（初稿）→ `review`（条件复核）→ `final`（最终整理）。当前公开创建会话接口仍绑定租户默认定义，不接受任意定义参数。管理员可用以下命令切换**之后创建的新会话**；已有会话保持原绑定：

```powershell
node dsh-agent-deploy/native/platform.mjs default local-workflow
node dsh-agent-deploy/native/client.mjs ask "请审阅这段说明：数据库保存会话，消息系统投递任务。"
node dsh-agent-deploy/native/platform.mjs default local-agent
```

模型上限采用保守本机配置：运行器并发 1，运行控制全局上限 4、单用户上限 1，Agent 最多 6 次模型调用、单次输出 1024 词元、120 秒截止、最多 20 次工具调用；额外模型重试最多 1 次。其余请求可以排队，不表示能同时执行四个模型任务。DSH 原生上下文管理已启用，但跨运行的原生会话日志／压缩状态持久化仍未接入；目前每轮从数据库问答历史重建原生会话。

积分计费仍关闭：真实模型调用会产生供应商费用，平台记录用量，但尚未配置可据以实际扣积分的模型价格、汇率和账户充值。不能把测试中的示例“二十积分”当作实际账户余额。

## 6. 验收结果

本次真实环境验证通过：

- 11 个数据库角色登录、跨模式访问拒绝、错误密码拒绝。
- 私有 S3 读写删除、对象不可覆盖条件、匿名／错误签名／其他桶访问拒绝。
- 真实 Keycloak 登录、授权码与 PKCE、API 身份校验、未认证请求拒绝。
- 工作区版本冲突、路径越界拒绝、第二用户跨工作区／跨会话读取拒绝。
- 消息与会话幂等、NATS 持久投递、DSH 子进程、真实 DeepSeek 模型、工作区读取与无向量图谱／文本检索。
- SSE 运行状态和正文预览、最终回答投影到历史、第二轮上下文及显式技能调用。
- 原生 Workflow 实际执行：初稿成功、条件复核跳过、最终整理成功；默认 Agent 已恢复。
- 配额、模型用量、审计查询，以及完整停止／重启后登录、会话和存储恢复。

单次合成任务实测：请求与订阅开始到消息确认约 **52 毫秒**，首个运行状态约 **165 毫秒**，首段正文约 **2369 毫秒**，完成约 **4818 毫秒**。这个时间包含本机认证／订阅开销，不是供应商纯首词元延迟；不代表高并发性能承诺。

类型检查和全部 11 包构建通过；回归测试 129 项通过、1 项因未设置消息服务器路径跳过，随后该真实 NATS 集成测试单独运行通过，合计 130 项无失败。

最新报告保存在 `.local/native/verification.json`，首次记录备份为 `verification-2026-10-10.json`，工作流报告为 `.local/native/workflow-verification.json`；包含合成会话标识，不含密码／访问令牌。上面的时间数据来自首次记录。2026-10-11 的复验还确认了电脑重启后的历史会话恢复。测试临时文件和 S3 探测对象已删除，合成会话、审计和模型用量保留。执行以下命令会再次产生少量真实模型费用：

```powershell
.\dsh-agent-deploy\native\platform.ps1 -Action Test
```

全链路单次测试 `Test` 不会切换工作流默认值；专门的真实工作流验收结果另存于上述工作流报告。

本次运行后观察：物理内存 15.63 GiB（吉二进制字节），受管理进程工作集合计约 1.90 GiB，可用内存约 4.78 GiB，D 盘剩余约 35.18 GiB。这只说明当前小规模联调有资源余量，不能据此承诺一万用户同时执行。

## 7. 安全与维护边界

`.local/native` 的目录权限仅授予当前用户和系统账号；`.local`、`.tools` 与环境配置均被 Git（版本控制系统）忽略。数据库、对象、队列、用户、私钥和日志必须单独备份。不要删除 `.local/native/.env` 来“重置密码”：数据库内密码不会同步变更。

本机同一操作系统账号下的进程不是相互隔离的安全沙箱。当前应用只注册受控远程工具，没有 Bash（命令行解释器）、宿主文件工具或任意 MCP（模型上下文协议）接入权限。逻辑用户隔离已验证，不代表可安全运行任意不受信代码。

对外服务前另行设计 HTTPS（加密超文本传输协议）、统一入口、前端跨源访问、生产身份配置、进程监督、服务账号／消息权限、数据库备份与恢复、限流和供应商并发控制、负载与故障测试。不要直接把 `HOST`（监听地址）改成所有网卡便宣称生产上线。

排障先运行 `Status`，查看 `.local/native/logs/<服务>.stderr.log` 和 `.stdout.log`；基础服务日志为 `postgres.log`、`seaweedfs.stderr.log`。修复源码后先编译再停止／重启，`Start` 不会给运行中的进程热更新代码。

# dsh-agent-deploy：部署工程

## Windows 原生部署（不使用容器）

本机已完成原生部署，入口为 `native/platform.ps1`，详细地址、账号位置、命令、知识配置与实测记录见 [原生部署手册](../docs/native-deployment.zh-CN.md)。日常执行 `-Action Start`、`Stop`、`Status`；`Test` 会调用真实模型。当前原生配置显式启动执行器与 PostgreSQL 无向量知识服务；下文容器组合的默认开关和历史阶段状态不代表原生运行状态。

```powershell
.\dsh-agent-deploy\native\platform.ps1 -Action Status
node dsh-agent-deploy/native/client.mjs ask "你好"
```

知识检索为可选接入，见 [LightRAG 部署手册](../docs/lightrag-integration.zh-CN.md)。默认组合不启动知识服务；
`knowledge/compose.yaml` 是显式选用的附加文件，上游 LightRAG 与向量服务需独立准备，没有自动启用模型或导入用户文件。

最新实时反馈版本需要 Run Control（运行控制服务）第 **7** 版迁移，集群任务为
`dsh-agent-run-control-migrate-v7`。下文阶段版本号保留历史记录；当前升级顺序和兼容约定见
[实时反馈说明](../docs/realtime-feedback.zh-CN.md)。本轮未修改本机密钥、启用执行器或部署容器。

## 本地环境

在工作区根目录运行：

```powershell
node dsh-agent-deploy/init-dev.mjs
# 先配置 .env 中的 S3 端点、私有桶与凭据，详情见下面的存储准备。
docker compose --env-file dsh-agent-deploy/.env -f dsh-agent-deploy/compose.yaml config --quiet
docker compose --env-file dsh-agent-deploy/.env -f dsh-agent-deploy/compose.yaml up --build -d
```

Compose（容器组合编排）包含 PostgreSQL、Keycloak、NATS、消息流初始化、数据库迁移和八个默认
业务服务，另有可选执行器。只把 API、身份管理和事件服务端口绑定到 `127.0.0.1`（本机回环地址）。
数据库初始化创建独立 `chat`、`iam`、`workspace`、`catalog`、`run_control`、`quota`、`audit` 账号及模式，禁止跨模式读取。
Catalog（定义中心）在线进程额外使用 `catalog_reader`（只读账号），发布任务才使用管理账号。
数据库初始化脚本只在空数据卷上运行；修改 `.env` 不会自动轮换已有数据库密码。

Dockerfile（容器镜像构建文件）使用多阶段构建和非超级用户运行。
通过 `SERVICE`（服务项目名）构建参数分别生成各服务镜像：

```powershell
docker build -f dsh-agent-deploy/Dockerfile --build-arg SERVICE=dsh-agent-api -t dsh-agent-api:0.1.0 .
docker build -f dsh-agent-deploy/Dockerfile --build-arg SERVICE=dsh-agent-chat -t dsh-agent-chat:0.1.0 .
docker build -f dsh-agent-deploy/Dockerfile --build-arg SERVICE=dsh-agent-stream -t dsh-agent-stream:0.1.0 .
docker build -f dsh-agent-deploy/Dockerfile --build-arg SERVICE=dsh-agent-workspace -t dsh-agent-workspace:0.1.0 .
docker build -f dsh-agent-deploy/Dockerfile --build-arg SERVICE=dsh-agent-catalog -t dsh-agent-catalog:0.1.0 .
docker build -f dsh-agent-deploy/Dockerfile --build-arg SERVICE=dsh-agent-run-control -t dsh-agent-run-control:0.1.0 .
docker build -f dsh-agent-deploy/Dockerfile --build-arg SERVICE=dsh-agent-quota -t dsh-agent-quota:0.1.0 .
docker build -f dsh-agent-deploy/Dockerfile --build-arg SERVICE=dsh-agent-audit -t dsh-agent-audit:0.1.0 .
docker build -f dsh-agent-deploy/Dockerfile --build-arg SERVICE=dsh-agent-runtime-dsh -t dsh-agent-runtime-dsh:0.1.0 .
```

开发环境的 NATS 使用共享令牌。生产必须给发布器与流服务分配独立、最小权限的消息代理账号；
集群模板已经为 Chat 和 Stream 分别引用不同的凭据对象。
初始化任务独立创建保留 24 小时、总量最多 1 GiB（吉二进制字节）的事件流；
容量与保留时间是本地默认值。
另建 `DSH_RUN_REQUESTS`（运行请求流），最多 1 GiB、不按时间过期，队列满时拒绝新发布而不是淘汰旧任务。
数据库成功接纳请求后由 Run Control（运行控制服务）确认消息；任务、结果和收件箱保留政策需另行配置。
生产代理访问控制应只允许 Chat 发布运行请求，运行控制消费该主题并发布运行事件，Stream 只读公开事件。

### 存储准备和旧版本升级

Workspace（工作区服务）使用外部 S3（简单存储服务）兼容存储；本编排不自动安装对象存储产品，
也不自动创建桶。请先准备私有桶并配置 `.env` 中的 `S3_ENDPOINT`（端点）、`S3_REGION`（区域）、
`S3_BUCKET`（桶名）、`S3_ACCESS_KEY`（访问标识）与 `S3_SECRET_KEY`（访问密钥）。
初始化脚本生成的 S3 值是占位配置，不是可用凭据。
`host.docker.internal`（容器访问宿主机的名称）示例适用于桌面容器环境；其他环境改成实际可达地址。
使用专用非版本化桶，或为桶历史版本配置额外清理策略；见工作区服务说明。
就绪检查会确认桶可访问，不允许在无存储时悄悄退化为本地共享目录。

`init-dev.mjs` 会补齐缺失键但保留已有值，不轮换已存在的数据库密码。
若已有第一阶段的数据库卷，先备份，再执行非破坏性升级：

```powershell
node dsh-agent-deploy/init-dev.mjs
docker compose --env-file dsh-agent-deploy/.env -f dsh-agent-deploy/compose.yaml up -d postgres
docker compose --env-file dsh-agent-deploy/.env -f dsh-agent-deploy/compose.yaml exec postgres bash /opt/platform/upgrade-resources.sh
docker compose --env-file dsh-agent-deploy/.env -f dsh-agent-deploy/compose.yaml up --build -d
```

升级脚本只补充缺失角色和模式，不修改已有账号密码，不清除数据。数据库角色创建和服务表迁移是两步。
首次启动时 `catalog-seed`（定义种子任务）为本地租户 `local-dev` 授权预置定义；这不是生产租户配置。
运行控制版本升级沿用上述角色升级脚本，新增专属账号，不会重置既有账号密码。
先运行 `nats-init`（消息流初始化任务）创建独立任务流，再更新 Chat 与运行控制，
不能在旧消息流上直接变更保留策略或删除待运行请求。升级前的消息不自动回填任务。
后续发布使用明确的新版本和真实租户标识，旧会话不会自动切换版本。
旧会话中为空的工作区标识未回填，也不能直接用于后续模型执行。

输入快照与助手投影版本增加 `RUN_CONTROL_CHAT_SECRET`、`RUN_CONTROL_CATALOG_SECRET`
（运行控制到会话/定义中心的独立密钥）；初始化脚本只补充缺失值。
Chat 和 Run Control 均升级到第二版数据库迁移。新投影会影响消息角色与会话调度，
不承诺新旧二进制混合运行时的正确性：在维护窗口暂停消息入口与执行节点，停止旧运行控制副本，
备份后运行迁移，更新 API、Chat、Catalog、Run Control，再恢复流量。
务必先让前端兼容 `assistant`（助手）角色和回复目标字段。
本地已有已退出迁移容器时，用 `docker compose run --rm --build chat-migrate`
和 `docker compose run --rm --build run-control-migrate` 显式执行新迁移，
并带上与上述示例一致的 `--env-file` 和 `-f` 参数。不要依赖旧的已成功容器再次执行。
第二版迁移对现有消息建序号和索引，数据量大时需要预估表锁时间；没有大库在线迁移验收。
已成功的旧运行不自动投影；没有执行节点时，排队任务不会因升级而调用模型。

本地按需运行 GC（垃圾回收）：

```powershell
docker compose --env-file dsh-agent-deploy/.env -f dsh-agent-deploy/compose.yaml exec workspace node dist/gc.js
```

本地编排不自动周期回收，长期运行时需配置外部调度并监控失败；集群模板已提供定时任务。

## 接口联调

通过身份服务的授权码流程取得访问令牌后，把令牌放入当前终端环境变量
`DSH_ACCESS_TOKEN`（智能体平台访问令牌）。不要写进源代码或持久化请求日志。

```powershell
$headers = @{ Authorization = "Bearer $env:DSH_ACCESS_TOKEN"; "Idempotency-Key" = "demo-session-001" }
$session = Invoke-RestMethod http://localhost:8080/api/v1/sessions -Method Post -Headers $headers -ContentType application/json -Body '{"title":"测试会话"}'
$headers["Idempotency-Key"] = "demo-message-001"
Invoke-RestMethod "http://localhost:8080/api/v1/sessions/$($session.id)/messages" -Method Post -Headers $headers -ContentType application/json -Body '{"content":"你好"}'
$subscription = Invoke-RestMethod "http://localhost:8080/api/v1/sessions/$($session.id)/subscription" -Method Post -Headers $headers
curl.exe -N -H "Authorization: Bearer $env:DSH_ACCESS_TOKEN" -H "X-Session-Capability: $($subscription.token)" "http://localhost:8082$($subscription.endpoint)"
```

目前可看到会话创建和消息接受事件；不会生成模型回答。客户端应保存事件游标，
凭证过期后重新申请订阅并带 `Last-Event-ID`（最后事件标识）重连。
新增运行查询：`GET /api/v1/runs?sessionId=会话标识`；
取消使用 `POST /api/v1/runs/运行标识/cancel`，不带正文。没有执行进程时，运行保持排队状态。

## 集群部署

`k8s`（Kubernetes 容器编排平台清单）默认包含八个 Deployment（部署）、八个 ClusterIP Service
（集群内部服务）、配置对象、入站网络策略及工作区回收 CronJob（定时任务）。可选执行器单独启用。JSON（数据交换格式）与 YAML（配置格式）
都是 Kubernetes 原生支持的清单形式。

必须先准备：

1. 既有 Edge 网关和 `agent-platform` 命名空间；
2. PostgreSQL 的 Chat、Workspace、Catalog、Run Control 专属账号与模式，以及 Catalog 在线只读账号；
3. 已创建 `DSH_EVENTS` 和 `DSH_RUN_REQUESTS` 消息流的 NATS 服务；
4. 可用的 IAM 签发者与验证密钥集；
5. 可达的私有 S3 兼容桶及限定桶范围的访问凭据；生产端点要求加密连接；
6. 构建并推送镜像，替换 `change-me` 镜像仓库、身份域名和存储端点。

集群 Secret（密钥对象）约定：

| Secret 名称 | 必需键 |
| --- | --- |
| `dsh-agent-api-chat` | `API_CHAT_SECRET` |
| `dsh-agent-capability` | `CHAT_CAPABILITY_SECRET` |
| `dsh-agent-chat-db` | `DATABASE_URL` |
| `dsh-agent-chat-nats` | `NATS_URL`、`NATS_TOKEN` |
| `dsh-agent-stream-nats` | `NATS_URL`、`NATS_TOKEN` |
| `dsh-agent-api-workspace` | `API_WORKSPACE_SECRET` |
| `dsh-agent-chat-workspace` | `CHAT_WORKSPACE_SECRET` |
| `dsh-agent-api-catalog` | `API_CATALOG_SECRET` |
| `dsh-agent-chat-catalog` | `CHAT_CATALOG_SECRET` |
| `dsh-agent-workspace-db` | `DATABASE_URL` |
| `dsh-agent-workspace-s3` | `S3_ACCESS_KEY`、`S3_SECRET_KEY` |
| `dsh-agent-catalog-read-db` | 只读账号的 `DATABASE_URL` |
| `dsh-agent-catalog-admin-db` | 管理账号的 `DATABASE_URL`，只用于迁移及发布 |
| `dsh-agent-run-control-db` | `DATABASE_URL` |
| `dsh-agent-run-control-nats` | `NATS_URL`、`NATS_TOKEN` |
| `dsh-agent-api-run-control` | `API_RUN_CONTROL_SECRET` |
| `dsh-agent-runtime-run-control` | `RUNTIME_RUN_CONTROL_SECRET`，不发给前端聚合服务 |
| `dsh-agent-run-control-chat` | `RUN_CONTROL_CHAT_SECRET`，只发给运行控制与会话服务 |
| `dsh-agent-run-control-catalog` | `RUN_CONTROL_CATALOG_SECRET`，只发给运行控制与定义中心 |
| `dsh-agent-run-control-workspace` | `RUN_CONTROL_WORKSPACE_SECRET`，只发给运行控制与工作区；不发给执行器 |
| `dsh-agent-workspace-run-control` | `WORKSPACE_RUN_CONTROL_SECRET`，只发给工作区与运行控制，用于在线授权查询 |

先应用 `k8s/migrate.json`、`k8s/resource-migrate.yaml` 和 `k8s/run-control-migrate.yaml` 并确认 Job（批处理任务）成功，
使用受控发布任务给真实租户授权定义后，再应用 `k8s` 主清单。
迁移任务是独立发布步骤，故意没有放入主 Kustomization（配置组合）。
下次迁移需变更任务名称及版本，不能依靠重新应用已完成的任务重跑迁移。

```powershell
kubectl kustomize dsh-agent-deploy/k8s
kubectl apply -f dsh-agent-deploy/k8s/migrate.json
kubectl apply -f dsh-agent-deploy/k8s/resource-migrate.yaml
kubectl apply -f dsh-agent-deploy/k8s/run-control-migrate.yaml
kubectl apply -f dsh-agent-deploy/k8s/support-migrate.yaml
kubectl -n agent-platform wait --for=condition=complete job/dsh-agent-chat-migrate-v5 --timeout=120s
kubectl -n agent-platform wait --for=condition=complete job/dsh-agent-workspace-migrate-v2 job/dsh-agent-catalog-migrate-v1 --timeout=120s
kubectl -n agent-platform wait --for=condition=complete job/dsh-agent-run-control-migrate-v7 --timeout=120s
kubectl -n agent-platform wait --for=condition=complete job/dsh-agent-quota-migrate-v3 job/dsh-agent-audit-migrate-v2 --timeout=120s
# 此处先用 Catalog 管理连接串执行受控定义发布，详见其 README（项目说明）。
kubectl apply -k dsh-agent-deploy/k8s
```

Edge 网络策略要求 Envoy 数据面实际位于 `agent-edge-system` 命名空间。安装控制器时
应采用与这一规则一致的命名空间，或按实际数据面位置修改选择器；
Gateway 对象所在命名空间不必然等于数据面所在命名空间。

生产内部通信仍需接入 mTLS（双向传输层安全）或服务网格；
HMAC（基于密钥的消息认证码）签名只能证明服务凭证，不能加密网络传输。
本轮交付的是可渲染的部署模板，未部署到真实集群，也未执行容器镜像构建。
工作区仅允许同命名空间的 API/Chat 和未来 Runtime DSH（DSH 执行服务）工作负载入站；定义中心还允许运行控制读取定义，
会话服务还允许运行控制读取上下文并投影回答。它们不直接经过公网网关。
会话网络策略保留原资源名称 `chat-from-api-only`（原“仅来自前端聚合服务”），
实际选择器已扩展运行控制，避免升级时留下旧命名资源；HTTP 凭据仍按接口分开。
实际数据库和对象存储出站策略需要按环境配置，模板未假定固定供应商地址。
运行控制接受前端聚合服务、未来执行服务和工作区的集群入站连接；管理、执行、授权查询接口使用各自独立凭据。
执行服务采用单独启用的最小核心容器，不要将上游默认的本地文件/Bash（命令解释器）配置直接接入多租户部署。

受限工具版本不增加数据库迁移；运行 `init-dev.mjs`（本地配置初始化脚本）补充上述两把密钥，
重新构建 Workspace 与 Run Control。必须同时更新集群密钥与网络策略，不能只更新镜像。
工作区通过既有配置中的 `RUN_CONTROL_URL`（运行控制地址）执行在线授权；
运行控制没有对工作区的启动依赖，工作区就绪探针也不探测运行控制，以免形成部署启动循环。
授权服务故障时工具调用拒绝执行，前端文件管理仍使用原有独立认证。

## 第六阶段：显式启用 DSH 执行器

新增 `dsh-agent-runtime-dsh`（DSH 执行服务），不访问数据库或消息代理，不挂载用户目录。
先阅读 [运行器说明](../dsh-agent-runtime-dsh/README.md) 的预算、凭据和取消边界。
本阶段没有新增数据库迁移，但依赖此前 Chat（会话服务）与 Run Control（运行控制服务）的第二版迁移。

### 本地容器

默认 Compose（容器组合编排）不启动执行器。运行 `node dsh-agent-deploy/init-dev.mjs` 补充缺失配置，
不会覆盖现有值，也不会生成或查找真实模型密钥。启用前必须：

1. 完成基础服务、私有对象存储与定义授权配置；核对模型名称和运行预算。
2. 检查每个用户的排队任务，对不再需要的任务执行取消；启用后现有排队任务也可能被执行并计费。
3. 在受保护的 `.env`（环境配置文件）中设置 `DEEPSEEK_API_KEY`（模型接口密钥），将 `RUNTIME_ENABLED`（是否启用运行）改为 `true`（开启）。
4. 显式使用 `runtime`（执行器）配置组启动：

```powershell
docker compose --env-file dsh-agent-deploy/.env -f dsh-agent-deploy/compose.yaml --profile runtime up --build -d
```

只有配置组和运行开关都启用才领取任务；未提供密钥则启动失败，不回退到宿主机凭据。
执行器不映射宿主端口，根文件系统只读，以非特权用户运行，内存上限为 1 GiB（吉二进制字节）。
要停止领取并终止当前执行器，可运行：

```powershell
docker compose --env-file dsh-agent-deploy/.env -f dsh-agent-deploy/compose.yaml --profile runtime stop runtime-dsh
```

然后把开关恢复为 `false`（关闭），防止后续启动误执行。停止不会撤回已提交文件；在途写入可能完成。

### Kubernetes（容器编排平台）

`k8s/runtime/runtime-dsh.yaml` 是独立的 Deployment（部署）与 NetworkPolicy（网络策略）模板，
故意不加入默认配置组合，初始 `replicas: 0`（副本为零）且 `RUNTIME_ENABLED=false`（关闭）。
准备并推送执行器镜像、替换 `change-me`（待替换）镜像名后，通过集群密钥管理流程创建：

| Secret（密钥对象） | 键与用途 |
| --- | --- |
| `dsh-agent-runtime-run-control` | 既有 `RUNTIME_RUN_CONTROL_SECRET`（运行节点身份密钥），与运行控制保持一致 |
| `dsh-agent-runtime-model` | 新增 `DEEPSEEK_API_KEY`（模型接口密钥），只交给执行器 |

确认待运行任务后，将模板中运行开关改为开启、副本改为所需数量，再由发布流程应用该模板。
可用 `kubectl kustomize dsh-agent-deploy/k8s/runtime` 单独渲染检查；发布入口为 `kubectl apply -k dsh-agent-deploy/k8s/runtime`。
每副本一次执行一个任务，默认随机工作节点标识，不能为多个副本固定同一个标识。
运行控制的全局并发上限仍生效；新增副本不会绕过它。

模板不允许入站业务流量；出站只开放同命名空间的工作区/运行控制端口、
`kube-system`（集群系统命名空间）的 DNS（域名解析服务）端口，以及排除常见内网段后的 IPv4（第四版互联网协议）公网 443 端口。
公网 443 规则不是模型域名白名单；生产应使用受控出口代理进一步收敛到批准的模型目的地。
需按实际集群网段、解析服务位置和 CNI（容器网络接口）实现验收规则；模板未涵盖 IPv6（第六版互联网协议）、
节点本地解析或私有模型网关。网络策略不能替代应用鉴权，也不能隔离同一容器内的父子进程。

以上只完成静态模板与本机模拟模型测试，尚未实际构建容器镜像、访问真实模型或部署到集群。

## 第七阶段：配额、审计与会话管理升级

新增两个默认启动的内部服务，执行器仍需显式启用。
**先停止执行器、等待在途执行结束，并暂停入口写入，再升级数据库与服务。**
升级前已冻结的输入未做配额预留，不应让旧执行进程跨版本继续运行；旧运行不追溯扣费，历史审计不伪造回填。

本地升级步骤：

1. 执行 `node dsh-agent-deploy/init-dev.mjs` 补齐缺失凭据；保留已有密码、对象存储与运行开关。
2. 新数据卷会自动创建新角色。已有数据卷先使数据库容器加载新增环境和脚本挂载，再执行：

```powershell
docker compose --env-file dsh-agent-deploy/.env -f dsh-agent-deploy/compose.yaml up -d postgres
docker compose --env-file dsh-agent-deploy/.env -f dsh-agent-deploy/compose.yaml exec postgres bash /opt/platform/upgrade-support.sh
docker compose --env-file dsh-agent-deploy/.env -f dsh-agent-deploy/compose.yaml run --build --rm chat-migrate
docker compose --env-file dsh-agent-deploy/.env -f dsh-agent-deploy/compose.yaml run --build --rm run-control-migrate
docker compose --env-file dsh-agent-deploy/.env -f dsh-agent-deploy/compose.yaml run --build --rm quota-migrate
docker compose --env-file dsh-agent-deploy/.env -f dsh-agent-deploy/compose.yaml run --build --rm audit-migrate
docker compose --env-file dsh-agent-deploy/.env -f dsh-agent-deploy/compose.yaml up --build -d
```

以上命令不删除数据卷。首次升级到前几阶段的旧数据库仍需先按原步骤执行资源角色升级。
会话和运行控制要求第三版迁移，新增两个服务要求第一版迁移。完成后核对配额策略，再考虑重新开启执行器。
配额服务故障会阻止新输入交付；审计服务故障由运行控制发件箱保留重试，不依赖审计就绪才能启动模型。

新增本地凭据包括 `QUOTA_DB_PASSWORD`（配额数据库密码）、`AUDIT_DB_PASSWORD`（审计迁移密码）、
`AUDIT_WRITER_DB_PASSWORD`（审计在线写入密码），以及下表中的四把服务身份密钥。

| 集群 Secret（密钥对象） | 必需键与用途 |
| --- | --- |
| `dsh-agent-quota-db` | `DATABASE_URL`，配额专属账号 |
| `dsh-agent-audit-db` | `DATABASE_URL`，审计在线写入账号，不是模式所有者 |
| `dsh-agent-audit-admin-db` | `DATABASE_URL`，仅供审计迁移使用的模式所有者账号 |
| `dsh-agent-api-quota` | `API_QUOTA_SECRET`，聚合服务和配额服务共享 |
| `dsh-agent-api-audit` | `API_AUDIT_SECRET`，聚合服务和审计服务共享 |
| `dsh-agent-run-control-quota` | `RUN_CONTROL_QUOTA_SECRET`，仅运行控制和配额服务共享 |
| `dsh-agent-run-control-audit` | `RUN_CONTROL_AUDIT_SECRET`，仅运行控制和审计服务共享 |

配额上限通过配额容器环境配置，默认用户并发 2、租户并发 32，日输出预留分别为一百万和一亿词元，
不是供应商费用限额。自定义配置的变量见配额服务说明；所有副本必须使用同一策略。
新增 `k8s/support.yaml`（支撑服务模板）已加入默认配置组合；迁移文件单独应用，不能让在线审计进程使用管理账号。
两个服务没有宿主端口，集群仅允许聚合服务和运行控制入站。所有新增密钥都不发给执行器。

聚合服务新增本人配额、本人运行审计查询及会话部分修改接口，完整结构由公共协议生成。
审计仅覆盖本阶段运行生命周期；未覆盖文件访问等全来源事件，尚无管理员合规导出。
本阶段仍只做静态部署验证，未实际执行以上升级命令或接入真实数据库集群。

## 第八阶段：变更审计与内部监控

本节为当前升级要求；前述阶段记录保留历史含义。本轮不启用模型执行、不暴露新的公网路由。
Chat（会话服务）执行第四版迁移，Workspace（工作区服务）与 Audit（审计服务）执行第二版迁移。
运行控制仍为第三版；其他模式版本不变。新增表只保留升级后的事件，不回填历史。

在维护窗口备份数据库、暂停入口写入并停止执行器及旧写入副本，再进行升级：

1. 运行 `node dsh-agent-deploy/init-dev.mjs` 补齐缺失密钥；它不会覆盖旧值，也不会把原来开启的运行器自动关闭。
2. 使用本说明相同的容器组合参数，显式运行 `audit-migrate`、`chat-migrate`、`workspace-migrate` 三个迁移任务；不能依赖已成功退出的旧迁移容器。
3. 先更新 Audit 与 API（前端聚合服务），使其接受三种生产者的审计协议，再更新 Chat、Workspace 和 Run Control（运行控制服务）。所有镜像须从新公共协议重新构建。
4. 核对就绪检查、独立凭据和审计积压，再恢复业务入口；执行器是否启用仍需单独确认。

集群迁移任务名称以本页当前命令为准。新增密钥均至少 32 字符且不能复用业务密钥：

| Secret（密钥对象） | 必需键 | 使用范围 |
| --- | --- | --- |
| `dsh-agent-chat-audit` | `CHAT_AUDIT_SECRET` | 会话与审计服务 |
| `dsh-agent-workspace-audit` | `WORKSPACE_AUDIT_SECRET` | 工作区与审计服务 |
| `dsh-agent-chat-metrics` | `CHAT_METRICS_SECRET` | 会话与监控采集器 |
| `dsh-agent-workspace-metrics` | `WORKSPACE_METRICS_SECRET` | 工作区与监控采集器 |
| `dsh-agent-run-control-metrics` | `RUN_CONTROL_METRICS_SECRET` | 运行控制与监控采集器 |

会话和工作区通过 `AUDIT_URL`（审计服务地址）投递，各自持有独立身份。
审计接收端故障不会阻断业务提交；所属服务本地审计发件箱写入失败则回滚业务事务。
源站凭据决定事件生产者，不能通过修改正文冒充其他服务。在线审计账号仍不可更新或删除记录。
指标使用独立不透明持有者凭据，不是业务身份令牌；未授权抓取不会触发数据库查询。

默认集群组合增加审计生产者入站策略，以及同命名空间、标签为
`app.kubernetes.io/name=dsh-agent-monitor` 的监控工作负载到三个指标服务的入站策略。
网络策略只限制端口，不能限制请求路径；应用认证仍是必需边界。新增凭据均不发给执行器。

[监控接入说明](monitoring/README.md) 提供 Prometheus（指标采集系统）配置、七条告警和规则测试夹具。
模板未创建监控服务器、凭据挂载或通知接收器；尚未验证真实抓取与通知。
审计仍不覆盖读取、拒绝请求和身份事件；指标没有用户、租户、文件路径或消息正文标签。

## 第九阶段：模型用量采集

本节记录第九阶段要求；后续工作流升级以第十阶段为准。运行控制执行第四版迁移，配额执行第二版迁移；会话第四版、工作区第二版、审计第二版不变。
没有新增长期密钥、容器、端口或网络策略。运行器默认关闭，不自动调用模型。

维护窗口暂停入口写入，停止执行器并处理在途运行，停止旧运行控制消费者，备份数据库后执行：

```powershell
docker compose --env-file dsh-agent-deploy/.env -f dsh-agent-deploy/compose.yaml run --build --rm quota-migrate
docker compose --env-file dsh-agent-deploy/.env -f dsh-agent-deploy/compose.yaml run --build --rm run-control-migrate
docker compose --env-file dsh-agent-deploy/.env -f dsh-agent-deploy/compose.yaml up --build -d quota
docker compose --env-file dsh-agent-deploy/.env -f dsh-agent-deploy/compose.yaml up --build -d api run-control
```

以上命令须在既有基础服务和此前迁移已就绪时使用；不删除数据卷。
之后更新执行器镜像，按原有启用流程单独决定是否恢复执行，切勿让旧执行器继续运行却误认为已有完整计量。
集群沿用 `run-control-migrate.yaml` 与 `support-migrate.yaml`（迁移清单），任务版本名称已更新。
先升级配额接收端，再升级运行控制/聚合服务，最后执行器；旧运行控制不认识新增计量票据，不能混合消费。

新增接口 `GET /api/v1/usage`（本人日用量统计）；数据通过事务发件箱异步汇总，预算预留行为保持不变。
原始计量表与已投递票据尚无归档策略，需按数据量规划容量。细节见 [模型用量说明](../docs/model-usage.zh-CN.md)。
本轮只完成模拟供应商协议测试与部署静态验证，未实际执行以上迁移或启动服务。

## 第十阶段：顺序工作流

当前运行控制需第五版迁移。其他模式版本不变，没有新增服务、密钥、端口或网络策略。
新表保存步骤状态与中间结果，模型调用表新增可空步骤标识；旧运行不回填工作流。

先暂停入口写入、停止执行器、处理在途运行并备份数据库，再执行运行控制迁移：

```powershell
docker compose --env-file dsh-agent-deploy/.env -f dsh-agent-deploy/compose.yaml run --build --rm run-control-migrate
```

重新构建所有服务，确保使用新协议。先升级定义读取方、运行控制和聚合服务，后升级执行器。
集群对应 `job/dsh-agent-run-control-migrate-v5`（第五版迁移任务）；先确认任务成功，再更新工作负载。
所有旧执行器停止后才能发布含工作流的新定义；不能让旧进程忽略工作流、直接运行顶层提示词。

示例 `document-review-workflow.v1.json`（文档审阅工作流第一版）不会自动发布或设为默认，
其中模型名称是占位值。发布前核对模型、租户和预算，见 [工作流说明](../docs/workflow.zh-CN.md)。
切换默认版本只影响新会话，不覆盖旧定义或切换旧会话。执行器仍需独立显式启用，不因迁移自动调用模型。

步骤中间结果保存在运行控制数据库，属于用户业务数据，需沿用访问控制、备份与保留政策；目前未提供自动归档或恢复。
本轮验证限于本机模拟模型、数据库兼容引擎和部署静态配置，未执行真实迁移或生产部署。

## 第十一阶段：按用量结算积分

配额需第三版迁移；运行控制第五版、会话第四版、工作区第二版、审计第二版保持不变。
暂停入口、停止旧执行器及运行控制、处理在途运行、备份数据库后，重新运行 `quota-migrate`（配额迁移任务）。
集群对应 `job/dsh-agent-quota-migrate-v3`（第三版迁移任务）。重新构建全部协议使用方，先升级配额接收端，后升级聚合与运行控制。

`POINTS_BILLING_ENABLED`（积分计费启用开关）默认 `false`（关闭）。容器组合可以通过本地环境文件配置；集群需修改配额工作负载中的同名变量。
先完成受控价格发布、公司发放及员工分配，再统一启用全部配额副本，不得混用开关值。旧运行控制必须退出，否则缺少调用总数而不能安全释放积分冻结。
没有新服务、端口或密钥；执行器保持独立启用。旧运行无计价快照不追收；关开关不会取消已冻结运行的结算。

管理命令、模拟价格、舍入及不足余额边界见 [积分计费说明](../docs/points-billing.zh-CN.md)。
没有支付充值、退款或缺失计量补录功能；冻结额不是实际费用硬上限，生产启用前需评估。

## 第十二阶段：高并发保护与执行槽

Chat（会话服务）执行第五版迁移，Run Control（运行控制）执行第六版迁移；Quota（配额服务）第三版不变。
在维护窗口暂停新写入，停止旧执行器/运行控制并处理在途任务，备份数据库后执行：

```powershell
docker compose --env-file dsh-agent-deploy/.env -f dsh-agent-deploy/compose.yaml run --build --rm chat-migrate
docker compose --env-file dsh-agent-deploy/.env -f dsh-agent-deploy/compose.yaml run --build --rm run-control-migrate
```

重建所有镜像并更新工作负载；所有同类副本使用一致的新限流/调度配置，不能让旧 Chat 继续绕过门禁。
集群任务为 `dsh-agent-chat-migrate-v5` 与 `dsh-agent-run-control-migrate-v6`。旧阶段文字仅保留历史记录。
容器组合已映射并发参数，集群默认 API（前端聚合服务）在途 128、会话发布 2、支撑及回写各 2、执行槽 1。
数据库池与等待容量在 Chat/Run Control 各自配置，不能按副本无限增大；后台占连接，须给续租和前台留余量。
执行器仍默认关闭，积分开关不改变。未自动执行迁移、扩大副本数、增加模型并发或变更现有环境文件。

配置与剩余瓶颈见 [高并发说明](../docs/high-concurrency.zh-CN.md)，实验结果见 [本机负载记录](../docs/load-test-results.zh-CN.md)。

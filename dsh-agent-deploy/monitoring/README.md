# 后端积压指标与告警模板

本目录提供 Prometheus（时序监控系统）的抓取配置、告警规则和规则测试夹具，不会自动安装监控服务器或发送通知。
现有平台不增加新的公共端口。配置文件使用 JSON（数据交换格式）写法保存为 YAML（配置格式）兼容文档。

## 指标边界

Chat（会话服务）、Workspace（工作区服务）和 Run Control（运行控制服务）提供内部 `GET /metrics`（读取指标）接口。
每个服务使用独立的静态 Bearer（持有者）凭据，不能使用用户身份令牌、服务调用令牌或其他服务的指标凭据。
未配置指标选项的测试应用不挂载接口；生产入口要求配置相应密钥。无凭据返回 401；读取数据库失败返回 503，
不会伪造正常的零值。日志隐藏请求授权头；接口不返回用户、租户、运行标识、文件路径或正文。

指标为 Gauge（瞬时数值），来自服务自己的数据库，反映整个服务数据域，而非单个进程。
如果采集多个副本，应按抓取任务取最大值，不要求和，避免重复计算同一数据库的积压。
当前模板每个服务抓取一个 ClusterIP（集群内部地址），只反映服务级可抓取性，不能证明每个 Pod（容器组）健康。
抓取间隔 30 秒，超时 10 秒；并发抓取在同一进程合并为一次数据库查询。大数据量下聚合扫描仍需压测。

| 前缀与指标 | 中文含义 |
| --- | --- |
| `dsh_chat_audit_pending`、`dsh_workspace_audit_pending` | 各自待投递审计数量 |
| 对应前缀的 `audit_oldest_age_seconds`、`audit_max_attempts` | 最老未完成审计年龄（秒）与最大失败重试次数 |
| `dsh_chat_events_pending`、`dsh_chat_events_oldest_age_seconds` | 会话公开事件及运行请求发件箱的积压数量与年龄 |
| `dsh_workspace_blobs_staged`、`dsh_workspace_blobs_gc_pending` | 暂存对象数量、已达到回收时间但尚未清理的对象数量 |
| `dsh_run_control_runs_queued`、`runs_running`、`runs_overdue` | 排队、运行中及已过期但未收敛的任务数量，后两项使用相同前缀 |
| `dsh_run_control_support_pending`、`support_due` | 所有待投递与已到投递时间的支撑票据数量，后者使用相同前缀 |
| 同前缀的 `support_oldest_age_seconds`、`support_max_attempts` | 最老支撑票据年龄与最大失败重试次数 |
| 同前缀的 `support_retry_oldest_age_seconds` | 已失败重试票据的最老年龄；用于排除正常延迟关闭配额的误报 |
| 同前缀的 `projections_pending`、`projections_max_attempts` | 待投影助手回答数量与最大投影失败次数 |

## 接入

1. 使用既有监控平台，把配置与规则一起挂载到其工作目录。模板使用集群服务域名；本地容器网络需改成 `chat:8080`、`workspace:8080`、`run-control:8080`。
2. 通过受保护的密钥挂载提供下表中的文件，文件内容只包含凭据本身，不含 `Bearer` 前缀。不要把密钥写入配置仓库。
3. 抓取端放在 `agent-platform`（平台命名空间）并带 `app.kubernetes.io/name=dsh-agent-monitor`（监控工作负载标签），以匹配新增网络策略。
   其他监控命名空间需按真实部署收敛网络规则，不要改成全部允许。
4. 加载抓取配置和规则后验证目标、指标和告警状态。接入通知必须另配 Alertmanager（告警通知管理器）及收件人；本次未配置或发送通知。

| 凭据文件 | 对应业务服务变量 |
| --- | --- |
| `/etc/prometheus/secrets/chat` | `CHAT_METRICS_SECRET`（会话指标密钥） |
| `/etc/prometheus/secrets/workspace` | `WORKSPACE_METRICS_SECRET`（工作区指标密钥） |
| `/etc/prometheus/secrets/run-control` | `RUN_CONTROL_METRICS_SECRET`（运行控制指标密钥） |

模板使用内部 HTTP（超文本传输协议），凭据本身不加密流量；生产应配合 TLS（传输层安全）或服务网格。
网络策略只能控制端口，不能只开放该端口上的某条路径，所以监控凭据不能用于业务接口。
参考官方[抓取认证配置](https://prometheus.io/docs/prometheus/latest/configuration/configuration/#http_config)，模板通过凭据文件设置授权头并关闭重定向。

## 告警与验收

规则覆盖抓取故障、审计积压、消息发布积压、支撑投递失败、助手投影失败、过期任务清扫停滞和对象回收积压。
阈值是初始模板，不是已验证的生产 SLO（服务级别目标）。持续满足条件一段时间后才触发，
具体机制见官方[告警规则说明](https://prometheus.io/docs/prometheus/latest/configuration/alerting_rules/)。
没有配置抓取任务时不会自动创建该目标的故障告警；监控平台本身的缺失检测需另外接入。

在本目录内，用已安装的 `promtool`（监控规则验证工具）执行：

```powershell
promtool check rules alerts.yaml
promtool test rules rules.test.yaml
# 配置的凭据文件已经挂载后，再检查实际抓取配置：
promtool check config prometheus.yaml
```

当前环境没有安装该工具，未执行规则语义验证、实际抓取和通知联调。
已经验证服务指标端点的鉴权、故障响应、聚合数值和并发抓取；监控文件另做结构与指标引用检查。
审计及已发送发件箱尚无自动归档/清理策略，应同时监控数据库容量，不要直接删除未投递票据来消除告警。

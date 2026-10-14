# LightRAG 知识图谱接入手册

日期：2026-09-28。选择 LightRAG（轻量知识图谱检索增强生成）官方 `v1.5.7`，平台新增 `dsh-agent-knowledge`（知识访问服务）。接入代码已实现，真实服务启动、向量模型和文档入库仍需配置与验收；本文不将模拟响应测试称为真实知识库已上线。

## 为什么选它

LightRAG 同时提供图谱与向量检索，`POST /query/data`（结构化检索）直接返回实体、关系和文档片段，适合复用既有 DSH（DeepSeek 智能体执行框架）来生成最终回答。部署可用原生 Python（脚本语言）服务，不强制 Docker（容器工具）；第一版无需新增自研向量或图数据库实现。

选型依据均核对官方固定版本，而不是依赖社区转述：

- [官方 v1.5.7 发布](https://github.com/HKUDS/LightRAG/releases/tag/v1.5.7)。
- [固定版查询协议及实现](https://github.com/HKUDS/LightRAG/blob/v1.5.7/lightrag/api/routers/query_routes.py)：`mix`（图谱/向量混合）、`hybrid`（图谱混合）、结构化结果与显式关键词。
- [固定版服务启动代码](https://github.com/HKUDS/LightRAG/blob/v1.5.7/lightrag/api/lightrag_server.py)：工作区由实例启动配置绑定，不把本平台的用户标识当作原生动态隔离头。
- [官方配置示例](https://github.com/HKUDS/LightRAG/blob/v1.5.7/env.example)、[安装包元数据](https://pypi.org/project/lightrag-hku/1.5.7/)：Python 3.10+、独立生成模型和向量模型配置。

我们使用固定 HTTP（超文本传输协议）适配而非加载全部 MCP（模型上下文协议）工具，原因是本次只需检索，不能顺带开放上游上传、删除或图谱写入。未来可增加受控 MCP 适配，但不因此绕过租约和源授权。

## 1. 准备一个私有 LightRAG 实例

准备 Python 3.10+，在仓库根目录创建独立虚拟环境并安装锁定的顶层版本：

```powershell
python -m venv .tools/lightrag-venv
& .tools/lightrag-venv/Scripts/python.exe -m pip install -r dsh-agent-deploy/knowledge/requirements.txt
```

上面是操作步骤，本轮未执行安装。顶层版本固定不代表全部传递依赖已锁定；生产还需锁定依赖、漏洞审计和许可证检查。

在 `.local/lightrag/handbook/` 创建私有运行目录，将 [LightRAG 环境示例](../dsh-agent-deploy/knowledge/lightrag.env.example) 保存为该目录的 `.env`（环境配置）。至少填写：

| 设置 | 含义 |
| --- | --- |
| `LIGHTRAG_API_KEY` | 随机生成的服务密钥，至少 32 字符，不是 DeepSeek 密钥 |
| `HOST=127.0.0.1` | 仅本机监听；不直接暴露浏览器或局域网 |
| `WHITELIST_PATHS=/health` | 只豁免健康接口；**不能沿用上游包含 `/api/*` 的默认豁免**，否则部分兼容接口可能未认证即可读知识或调用模型 |
| `WORKSPACE` / `WORKING_DIR` / `INPUT_DIR` | 上游工作区 / 存储目录 / 输入文档目录；独立私有语料不能共用 |
| `LLM_BINDING=openai` | 使用 OpenAI 兼容协议，不表示必须使用 OpenAI 模型 |
| `LLM_BINDING_HOST` / `LLM_BINDING_API_KEY` / `LLM_MODEL` | 配置已获授权的 DeepSeek 兼容端点、密钥和模型，用于入库抽取等上游操作 |
| `EMBEDDING_BINDING` / `EMBEDDING_BINDING_HOST` / `EMBEDDING_BINDING_API_KEY` | Embedding（向量表示）服务类型、端点与凭据，独立于聊天模型 |
| `EMBEDDING_MODEL` / `EMBEDDING_DIM` | 向量模型名和实际输出维度，必须一致；建库后不能直接换维度继续写入旧索引 |

**当前缺少经确认的向量模型配置。** 只有 `DEEPSEEK_API_KEY`（聊天模型密钥）不能完成本接入的向量依赖。可以选已有兼容向量接口，或单独部署本地向量服务；选择后需要填写真实端点、模型、维度并测试。此处没有假设你的聊天端点提供向量接口，也没有下载大型模型或使用未知账号。

配置好后，在专属目录运行：

```powershell
Push-Location .local/lightrag/handbook
try {
  & ../../../.tools/lightrag-venv/Scripts/lightrag-server.exe
} finally {
  Pop-Location
}
```

这是前台运行命令，关闭终端可能结束服务；尚未提供 Windows（视窗操作系统）服务注册或自动重启管理。若作为后台进程启动，应隐藏窗口、记录进程身份及日志，并设置受控停机，不应通过终止所有同名进程停止实例。

使用 LightRAG 自身已认证的管理界面/文档导入接口录入有权限处理的文档。导入会把内容发送给配置的抽取/向量提供方并可能产生费用，先确认数据授权和费用，再导入真实公司文档。平台不会自动上传现有用户文件。

## 2. 配置平台桥接

1. 复制 [源配置](../dsh-agent-knowledge/sources.example.json) 到 `.local/knowledge/sources.json`，替换真实租户和用户主体；一个知识库中的全部内容都必须允许列出的读者访问。
2. 为知识服务配置 LightRAG 端点及对应密钥。端点不能包含用户名、密码、路径、查询串或片段；用户和模型不能提交端点。
3. 随机生成两把互不相同且不同于其他服务的 32 字节以上签名密钥，在运行控制与知识服务分别配置 `RUN_CONTROL_KNOWLEDGE_SECRET`、`KNOWLEDGE_RUN_CONTROL_SECRET`。不要在这里展示或硬编码真实密钥。
4. 给执行器只配置 `KNOWLEDGE_URL`，不配置 LightRAG 凭据或签名密钥。
5. 构建所有服务，先升级运行控制和知识服务，再升级执行器。默认不启用模型、不改积分开关。
6. 审核并发布 [知识智能体定义示例](../dsh-agent-catalog/definitions/knowledge-agent.v1.json)，替换模型占位名；`knowledgeSources`（允许知识源）必须与来源文件一致。创建新会话使用新定义，已有会话不自动升级。

具体进程参数、工具约束和服务说明见 [知识服务说明](../dsh-agent-knowledge/README.md)。本轮没有新增业务数据库模式，现有数据库仍使用 PostgreSQL（关系型数据库）。LightRAG 默认存储是独立基础设施；本轮没有替你配置其 PostgreSQL 存储后端或在现有库安装向量扩展。

公司共享库应明确列出允许读者；个人库只列个人。不能在同一个包含全部用户文档的端点上仅依赖模型传 `uid`（用户标识）实现隔离。多个端点/实例按语料隔离，不等于每用户必须创建一个 Pod（容器工作负载）；共享授权语料可复用一个端点，但大量个人语料的上游隔离与资源规模还需设计和压测。

## 3. 可选容器组合接入

[附加组合配置](../dsh-agent-deploy/knowledge/compose.yaml) 只启动平台知识桥接服务，并给运行控制/执行器补充配置；它**不下载或启动 LightRAG**，也不影响未使用此附加文件的默认部署。

```powershell
docker compose --env-file dsh-agent-deploy/.env --env-file .local/knowledge/compose.env `
  -f dsh-agent-deploy/compose.yaml -f dsh-agent-deploy/knowledge/compose.yaml `
  --profile knowledge config --quiet
```

检查通过后再使用相同参数执行 `up --build -d`（构建并后台启动）。附加环境文件需设置两把知识密钥、`LIGHTRAG_PERSONAL_API_KEY`（源密钥）、`KNOWLEDGE_SOURCES_FILE`（宿主源文件绝对路径）。其他源凭据需要自行增加对应环境映射。

原生回环地址上的 LightRAG 不保证可从容器访问；源地址必须从知识容器内部可达，不能把 `127.0.0.1` 当作宿主。不要为解决连接而直接将未受防护的上游管理服务暴露公网。此开发覆盖使用明文私网；生产应提供加密源地址、最小网络权限与密钥管理。尚未提供知识服务 Kubernetes（容器编排平台）专用清单和集群验收。

## 4. 真实验收清单

模拟测试通过后仍需逐项验收，不能省略：

- 向量模型真实返回维度与配置相同，导入文档后索引任务完成。
- 无密钥访问 `/query/data`、兼容模型接口及写入接口应被拒绝；`/health` 允许公开不代表其他接口可公开。
- 用唯一测试事实导入一份文档；查询实际返回包含该事实的片段、实体和关系。
- 只授权用户甲后，从用户甲运行检索成功；用户乙、另一租户同名用户均被拒绝且不触发上游调用。
- 检索过程中取消运行或使租约过期，不再向执行器返回检索内容。
- 通过真实 DSH 调用工具并带真实引用回答；运行结果投影、状态流和原有文件工具不受影响。
- 明确上游抽取/向量费用的承担者；这些费用当前不自动计入平台积分账本。
- 备份并验证每个语料库的存储、索引、模型维度和权限配置，确认跨库没有共享错误。

当前不包括检索持久审计、源配置热更新、用户自助上传、文档级权限过滤、知识增量同步、图谱写入、真实效果评测或大规模压力测试。已有隔离针对**整库授权**，不能声称支持同一库内逐文档可见性。

# 无向量 RAG（检索增强生成）配置与运维

更新：2026-10-08。本轮实现无需 Embedding Model（向量模型）的知识检索；最终回答仍由已有 DSH（DeepSeek 智能体执行框架）调用语言模型生成。无需部署 LightRAG（轻量知识图谱检索增强生成服务）、向量数据库或额外分词服务。原有 LightRAG 后端保留，旧配置不带 `backend` 时仍按 LightRAG 解析。

## 1. 模式由可信管理员配置

| `backend`（检索后端） | `ragMode`（检索模式） | 检索数据与方法 | 需要向量模型 |
| --- | --- | --- | --- |
| `postgres` | `fulltext`（全文） | 文档标题、正文的词项索引与排序 | 否 |
| `postgres` | `structured`（结构化） | 审核后的记录副本；字段等值过滤，无过滤时检索记录文本 | 否 |
| `postgres` | `graph`（图谱） | 实体名称、别名、描述定位；双向关系遍历 | 否 |
| `postgres` | `hybrid`（混合） | 上述三种检索证据轮流合并，避免一种结果独占名额 | 否 |
| `lightrag` | 不配置此字段 | 使用已有固定 `/query/data`（结构化检索接口）适配 | 由 LightRAG 实例配置决定；原有图谱/向量方案不保证免向量 |

配置示例：[sources.nonvector.example.json](../dsh-agent-knowledge/sources.nonvector.example.json)。可以只保留一种源，也可以为不同场景配置不同源；同一语料库被多个源指向表示有意共享。修改配置后重启知识服务生效，尚无热更新或源管理页面。

```json
{
  "sources": [{
    "id": "personal-handbook",
    "backend": "postgres",
    "corpusId": "company-handbook",
    "ragMode": "fulltext",
    "readers": [{ "tenantId": "local-dev", "uid": "REPLACE_WITH_USER_SUB" }]
  }]
}
```

`corpusId`（语料库标识）只能来自管理员配置，不能由模型传入。`readers`（读者）采用精确 `tenantId + uid`（租户与用户）匹配；整个语料库授权，不提供逐文档权限。个人私有库必须使用不同语料库标识和不同读者配置，不能将全部用户指向一个共享库再依赖提示词隔离。

工具请求仍为 `knowledge.search`（知识检索），模型侧名称 `knowledge_search`。模型选择已获授权的 `sourceId`（源标识），不能改源后端。请求中的 `mode`（LightRAG 检索选项）为兼容旧接口而保留，仅对 LightRAG 生效；它不能覆盖管理员的 `ragMode`。无向量模式可以省略 `mode`。

结构化源额外配置 `filterFields`（可过滤字段），例如 `["department", "points", "active"]`；请求 `filters`（过滤条件）只允许白名单字段的字符串、数字、布尔、空值等值匹配，最多 8 个条件且同时满足。没有任意 SQL（结构化查询语言）、Cypher（图查询语言）、表名、投影、表达式、区间、排序或跨服务查询能力。

```json
{
  "tool": "knowledge.search",
  "arguments": {
    "sourceId": "company-records", "query": "研发员工积分",
    "keywords": ["积分"], "filters": { "department": "engineering", "points": 20 },
    "limit": 5
  }
}
```

`fulltext` 和 `graph` 源拒绝非空过滤条件；LightRAG 也拒绝，避免悄悄忽略条件。`hybrid` 中过滤只约束结构化记录，不约束文档或图谱；若要全部证据都满足某个业务条件，应配置专用语料库或仅使用结构化源。请在审核后的智能体 `systemPrompt`（系统提示词）中说明允许的字段及其值，模型并不会自动读取源配置。

## 2. 数据归属与发布

知识服务仅访问自身 `knowledge`（知识）数据库模式中的五张表：语料版本、文档、记录、实体、关系。不读取会话、工作区、定义、配额等服务的业务表。结构化数据为管理员导入的审核副本，**不是直接查询公司生产业务数据库**；后续实时同步应由数据所有者通过受控接口发布，而不是赋予知识服务跨库读取权。

[corpus.example.json](../dsh-agent-knowledge/corpus.example.json) 是可导入的示例 JSON（结构化数据格式）。各类数据可单独提供；全文源需要文档，结构化源需要记录，图谱源需要实体和关系。正文不会自动变成图谱，当前没有模型实体抽取、上传、自动切块、工作区同步或图谱编辑页面。

文件最大 16 MiB（兆二进制字节）；文档、记录、实体各最多 10000 项，关系最多 20000 项；每类标识不得重复，关系两端必须存在于同库实体。文档正文最多 32000 个 UTF-16（十六位字符编码）代码单元；大文档需导入前分段。结构化记录最多 32 个标量字段，不接受嵌套对象或数组。

发布在一个数据库事务中完成，语料级 Advisory Lock（咨询锁）串行化同库发布；同版本同内容幂等成功，不同内容必须递增版本并明确传 `--replace`（替换）。替换只影响指定语料，但会删除该语料旧文档、记录及图谱后写入新内容；它是整库替换，不是补丁合并。请事先备份、核对目标标识，系统不保存历史版本或提供回滚命令。失败回滚整笔事务；查询使用 Repeatable Read（可重复读）只读快照，不会把两个版本的文档与图谱混在一次结果里。

## 3. 数据库账号、迁移与启动

使用独立管理账号 `knowledge`（知识模式所有者）及在线只读账号 `knowledge_reader`（知识读者）。不要借用 PostgreSQL（关系型数据库）超级用户、会话或工作区账号来启动在线服务。迁移不会自动创建账号，需管理员先在目标数据库创建，密码使用独立随机值。以下 SQL 为新环境示例，不会由服务自动执行：

```sql
CREATE ROLE knowledge LOGIN PASSWORD '替换为独立管理密码'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
CREATE ROLE knowledge_reader LOGIN PASSWORD '替换为独立读者密码'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
CREATE SCHEMA knowledge AUTHORIZATION knowledge;
GRANT USAGE ON SCHEMA knowledge TO knowledge_reader;
ALTER ROLE knowledge_reader SET default_transaction_read_only = on;
```

读者不得加入任何管理角色，其他服务模式及表也不得给 `PUBLIC`（所有数据库角色）访问权限。建议部署人员验证读者不能读 `chat.messages`（会话消息表）、不能写知识表；应用参数化查询不能替代数据库权限。知识读者能读取整个知识模式，语料级用户授权由可信知识服务负责，不宣称使用了数据库逐用户行级安全。

构建根项目后，用管理凭据执行下面命令。示例配置文件路径相对于仓库根；迁移允许给已存在的另一个读者角色授权，使用 `--reader-role`（读者角色）指定。

```powershell
npm run build
# knowledge-admin.env 只存管理员 DATABASE_URL（数据库连接地址），不得分发给在线执行器。
node --env-file=.local/knowledge/knowledge-admin.env dsh-agent-knowledge/dist/migrate.js
node --env-file=.local/knowledge/knowledge-admin.env dsh-agent-knowledge/dist/import.js --file dsh-agent-knowledge/corpus.example.json
# 修改语料文件并递增 version 后，才使用以下整库替换命令。
# node --env-file=.local/knowledge/knowledge-admin.env dsh-agent-knowledge/dist/import.js --file .local/knowledge/corpus.v2.json --replace
```

也可使用知识包的 `migrate`（迁移）和 `import:corpus`（语料导入）命令；其 `--file` 相对于当前包工作目录。迁移为新知识模式的第 1 版，不改动其他服务的历史迁移。

复制 [知识服务环境示例](../dsh-agent-knowledge/.env.example) 与源示例到私有目录，配置：

| 配置 | 用途 |
| --- | --- |
| `KNOWLEDGE_DATABASE_URL` | 只读账号连接地址；仅 PostgreSQL 源需要，与管理 `DATABASE_URL` 分离 |
| `KNOWLEDGE_SOURCES_FILE` | 审核后的源配置文件路径，文件最多 1 MiB |
| `KNOWLEDGE_DB_POOL_MAX` | 每进程连接数，默认 8，范围 1–64 |
| `KNOWLEDGE_DB_MAX_WAITING` | 额外等待操作数，默认 16，范围 0–128；超额快速返回服务不可用 |
| `KNOWLEDGE_MAX_IN_FLIGHT` | 每进程知识接口在途请求数，默认 16，范围 1–128 |
| `RUN_CONTROL_URL` | 运行控制服务地址 |
| `RUN_CONTROL_KNOWLEDGE_SECRET` / `KNOWLEDGE_RUN_CONTROL_SECRET` | 知识能力签发与在线授权的独立密钥，需与运行控制相同 |

纯 PostgreSQL 配置不需要任何 LightRAG 密钥、端点或向量模型设置；语言模型密钥仍只由现有执行服务配置。知识服务不读取根 `.env`（环境变量文件）或自行连接模型。

```powershell
node --env-file=.local/knowledge/knowledge.env dsh-agent-knowledge/dist/main.js
```

默认监听本机 8090，不新增公网接口。运行控制需已有知识授权功能及第 7 版迁移；执行器配置 `KNOWLEDGE_URL`（知识地址）。可沿用 [knowledge-agent.v1.json](../dsh-agent-catalog/definitions/knowledge-agent.v1.json)，示例全文源刻意采用相同源标识。使用其他源时同时修改审核定义的 `knowledgeSources`（允许知识源）并发布新版本；已有会话不会自动切换定义。

就绪检查对 PostgreSQL 验证知识表可读且全部配置的语料已导入；不证明某种类型的数据非空、相关性或整链路授权正确。LightRAG 就绪仍仅证明配置存在，不验证上游服务。可选 [Compose（容器组合）覆盖配置](../dsh-agent-deploy/knowledge/compose.yaml) 已接受可选只读连接，不再强制要求 LightRAG 密钥；账号、迁移、导入仍需预先完成。现有集群清单未自动新增知识工作负载，本轮未部署容器或集群。

## 4. 原理、边界与验证

全文检索使用 Node.js（脚本运行环境）的 `Intl.Segmenter`（国际化分词器）进行中文词边界划分、NFKC（兼容性规范化）与小写规范化，再使用 PostgreSQL `simple`（简单词典）生成 `tsvector`（文本词项向量，即词项索引，不是模型向量）。检索词使用 `websearch_to_tsquery`（网页搜索语法转词项查询），采用 OR（或）匹配；标题加权、`ts_rank_cd`（覆盖密度排序）和稳定标识排序。GIN（广义倒排索引）用于加速词项与结构化匹配。此处不是 BM25（概率相关性评分算法），不承诺同义词、意图、错别字或语义召回。

索引每文本最多 8192 个不同词项，查询最多 64 个词项；词项最大 80 字符。当前分词会去重，排名不保留原文完整词频、距离信息；分词随 Node.js 内置 ICU（国际化组件库）版本可能变化，升级后建议重新发布索引并验收中文检索效果。符号、纯表情或未建立索引的内容可能检索为空，系统不会改用收费的向量或关键词模型。

结构化模式使用参数化 `JSONB`（二进制 JSON 数据）包含查询，精确匹配类型和值，不将字段名或值拼成 SQL。存在非空过滤时，条件决定哪些记录符合资格，问题文本仅参与排序；没有过滤时，需要记录文本命中问题或关键词。每源白名单在运行时再次校验，未知字段请求失败，不忽略错误条件。

图谱通过别名精确命中及实体文本索引选种子，双向 BFS（广度优先遍历），`graphDepth`（遍历深度）配置 1–3、默认 2；最多 10 个种子、100 个实体及 100 条关系，按标识确定顺序并去重处理环。高连接度实体可能仅返回有界子图，不能将结果当作完整拓扑或完整路径证明。图谱事实也转换为带引用的证据片段，因此纯图谱模式仍可供 DSH 引用回答。

返回协议不变：`chunks`（证据片段）、`entities`（实体）、`relationships`（关系）、`truncated`（裁剪标记）；每类最多 `limit`（条数上限）条、最高 10，单片段最多 4000、总文本最多 16000 个 UTF-16 代码单元并保持字符完整。无向量引用由源、语料、版本、记录标识与完整内容共同计算 SHA-256（安全哈希算法摘要），对外只展示短摘要。引用不是证据下载接口，也没有历史版本保留保证。

前后两次运行在线授权、步骤工具白名单、执行租约、来源读者、工具预算、取消和进度仍沿用现有链路。检索结果是资料，不是执行指令；未命中时明确没有证据，不生成伪造引用。错误不自动切换后端；数据库不可达、未迁移或语料缺失返回 503（服务不可用）。单 SQL 5 秒超时、连接等待 3 秒；检索设 15 秒取消信号并在每条查询前后检查。信号不会强行中断已经发送的 SQL，可能等待当前 SQL 至数据库超时并回滚后才结束，故不是绝对 15 秒响应上限。服务本身不自动重试检索或模型调用。

[专项测试](../tests/nonvector-rag.test.ts) 使用 PGlite（轻量 PostgreSQL 引擎）真实执行 SQL，覆盖四种模式、中文、权限、过滤注入、版本、原子回滚与容量；[整链路测试](../tests/knowledge.test.ts) 使用真实 DSH 子进程、运行控制认证、知识服务 HTTP（超文本传输协议）与 PostgreSQL 引擎，确认没有 LightRAG 调用。模型响应为本机夹具，未调用真实模型或向量服务，未在现有本机业务数据库迁移、导入或启动常驻服务；没有大规模检索质量、原生多连接锁竞争或生产吞吐验收。

原理依据：[PostgreSQL 文本检索控制](https://www.postgresql.org/docs/current/textsearch-controls.html)、[PostgreSQL JSON 操作](https://www.postgresql.org/docs/current/functions-json.html)。

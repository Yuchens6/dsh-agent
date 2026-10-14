import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { knowledgeDatabase } from "./knowledge-helpers.js";
import { KnowledgeSearch, KnowledgeResult, type KnowledgeAuthorization } from "@dsh-agent/contracts";
import { Corpus, publishCorpus } from "../dsh-agent-knowledge/src/corpus.js";
import { sourceRegistry } from "../dsh-agent-knowledge/src/sources.js";
import { retrievalRouter } from "../dsh-agent-knowledge/src/retrieval.js";
import { createKnowledgeApp } from "../dsh-agent-knowledge/src/app.js";
import type { Database } from "../dsh-agent-knowledge/src/database.js";
import { alice,bob,otherTenant } from "./helpers.js";
const fixture = {
  id: "approved", version: 1,
  documents: [{ id: "architecture", title: "平台数据库", content: "平台使用 PostgreSQL 数据库。知识检索不依赖向量模型。" }],
  records: [{ id: "employee-a",title: "员工配额",attributes: { department: "engineering",points: 20,active: true,remark: null } },
    { id: "employee-b",title: "其他员工配额",attributes: { department: "sales",points: 30,active: false } }],
  entities: [{ id: "platform",name: "DSH平台",type: "SYSTEM",description: "智能体平台",aliases: ["agent-platform"] },
    { id: "database",name: "PostgreSQL",type: "DATABASE",description: "关系型数据库" },
    { id: "index",name: "GIN索引",type: "INDEX",description: "检索索引" },
    { id: "term",name: "分词",type: "PROCESS",description: "文本处理" }],
  relationships: [{ id: "uses",source: "platform",target: "database",relation: "使用",description: "持久保存数据" },
    { id: "indexes",source: "database",target: "index",relation: "提供",description: "全文索引" },
    { id: "segments",source: "index",target: "term",relation: "接收",description: "分词文本" },
    { id: "cycle",source: "database",target: "platform",relation: "支撑",description: "反向关系形成环" }],
};
function registry(mode: "fulltext" | "structured" | "graph" | "hybrid", depth = 2, corpusId = "approved") {
  return sourceRegistry({ sources: [{ id: "handbook",backend: "postgres",corpusId,ragMode: mode,graphDepth: depth,filterFields: ["department","points","active","remark"],readers: [{ tenantId: alice.tenantId,uid: alice.uid }] }] },{});
}
function query(overrides: Record<string,unknown> = {}) { return KnowledgeSearch.parse({ sourceId: "handbook",query: "平台使用什么数据库",keywords: ["数据库"],limit: 10,...overrides }); }
test("无向量配置：无需模型/远端密钥，管理员选模式，拒绝未知字段与跨主体", async () => {
  const sources = registry("fulltext"); assert.equal(sources.usesPostgres,true);
  assert.equal(sources.resolve("handbook",alice).backend,"postgres");
  for (const actor of [bob,otherTenant]) assert.throws(() => sources.resolve("handbook",actor),/FORBIDDEN/);
  assert.throws(() => sourceRegistry({ sources: [{ id: "x",backend: "postgres",corpusId: "x",ragMode: "vector",readers: [alice] }] }));
  assert.equal(KnowledgeSearch.safeParse({ ...query(),sql: "select * from chat.messages" }).success,false);
  assert.equal(KnowledgeSearch.safeParse({ ...query(),filters: { "department OR true": "x" } }).success,false);
  await assert.rejects(retrievalRouter()(sources.resolve("handbook",alice),query(),AbortSignal.timeout(5000)),/DEPENDENCY_UNAVAILABLE/);
});
test("全文与结构化：中文检索、精确过滤、参数注入、语料隔离、没有任何向量调用", async t => {
  const { pg,db } = await knowledgeDatabase(); t.after(() => pg.close()); await publishCorpus(db,fixture);
  await publishCorpus(db,{ id: "private",version: 1,documents: [{ id: "secret",title: "数据库",content: "private-secret-database" }] });
  const retrieve = retrievalRouter(db), fulltext = registry("fulltext").resolve("handbook",alice);
  const result = await retrieve(fulltext,query(),AbortSignal.timeout(5000));
  assert.ok(result.chunks[0]?.content.includes("PostgreSQL")); assert.equal(JSON.stringify(result).includes("private-secret"),false);
  assert.match(result.chunks[0]!.citation,/^handbook:[a-f0-9]{24}$/);
  assert.equal((await retrieve(fulltext,query({ query: "zzzz-no-hit",keywords: ["zzzz"] }),AbortSignal.timeout(5000))).chunks.length,0);
  await assert.rejects(retrieve(fulltext,query({ filters: { department: "engineering" } }),AbortSignal.timeout(5000)),/INVALID_REQUEST/);
  const structured = registry("structured").resolve("handbook",alice);
  const matching = await retrieve(structured,query({ filters: { department: "engineering",points: 20,active: true,remark: null } }),AbortSignal.timeout(5000));
  assert.equal(matching.chunks.length,1); assert.ok(matching.chunks[0]!.content.includes('"points":20'));
  assert.equal((await retrieve(structured,query({ filters: { department: "' OR true --" } }),AbortSignal.timeout(5000))).chunks.length,0);
  await assert.rejects(retrieve(structured,query({ filters: { secret: "x" } }),AbortSignal.timeout(5000)),/INVALID_REQUEST/);
  const canceled = AbortSignal.abort(); await assert.rejects(retrieve(fulltext,query(),canceled),/DEPENDENCY_UNAVAILABLE/);
  await assert.rejects(retrieve(registry("fulltext",2,"missing").resolve("handbook",alice),query(),AbortSignal.timeout(5000)),/DEPENDENCY_UNAVAILABLE/);
});
test("纯图谱：别名定位、双向有界遍历、环去重、图谱证据引用与混合模式", async t => {
  const { pg,db } = await knowledgeDatabase(); t.after(() => pg.close()); await publishCorpus(db,fixture);
  const retrieve = retrievalRouter(db), request = query({ query: "agent-platform",keywords: ["agent-platform"] });
  const first = await retrieve(registry("graph",1).resolve("handbook",alice),request,AbortSignal.timeout(5000));
  assert.deepEqual(first.entities.map(row => row.name),["PostgreSQL","DSH平台"]);
  assert.equal(first.relationships.length,2); assert.ok(first.chunks.every(row => /^handbook:/.test(row.citation)));
  const second = await retrieve(registry("graph",2).resolve("handbook",alice),request,AbortSignal.timeout(5000));
  assert.ok(second.entities.some(row => row.name === "GIN索引")); assert.equal(second.entities.some(row => row.name === "分词"),false);
  const third = await retrieve(registry("graph",3).resolve("handbook",alice),request,AbortSignal.timeout(5000));
  assert.ok(third.entities.some(row => row.name === "分词")); assert.equal(third.relationships.length,4);
  const hybrid = await retrieve(registry("hybrid").resolve("handbook",alice),query({ keywords: ["数据库","agent-platform"],filters: { points: 20 } }),AbortSignal.timeout(5000));
  assert.ok(hybrid.chunks.some(row => row.content.includes("平台使用 PostgreSQL")));
  assert.ok(hybrid.chunks.some(row => row.content.includes('"points":20'))); assert.ok(hybrid.relationships.length);
  // Model-side LightRAG mode never overrides the configured PostgreSQL mode.
  assert.deepEqual(await retrieve(registry("fulltext").resolve("handbook",alice),query({ mode: "global" }),AbortSignal.timeout(5000)), await retrieve(registry("fulltext").resolve("handbook",alice),query(),AbortSignal.timeout(5000)));
});
test("发布：幂等、必须明确替换且递增版本、关系完整性、失败原子回滚、引用版本变化", async t => {
  const { pg,db } = await knowledgeDatabase(); t.after(() => pg.close());
  assert.equal((await publishCorpus(db,fixture)).unchanged,false); assert.equal((await publishCorpus(db,fixture)).unchanged,true);
  const source = registry("fulltext").resolve("handbook",alice), retrieve = retrievalRouter(db);
  const before = await retrieve(source,query(),AbortSignal.timeout(5000));
  await assert.rejects(publishCorpus(db,{ ...fixture,version: 2 }),/VERSION_CONFLICT/);
  await assert.rejects(publishCorpus(db,{ ...fixture,documents: [] },true),/VERSION_CONFLICT/);
  assert.equal(Corpus.safeParse({ ...fixture,relationships: [{ ...fixture.relationships[0],target: "foreign" }] }).success,false);
  const failing: Database = { ...db,transaction: work => db.transaction(tx => work({ query: async (sql,values) => { if (sql.startsWith("INSERT INTO knowledge.documents")) throw new Error("injected"); return tx.query(sql,values) as never; } })) };
  await assert.rejects(publishCorpus(failing,{ ...fixture,version: 2 },true),/injected/);
  assert.equal((await db.query("SELECT version FROM knowledge.corpora WHERE id='approved'")).rows[0]!.version,1);
  assert.deepEqual(await retrieve(source,query(),AbortSignal.timeout(5000)),before);
  await publishCorpus(db,{ ...fixture,version: 2 },true);
  const after = await retrieve(source,query(),AbortSignal.timeout(5000)); assert.notEqual(after.chunks[0]!.citation,before.chunks[0]!.citation);
});
test("结果容量：中文字符完整、总预算、100 节点/边上限和裁剪标识", async t => {
  const { pg,db } = await knowledgeDatabase(); t.after(() => pg.close());
  await publishCorpus(db,{ id: "approved",version: 1,documents: Array.from({ length: 12 },(_,i) => ({ id: "d-" + i,title: "database",content: "database " + "😀".repeat(10000) })),
    entities: Array.from({ length: 120 },(_,i) => ({ id: "e-" + i,name: i === 0 ? "start-node" : "node" + i,type: "NODE",description: "" })),
    relationships: Array.from({ length: 119 },(_,i) => ({ id: "r-" + i,source: "e-0",target: "e-" + (i + 1),relation: "link",description: "" })) });
  const retrieve = retrievalRouter(db);
  const output = await retrieve(registry("fulltext").resolve("handbook",alice),query({ query: "database",keywords: ["database"] }),AbortSignal.timeout(5000));
  assert.equal(output.truncated,true); assert.equal(output.chunks.length,10);
  assert.ok(output.chunks.every(row => row.content.isWellFormed())); assert.ok(output.chunks.reduce((sum,row) => sum + row.content.length,0) <= 16000);
  const graph = await retrieve(registry("graph").resolve("handbook",alice),query({ query: "start-node",keywords: ["start-node"] }),AbortSignal.timeout(5000));
  assert.equal(graph.truncated,true); assert.ok(graph.relationships.length <= 10); KnowledgeResult.parse(graph);
});
test("数据库权限与 HTTP：只读角色不可写知识或读业务表，返回前租约撤销仍拒绝", async t => {
  const { pg,db } = await knowledgeDatabase(); t.after(() => pg.close()); await publishCorpus(db,fixture);
  await pg.exec("CREATE ROLE knowledge_reader; GRANT USAGE ON SCHEMA knowledge TO knowledge_reader; GRANT SELECT ON ALL TABLES IN SCHEMA knowledge TO knowledge_reader; CREATE SCHEMA chat; CREATE TABLE chat.messages(secret text); SET ROLE knowledge_reader");
  await assert.rejects(db.query("SELECT * FROM chat.messages")); await assert.rejects(db.query("DELETE FROM knowledge.documents"));
  assert.equal((await db.query("SELECT id FROM knowledge.corpora")).rows.length,1); await pg.exec("RESET ROLE");
  let checks = 0;
  const scope: KnowledgeAuthorization = { runId: randomUUID(),leaseId: randomUUID(),attempt: 1,workerId: "worker-a",tool: "knowledge.search",sourceId: "handbook",actor: alice,workspaceId: randomUUID(),leaseExpiresAt: new Date(Date.now() + 30000).toISOString() };
  const app = createKnowledgeApp({ database: db,sources: registry("fulltext"),authorize: async () => { if (++checks === 2) scope.actor = bob; return { ...scope }; } }); t.after(() => app.close());
  assert.equal((await app.inject({ method: "POST",url: "/execution/v1/tools",payload: { tool: "knowledge.search",arguments: query() } })).statusCode,403);
  const absent = createKnowledgeApp({ sources: registry("fulltext"),authorize: async () => scope }); t.after(() => absent.close());
  assert.equal((await absent.inject("/health/ready")).statusCode,503);
});

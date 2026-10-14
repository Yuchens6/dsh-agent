// Actual local services / PostgreSQL acceptance tests. Does not start models, change defaults,
// restart services or import data. Only its own synthetic file is updated and deleted.
import assert from "node:assert/strict";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, relative, isAbsolute } from "node:path";
import { randomUUID } from "node:crypto";
import { parseEnv } from "node:util";
import pg from "pg";
import { connect } from "@nats-io/transport-node";
import { jetstreamManager } from "@nats-io/jetstream";
import { KnowledgeSearch } from "@dsh-agent/contracts";
import { postgres as knowledgeDatabase } from "../../dsh-agent-knowledge/dist/database.js";
import { retrievalRouter } from "../../dsh-agent-knowledge/dist/retrieval.js";
import { sourceRegistry } from "../../dsh-agent-knowledge/dist/sources.js";
import { login } from "./client.mjs";
import { settings, state, ports } from "./platform.mjs";

const output = resolve(process.argv[2] || resolve(state,"test-reports",new Date().toISOString().replace(/[:.]/g,"-")));
const within = relative(resolve(state,"test-reports"),output);
assert.ok(within && !within.startsWith("..") && !isAbsolute(within),"Output must be a child of .local/native/test-reports");
await mkdir(output,{recursive:true});
const report = {schemaVersion:1,startedAt:new Date().toISOString(),complete:false,cases:[]};
const config = await settings(), native = parseEnv(await readFile(resolve(state,".env"),"utf8"));
const secretValues = [...Object.values(config.secrets),config.admin.password,...config.users.map(u=>u.password),
  ...Object.entries(native).filter(([key])=>/PASSWORD|SECRET|ACCESS_KEY/.test(key)).map(([,value])=>value)];
const redact = value => { let text=String(value);for(const secret of secretValues) if(secret) text=text.replaceAll(secret,"[redacted]");return text.replace(/postgres(?:ql)?:\/\/[^\s]+/g,"[redacted database URL]"); };
async function check(id,title,expected,work,layer="local-http") {
  const start=performance.now();
  try {const actual=await work();report.cases.push({id,title,layer,status:"PASS",expected,actual,durationMs:Math.round(performance.now()-start)});console.log(`PASS ${id} ${title}`);return actual;}
  catch(error) {report.cases.push({id,title,layer,status:"FAIL",expected,error:redact(error.message),durationMs:Math.round(performance.now()-start)});throw error;}
}
async function http(token,method,path,body,extra={},status=200,base="http://127.0.0.1:8080/api/v1") {
  const response=await fetch(base+path,{method,signal:AbortSignal.timeout(10000),redirect:"error",
    headers:{...(token ? {authorization:"Bearer "+token} : {}),...(body===undefined ? {} : {"content-type":"application/json"}),...extra},
    ...(body===undefined ? {} : {body:JSON.stringify(body)})});
  const value=await response.json();assert.equal(response.status,status,`${method} ${path.split("?")[0]} expected ${status}; got ${response.status} ${value.error?.code ?? ""}`);
  return value;
}
let token,other,file,workspace,filePath;
try {
  await check("ENV-01","应用及身份健康检查","11 个 HTTP 端点全部为 200",async()=>{
    const statuses={};for(const [name,port] of Object.entries(ports)) {if(name==="nats" || name==="web")continue;
      const path=name==="iam"?"/realms/agent-local/.well-known/openid-configuration":"/health/ready";
      const response=await fetch(`http://127.0.0.1:${port}${path}`,{signal:AbortSignal.timeout(5000)});statuses[name]=response.status;await response.body?.cancel();assert.equal(response.status,200,name);}
    return statuses;
  });
  await check("IAM-01","两个真实用户登录","授权码及 PKCE 成功、身份和租户正确、用户标识不同",async()=>{
    token=await login();other=await login(1);const a=await http(token,"GET","/me"),b=await http(other,"GET","/me");
    assert.equal(a.uid,config.users[0].uid);assert.equal(b.uid,config.users[1].uid);assert.notEqual(a.uid,b.uid);assert.equal(a.tenantId,"local-dev");assert.equal(b.tenantId,"local-dev");
    return {users:2,distinct:true,tenantId:"local-dev"};
  });
  for(const [id,credential,label] of [["IAM-02",undefined,"未认证"],["IAM-03","invalid-test-token","伪造令牌"]]) {
    await check(id,label+"访问拒绝","HTTP 401，UNAUTHENTICATED",async()=>{
      const body=await http(credential,"GET","/sessions",undefined,{},401);assert.equal(body.error.code,"UNAUTHENTICATED");return {httpStatus:401,code:body.error.code};
    });
  }
  await check("CAT-01","已发布定义与工具名单","默认 local-agent；local-workflow 可查；无 shell/MCP 工具",async()=>{
    const page=await http(token,"GET","/definitions");assert.ok(page.items.some(d=>d.id==="local-agent"&&d.isDefault));assert.ok(page.items.some(d=>d.id==="local-workflow"));
    const definition=await http(token,"GET","/definitions/local-agent/versions/1");
    assert.ok(definition.tools.every(t=>["workspace.list","workspace.read","workspace.write","knowledge.search"].includes(t)));
    return {definitions:page.items.map(d=>({id:d.id,version:d.version,isDefault:d.isDefault})),tools:definition.tools};
  });
  await check("WS-01","工作区幂等分配","同用户工作区稳定，目录名等于真实 uid",async()=>{
    workspace=await http(token,"POST","/workspaces/ensure");const again=await http(token,"POST","/workspaces/ensure");
    assert.equal(again.id,workspace.id);assert.equal(workspace.directoryName,config.users[0].uid);return {sameWorkspace:true,directoryMatchesUid:true};
  });
  filePath="acceptance/"+randomUUID()+"/fixture.txt";
  await check("FILE-01","文件创建与读取","新建成功、内容和列表一致",async()=>{
    file=await http(token,"PUT",`/workspaces/${workspace.id}/file`,{path:filePath,content:"原生验收 fixture-v1",expectedVersion:null});
    const read=await http(token,"GET",`/workspaces/${workspace.id}/file?`+new URLSearchParams({path:filePath}));assert.equal(read.content,"原生验收 fixture-v1");
    // FileListQuery.prefix selects descendants of a directory, not an exact file path.
    const directory=filePath.slice(0,filePath.lastIndexOf("/"));
    const list=await http(token,"GET",`/workspaces/${workspace.id}/files?`+new URLSearchParams({prefix:directory}));assert.ok(list.items.some(f=>f.path===filePath));return {created:true,readMatches:true,listContains:true};
  });
  let previousVersion;
  await check("FILE-02","条件更新版本","携带原版本可更新，返回新版本",async()=>{
    previousVersion=file.version;file=await http(token,"PUT",`/workspaces/${workspace.id}/file`,{path:filePath,content:"原生验收 fixture-v2",expectedVersion:previousVersion});
    assert.notEqual(file.version,previousVersion);return {newVersion:true};
  });
  await check("FILE-03","旧版本覆盖拒绝","HTTP 409；已提交内容保持 v2",async()=>{
    await http(token,"PUT",`/workspaces/${workspace.id}/file`,{path:filePath,content:"must not write",expectedVersion:previousVersion},{},409);
    const read=await http(token,"GET",`/workspaces/${workspace.id}/file?`+new URLSearchParams({path:filePath}));assert.equal(read.content,"原生验收 fixture-v2");return {httpStatus:409,originalRetained:true};
  });
  for(const [suffix,path] of [["01","../escape.txt"],["02","D:/host.txt"],["03","a%2fb.txt"]]) await check("PATH-"+suffix,"非法路径拒绝："+path,"HTTP 400",async()=>{
    await http(token,"PUT",`/workspaces/${workspace.id}/file`,{path,content:"must not write",expectedVersion:null},{},400);return {httpStatus:400};
  });
  for(const [suffix,method,path,body] of [
    ["01","GET",`/workspaces/${workspace.id}/file?`+new URLSearchParams({path:filePath}),undefined],
    ["02","GET",`/workspaces/${workspace.id}/files`,undefined],
    ["03","PUT",`/workspaces/${workspace.id}/file`,{path:filePath,content:"must not write",expectedVersion:file.version}],
    ["04","DELETE",`/workspaces/${workspace.id}/file?`+new URLSearchParams({path:filePath,expectedVersion:file.version}),undefined],
  ]) await check("ISO-"+suffix,"第二用户跨工作区 "+method,"HTTP 404，不泄露其他用户资源",async()=>{
    await http(other,method,path,body,{},404);return {httpStatus:404};
  });
  let session;
  await check("CHAT-01","会话幂等与冲突","相同键相同请求返回同一会话，不同正文返回 409",async()=>{
    const key=randomUUID(),headers={"idempotency-key":key},body={title:"本地接口验收（无模型调用）"};
    session=await http(token,"POST","/sessions",body,headers,201);const replay=await http(token,"POST","/sessions",body,headers,201);assert.equal(replay.id,session.id);
    await http(token,"POST","/sessions",{title:"conflict"},headers,409);return {sameSession:true,conflictStatus:409};
  });
  await check("CHAT-02","跨用户会话拒绝","HTTP 404",async()=>{await http(other,"GET",`/sessions/${session.id}`,undefined,{},404);return {httpStatus:404};});
  await check("CHAT-03","空消息拒绝","HTTP 400，不生成模型任务",async()=>{await http(token,"POST",`/sessions/${session.id}/messages`,{content:""},{"idempotency-key":randomUUID()},400);return {httpStatus:400};});
  await check("SSE-01","本人订阅与跨用户重用拒绝","本人 200，另一用户拿同一能力令牌仍为 401",async()=>{
    const sub=await http(token,"POST",`/sessions/${session.id}/subscription`);const results=[];
    for(const [actor,status] of [[token,200],[other,401]]) {
      const response=await fetch(`http://127.0.0.1:8082/events/v1/sessions/${session.id}`,{signal:AbortSignal.timeout(5000),headers:{authorization:"Bearer "+actor,"x-session-capability":sub.token}});
      assert.equal(response.status,status);results.push(status);await response.body?.cancel();
    }return {httpStatuses:results};
  });
  await check("TOOL-01","知识执行接口拒绝普通用户令牌","用户登录令牌不能替代运行能力；HTTP 401 或 403",async()=>{
    const response=await fetch("http://127.0.0.1:8090/execution/v1/tools",{method:"POST",signal:AbortSignal.timeout(5000),headers:{authorization:"Bearer "+token,"content-type":"application/json"},
      body:JSON.stringify({tool:"knowledge.search",arguments:{sourceId:"local-handbook",query:"PostgreSQL",keywords:["PostgreSQL"]}})});
    assert.ok([401,403].includes(response.status));const body=await response.json();assert.ok(!body.result);return {httpStatus:response.status,code:body.error.code};
  });
  const roles={chat:"CHAT",iam:"IAM",workspace:"WORKSPACE",catalog:"CATALOG",catalog_reader:"CATALOG_READ",run_control:"RUN_CONTROL",quota:"QUOTA",audit:"AUDIT",audit_writer:"AUDIT_WRITER",knowledge:"KNOWLEDGE",knowledge_reader:"KNOWLEDGE_READ"};
  await check("DB-01","真实 PostgreSQL 角色与模式隔离","11 个账号登录各自模式，非身份服务不得访问 iam",async()=>{
    const checks=[];for(const [role,prefix] of Object.entries(roles)) {
      const client=new pg.Client({connectionString:native[prefix+"_DATABASE_URL"],connectionTimeoutMillis:5000});
      try {await client.connect();const row=(await client.query("SELECT current_user AS name,current_schema() AS schema,has_schema_privilege(current_user,'iam','USAGE') AS iam_access")).rows[0];
        assert.equal(row.name,role);assert.ok(row.schema);assert.equal(row.iam_access,role==="iam");checks.push({role,schema:row.schema,iamAccess:row.iam_access});}
      finally {await client.end();}
    }return checks;
  },"native-postgresql");
  for(const [id,prefix,table] of [["DB-02","CATALOG_READ","catalog.definitions"],["DB-03","KNOWLEDGE_READ","knowledge.corpora"],["DB-04","AUDIT_WRITER","audit.events"]]) {
    await check(id,prefix+" 更新权限检查","表存在，UPDATE 权限为 false",async()=>{
      const client=new pg.Client({connectionString:native[prefix+"_DATABASE_URL"],connectionTimeoutMillis:5000});try {await client.connect();
        let target=table;
        if(prefix==="AUDIT_WRITER") {const r=await client.query("SELECT tablename FROM pg_tables WHERE schemaname='audit' AND tablename<>'schema_migrations' ORDER BY tablename");assert.ok(r.rows.length);target="audit."+r.rows[0].tablename;}
        const row=(await client.query("SELECT has_table_privilege(current_user,$1,'UPDATE') AS allowed",[target])).rows[0];assert.equal(row.allowed,false);return {table:target,updateAllowed:false};}
      finally {await client.end();}
    },"native-postgresql");
  }
  await check("NATS-01","真实持久消息流与无效凭据拒绝","两个持久流存在；错误令牌不能连接",async()=>{
    const nc=await connect({servers:"nats://127.0.0.1:4222",token:config.secrets.NATS_TOKEN,timeout:3000,maxReconnectAttempts:0});
    try {const manager=await jetstreamManager(nc),streams=[];
      for(const name of ["DSH_EVENTS","DSH_RUN_REQUESTS"]) {const info=await manager.streams.info(name);assert.equal(info.config.storage,"file");streams.push({name,storage:info.config.storage,retention:info.config.retention});}
      await assert.rejects(async()=>{const unexpected=await connect({servers:"nats://127.0.0.1:4222",token:"invalid-native-test",timeout:2000,maxReconnectAttempts:0});await unexpected.close();},/AUTHORIZATION_VIOLATION|Authorization Violation/i);
      return {streams,invalidTokenDenied:true};
    } finally {await nc.close();}
  },"native-nats");
  const sourceConfig=JSON.parse(await readFile(resolve(state,"knowledge-sources.json"),"utf8"));
  const actor={tenantId:"local-dev",uid:config.users[0].uid,roles:["user"]};
  const sources=sourceRegistry(sourceConfig),source=sources.resolve("local-handbook",actor);
  assert.equal(source.backend,"postgres");
  await check("RAG-01","知识源授权名单","第二用户不在源名单，解析拒绝 403",async()=>{
    assert.throws(()=>sources.resolve("local-handbook",{...actor,uid:config.users[1].uid}),e=>e.status===403);return {status:403};
  },"component-native-db");
  const database=knowledgeDatabase(native.KNOWLEDGE_READ_DATABASE_URL,{max:1});
  try {
    const retrieve=retrievalRouter(database);
    for(const [number,mode] of ["fulltext","structured","graph","hybrid"].entries()) {
      await check("RAG-0"+(number+2),mode+" 无向量模式","真实 PostgreSQL 返回对应证据；不修改在线源配置",async()=>{
        const term=mode==="graph"?"DSH平台":"PostgreSQL";
        const query=KnowledgeSearch.parse({sourceId:source.id,query:term,keywords:[term],limit:10,
          ...(["structured","hybrid"].includes(mode)?{filters:{department:"engineering"}}:{})});
        const result=await retrieve({...source,ragMode:mode},query,AbortSignal.timeout(10000));
        assert.ok(result.chunks.length>0);assert.ok(result.chunks.every(c=>c.citation.startsWith("local-handbook:")));
        if(mode==="fulltext")assert.ok(result.chunks.some(c=>c.content.includes("PostgreSQL")));
        if(mode==="structured")assert.ok(result.chunks.some(c=>c.content.includes('"points":20')));
        if(["graph","hybrid"].includes(mode))assert.ok(result.relationships.some(r=>r.source==="DSH平台"&&r.target==="PostgreSQL"));
        return {mode,chunks:result.chunks.length,entities:result.entities.length,relationships:result.relationships.length,truncated:result.truncated};
      },"component-native-db");
    }
  } finally {await database.close();}
  for(const [id,path,label] of [["SUP-01","/quota","配额查询"],["SUP-02","/usage","模型用量查询"],["SUP-03","/audit?limit=10","审计查询"]]) await check(id,label,"HTTP 200，协议结构可用",async()=>{
    const result=await http(token,"GET",path);return {httpStatus:200,...(path==="/usage"?{startedCalls:result.startedCalls,reportedCalls:result.reportedCalls,unknownCalls:result.unknownCalls,pendingCalls:result.pendingCalls}:{}),...(result.items?{items:result.items.length}:{})};
  });
  await check("SUP-04","积分计费开关","本地 billingEnabled=false，不以接口可用代表真实结算",async()=>{
    const result=await http(token,"GET","/points");assert.equal(result.billingEnabled,false);return {billingEnabled:false};
  });
  await check("HIST-01","既有真实对话记录复核","既有成功运行和最终答案仍可查询",async()=>{
    const saved=JSON.parse(await readFile(resolve(state,"verification.json"),"utf8"));const value=saved.conversation;
    const run=await http(token,"GET",`/runs/${value.runId}`),history=await http(token,"GET",`/sessions/${value.sessionId}/history?limit=100`);
    assert.equal(run.state,"succeeded");assert.ok(history.items.some(m=>m.role==="assistant"&&m.content===value.answer));
    return {originalCheckedAt:saved.checkedAt,runState:run.state,historyMessages:history.items.length,answerMatches:true};
  },"historical-evidence-recheck");
  await check("WF-01","既有原生工作流投影复核","初稿成功、复核跳过、最终成功；不是本次重新执行模型",async()=>{
    const saved=JSON.parse(await readFile(resolve(state,"workflow-verification.json"),"utf8"));
    const progress=await http(token,"GET",`/runs/${saved.runId}/workflow`);assert.equal(progress.enabled,true);assert.equal(progress.state,"succeeded");
    assert.deepEqual(progress.steps.map(s=>({id:s.id,state:s.state})),saved.steps.map(s=>({id:s.id,state:s.state})));
    return {originalCheckedAt:saved.checkedAt,steps:progress.steps.map(s=>({id:s.id,state:s.state}))};
  },"historical-evidence-recheck");
  report.complete=true;
} catch(error) {report.error=redact(error.message);process.exitCode=1;console.error("Acceptance failed:",report.error);}
finally {
  if(file&&workspace&&filePath) {
    try {await check("CLEAN-01","只清理本套件创建的临时文件","按当前版本删除后读取 404；会话和审计保留",async()=>{
      await http(token,"DELETE",`/workspaces/${workspace.id}/file?`+new URLSearchParams({path:filePath,expectedVersion:file.version}));
      await http(token,"GET",`/workspaces/${workspace.id}/file?`+new URLSearchParams({path:filePath}),undefined,{},404);return {deleted:true,readStatus:404};
    });}catch{report.complete=false;process.exitCode=1;}
  }
  report.finishedAt=new Date().toISOString();report.summary={total:report.cases.length,passed:report.cases.filter(c=>c.status==="PASS").length,failed:report.cases.filter(c=>c.status==="FAIL").length};
  await writeFile(resolve(output,"acceptance.json"),JSON.stringify(report,null,2)+"\n",{mode:0o600});
  console.log(JSON.stringify({output,complete:report.complete,...report.summary}));
}

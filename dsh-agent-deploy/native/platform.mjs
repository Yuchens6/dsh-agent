// Native Windows deployment helper. Secrets stay in the ACL-restricted .local/native directory.
import { readFile, writeFile, mkdir, access, unlink } from "node:fs/promises";
import { randomBytes, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseEnv } from "node:util";
import { spawn } from "node:child_process";
import assert from "node:assert/strict";

export const root = fileURLToPath(new URL("../../", import.meta.url));
export const state = resolve(root, ".local/native");
export const ports = { api:8080, iam:8081, stream:8082, chat:8083, workspace:8084, "run-control":8085,
  catalog:8086, quota:8087, audit:8088, "runtime-dsh":8089, knowledge:8090, nats:4222, web:3000 };
const origin = name => `http://127.0.0.1:${ports[name]}`;
const issuer = origin("iam") + "/realms/agent-local";
const json = async path => JSON.parse((await readFile(path,"utf8")).replace(/^\uFEFF/,""));
export const settings = () => json(resolve(state,"platform.json"));
const secret = () => randomBytes(32).toString("hex");
const exists = async path => { try { await access(path); return true; } catch(e) { if(e.code === "ENOENT") return false; throw e; } };
const save = (path, value) => writeFile(path,JSON.stringify(value,null,2)+"\n",{mode:0o600});
// Do not pass parent credentials, NODE_OPTIONS, proxy settings or the complete native .env to children.
export function systemEnvironment() {
  const result = {};
  for (const [key,value] of Object.entries(process.env)) if (/^(OS|PATH|SYSTEMROOT|WINDIR|COMSPEC|TEMP|TMP|USERPROFILE|HOMEDRIVE|HOMEPATH|APPDATA|LOCALAPPDATA|PATHEXT|PROCESSOR_ARCHITECTURE|NUMBER_OF_PROCESSORS)$/i.test(key)) result[key] = value;
  return result;
}
const grants = {
  api: "API_CHAT_SECRET API_WORKSPACE_SECRET API_CATALOG_SECRET API_RUN_CONTROL_SECRET API_QUOTA_SECRET API_AUDIT_SECRET",
  stream: "CHAT_CAPABILITY_SECRET NATS_TOKEN",
  chat: "API_CHAT_SECRET CHAT_CAPABILITY_SECRET NATS_TOKEN CHAT_WORKSPACE_SECRET CHAT_CATALOG_SECRET RUN_CONTROL_CHAT_SECRET CHAT_AUDIT_SECRET CHAT_METRICS_SECRET",
  workspace: "API_WORKSPACE_SECRET CHAT_WORKSPACE_SECRET RUN_CONTROL_WORKSPACE_SECRET WORKSPACE_RUN_CONTROL_SECRET WORKSPACE_AUDIT_SECRET WORKSPACE_METRICS_SECRET",
  catalog: "API_CATALOG_SECRET CHAT_CATALOG_SECRET RUN_CONTROL_CATALOG_SECRET",
  "run-control": "API_RUN_CONTROL_SECRET RUNTIME_RUN_CONTROL_SECRET NATS_TOKEN RUN_CONTROL_CHAT_SECRET RUN_CONTROL_CATALOG_SECRET RUN_CONTROL_WORKSPACE_SECRET WORKSPACE_RUN_CONTROL_SECRET RUN_CONTROL_QUOTA_SECRET RUN_CONTROL_AUDIT_SECRET RUN_CONTROL_METRICS_SECRET RUN_CONTROL_KNOWLEDGE_SECRET KNOWLEDGE_RUN_CONTROL_SECRET",
  quota: "API_QUOTA_SECRET RUN_CONTROL_QUOTA_SECRET",
  audit: "API_AUDIT_SECRET RUN_CONTROL_AUDIT_SECRET CHAT_AUDIT_SECRET WORKSPACE_AUDIT_SECRET",
  "runtime-dsh": "RUNTIME_RUN_CONTROL_SECRET",
  knowledge: "RUN_CONTROL_KNOWLEDGE_SECRET KNOWLEDGE_RUN_CONTROL_SECRET",
  web: "",
};
const urls = { api:["chat","workspace","catalog","run-control","quota","audit"], chat:["workspace","catalog","audit"],
  workspace:["run-control","audit"], "run-control":["chat","catalog","quota","audit"], "runtime-dsh":["run-control","workspace","knowledge"], knowledge:["run-control"] };
const dbPrefixes = {chat:"CHAT",workspace:"WORKSPACE",catalog:"CATALOG_READ","run-control":"RUN_CONTROL",quota:"QUOTA",audit:"AUDIT_WRITER"};
async function nativeEnv() { return parseEnv(await readFile(resolve(state,".env"),"utf8")); }
async function model() {
  const env = parseEnv(await readFile(resolve(root,".env"),"utf8"));
  const config = {key:env.DEEPSEEK_API_KEY || env.LLM_API_KEY, base:env.DEEPSEEK_BASE_URL || env.LLM_BASE_URL || "https://api.deepseek.com", name:env.LLM_MODEL || env.DEEPSEEK_MODEL};
  assert.ok(config.key && config.name,"Root .env must contain a model key and LLM_MODEL/DEEPSEEK_MODEL");
  const url = new URL(config.base);
  assert.equal(url.protocol,"https:","Model API must use HTTPS");
  assert.ok(!url.username && !url.password,"Model URL must not contain credentials");
  return config;
}
export async function serviceEnvironment(name) {
  assert.ok(Object.hasOwn(grants,name),"Unknown application service");
  const config = await settings(), native = await nativeEnv();
  const env = {...systemEnvironment(), NODE_ENV:"development", HOST:"127.0.0.1", PORT:String(ports[name])};
  for(const key of grants[name].split(" ").filter(Boolean)) { assert.ok(config.secrets[key],`Missing ${key}`); env[key] = config.secrets[key]; }
  for(const service of urls[name] ?? []) env[service.toUpperCase().replaceAll("-","_")+"_URL"] = origin(service);
  if (dbPrefixes[name]) env.DATABASE_URL = native[dbPrefixes[name]+"_DATABASE_URL"];
  if (name === "catalog" && config.studioEnabled) env.CATALOG_STUDIO_DATABASE_URL = native.CATALOG_DATABASE_URL;
  if (name === "web") Object.assign(env,{API_URL:origin("api"),STREAM_URL:origin("stream"),IAM_ISSUER:issuer,WEB_ORIGIN:"http://localhost:3000",IAM_CLIENT_ID:"agent-web"});
  if (["api","stream"].includes(name)) Object.assign(env,{IAM_ISSUER:issuer,IAM_JWKS_URL:issuer+"/protocol/openid-connect/certs",IAM_AUDIENCE:"agent-platform"});
  if (["stream","chat","run-control"].includes(name)) env.NATS_URL = "nats://127.0.0.1:4222";
  if (name === "workspace") for(const key of ["S3_ENDPOINT","S3_REGION","S3_BUCKET","S3_ACCESS_KEY","S3_SECRET_KEY"]) env[key] = native[key];
  if (name === "chat") Object.assign(env,{DB_POOL_MAX:"4",DB_MAX_WAITING:"16",CHAT_PUBLISH_WORKERS:"1"});
  if (name === "run-control") Object.assign(env,{RUN_MAX_ACTIVE:"4",RUN_USER_ACTIVE:"1",RUN_TENANT_ACTIVE:"4",RUN_DELIVERY_WORKERS:"1",DB_POOL_MAX:"4",DB_MAX_WAITING:"16"});
  if (name === "quota") env.POINTS_BILLING_ENABLED = "false";
  if (name === "runtime-dsh") {
    const provider = await model();
    Object.assign(env,{DEEPSEEK_API_KEY:provider.key,DEEPSEEK_BASE_URL:provider.base,RUNTIME_ENABLED:"true",WORKER_ID:"native-local",RUNTIME_CONCURRENCY:"1",RUNTIME_MAX_TOOL_CALLS:"20",RUNTIME_MODEL_MAX_RETRIES:"1"});
  }
  if (name === "knowledge") Object.assign(env,{KNOWLEDGE_SOURCES_FILE:resolve(state,"knowledge-sources.json"),KNOWLEDGE_DATABASE_URL:native.KNOWLEDGE_READ_DATABASE_URL,KNOWLEDGE_DB_POOL_MAX:"2",KNOWLEDGE_DB_MAX_WAITING:"8",KNOWLEDGE_MAX_IN_FLIGHT:"8"});
  return env;
}
async function runNode(relative, args=[], extra={}) {
  const child = spawn(process.execPath,[resolve(root,relative),...args],{cwd:root,env:{...systemEnvironment(),NODE_ENV:"development",...extra},windowsHide:true,stdio:"inherit"});
  await new Promise((accept,reject) => { child.once("error",reject); child.once("exit",code => code === 0 ? accept() : reject(new Error(`${relative} failed (exit ${code}); see diagnostic above`))); });
}
async function configure(javaHome) {
  await access(resolve(state,"settings.json"));
  await access(resolve(javaHome,"bin/java.exe"));
  const previous = await exists(resolve(state,"platform.json")) ? await settings() : null;
  const config = previous ?? {version:1,javaHome:resolve(javaHome),secrets:{},admin:{username:"admin",password:secret()},users:[
    {uid:randomUUID(),username:"local-user",password:secret()},
    {uid:randomUUID(),username:"isolation-test",password:secret()},
  ]};
  assert.equal(config.javaHome.toLowerCase(),resolve(javaHome).toLowerCase(),"Existing Java installation differs; update platform.json deliberately");
  for(const key of new Set(Object.values(grants).join(" ").split(" ").filter(Boolean))) config.secrets[key] ??= secret();
  await save(resolve(state,"platform.json"),config);
  await mkdir(resolve(state,"logs"),{recursive:true});
  await mkdir(resolve(state,"iam-import"),{recursive:true});
  await mkdir(resolve(state,"nats"),{recursive:true});
  // Import happens only on first realm creation; existing IAM users are not reset on restart.
  const realm = await json(resolve(root,"dsh-agent-iam/realm-local.json"));
  realm.users = config.users.map(user => ({id:user.uid,username:user.username,enabled:true,emailVerified:true,
    email:user.username+"@example.invalid",firstName:"Local",lastName:"User",requiredActions:[],realmRoles:user.roles ?? ["user"],
    credentials:[{type:"password",value:user.password,temporary:false}]}));
  await save(resolve(state,"iam-import/agent-local-realm.json"),realm);
  await writeFile(resolve(state,"nats.conf"),`listen: "127.0.0.1:4222"\nauthorization { token: "${config.secrets.NATS_TOKEN}" }\njetstream {\n store_dir: ${JSON.stringify(resolve(state,"nats").replaceAll("\\","/"))}\n max_memory_store: 67108864\n max_file_store: 3221225472\n}\n`,{mode:0o600});
  // Preserve operator changes to retrieval mode and ACL on subsequent setup runs.
  if (!await exists(resolve(state,"knowledge-sources.json"))) await save(resolve(state,"knowledge-sources.json"),{sources:[{
    id:"local-handbook",backend:"postgres",corpusId:"company-handbook",ragMode:"hybrid",filterFields:["department","active"],graphDepth:2,
    readers:[{tenantId:"local-dev",uid:config.users[0].uid}],
  }]});
  await model();
  console.log("Native configuration ready. Credentials: .local/native/platform.json (never commit/share).");
}
async function migrate() {
  const env = await nativeEnv();
  for(const [service,prefix] of Object.entries({chat:"CHAT",workspace:"WORKSPACE",catalog:"CATALOG","run-control":"RUN_CONTROL",quota:"QUOTA",audit:"AUDIT",knowledge:"KNOWLEDGE"})) {
    await runNode(`dsh-agent-${service}/dist/migrate.js`,[],{DATABASE_URL:env[prefix+"_DATABASE_URL"]});
    console.log(`${service}: migrations ready`);
  }
}
async function seed() {
  const native = await nativeEnv(), provider = await model();
  const agent = await json(resolve(root,"dsh-agent-catalog/definitions/native-skills-agent.v1.json"));
  Object.assign(agent,{id:"local-agent",name:"本地智能体",description:"本地部署的文档、知识检索与原生技能助手",tools:["workspace.list","workspace.read","workspace.write","knowledge.search"],knowledgeSources:["local-handbook"]});
  agent.model.name = provider.name;
  agent.execution = {maxTurns:6,maxOutputTokens:1024,timeoutSeconds:120};
  const workflow = await json(resolve(root,"dsh-agent-catalog/definitions/document-review-workflow.v1.json"));
  workflow.id = "local-workflow"; workflow.name = "本地原生文档工作流"; workflow.model.name = provider.name;
  for(const [name,definition] of [["local-agent",agent],["local-workflow",workflow]]) {
    const path = resolve(state,name+".json");
    // Published versions are immutable. Do not silently rewrite a deployed definition after .env changes.
    if (!await exists(path)) await save(path,definition);
    await runNode("dsh-agent-catalog/dist/publish.js",["--file",path,"--tenant","local-dev",...(name === "local-agent" ? ["--default"] : [])],{DATABASE_URL:native.CATALOG_DATABASE_URL});
  }
  await runNode("dsh-agent-knowledge/dist/import.js",["--file",resolve(root,"dsh-agent-knowledge/corpus.example.json")],{DATABASE_URL:native.KNOWLEDGE_DATABASE_URL});
}
async function setDefault(name) {
  assert.ok(["local-agent","local-workflow"].includes(name),"Expected local-agent or local-workflow");
  const native = await nativeEnv();
  await runNode("dsh-agent-catalog/dist/publish.js",["--file",resolve(state,name+".json"),"--tenant","local-dev","--default"],{DATABASE_URL:native.CATALOG_DATABASE_URL});
}
async function serve(name) {
  if (name === "iam" || name === "nats") {
    const config = await settings(), native = await nativeEnv();
    let command,args,env = systemEnvironment();
    if (name === "nats") {
      command = resolve(root,".tools/nats-2.15.0/nats-server-v2.15.0-windows-amd64/nats-server.exe");
      args = ["-c",resolve(state,"nats.conf")];
    } else {
      const kc = resolve(root,".tools/keycloak-26.7.4/keycloak-26.7.4/bin/kc.bat");
      await access(kc);
      const nativeDb = new URL(native.IAM_DATABASE_URL);
      Object.assign(env,{JAVA_HOME:config.javaHome,JAVA_OPTS_KC_HEAP:"-Xms128m -Xmx512m",
        KC_DB:"postgres",KC_DB_URL:"jdbc:postgresql://127.0.0.1:5432/agent",KC_DB_USERNAME:"iam",KC_DB_PASSWORD:decodeURIComponent(nativeDb.password),KC_DB_SCHEMA:"iam",
        KC_DB_POOL_INITIAL_SIZE:"1",KC_DB_POOL_MIN_SIZE:"1",KC_DB_POOL_MAX_SIZE:"5",KC_HTTP_HOST:"127.0.0.1",KC_HTTP_PORT:"8081",
        KC_HOSTNAME:origin("iam"),KC_HOSTNAME_STRICT:"true",KC_BOOTSTRAP_ADMIN_USERNAME:config.admin.username,KC_BOOTSTRAP_ADMIN_PASSWORD:config.admin.password,
        KC_HEALTH_ENABLED:"false",KC_METRICS_ENABLED:"false",KC_LOG_LEVEL:"info"});
      command = process.env.ComSpec || process.env.COMSPEC || "C:\\Windows\\System32\\cmd.exe";
      // Fixed trusted local paths, not user input; cmd is required to run Keycloak's Windows batch entrypoint.
      args = ["/d","/s","/c",`""${kc}" start-dev --import-realm"`];
      // Keycloak reads this JVM property when importing startup realm JSON.
      env.JAVA_OPTS_APPEND = `-Dkeycloak.migration.dir="${resolve(state,"iam-import")}"`;
    }
    const child = spawn(command,args,{cwd:state,env,windowsHide:true,stdio:"inherit",...(name === "iam" ? {windowsVerbatimArguments:true} : {})});
    child.once("error",() => { console.error(`${name} failed to start`);process.exitCode=1; });
    child.once("exit",code => {process.exitCode = code ?? 1;});
    return;
  }
  const env = await serviceEnvironment(name);
  for(const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env,env);
  await import(pathToFileURL(resolve(root,`dsh-agent-${name}/dist/main.js`)).href);
  // Windows does not deliver POSIX SIGTERM through process.kill(). An ACL-protected control
  // file lets the operator invoke existing graceful shutdown handlers before force termination.
  const bootedAt = Date.now(), stopFile = resolve(state,name+".stop.json");
  let checking = false;
  const timer = setInterval(async () => {
    if (checking) return;
    checking = true;
    try {
      const request = await json(stopFile);
      if (request.pid === process.pid && request.requestedAt >= bootedAt) {
        clearInterval(timer); await unlink(stopFile);
        process.emit("SIGTERM", "SIGTERM");
      }
    } catch(error) { if(error.code !== "ENOENT") console.error("Invalid local shutdown control file"); }
    finally { checking = false; }
  },500);
  timer.unref();
}
async function initStreams() {
  const config = await settings();
  await runNode("dsh-agent-deploy/init-stream.mjs",[],{NATS_URL:"nats://127.0.0.1:4222",NATS_TOKEN:config.secrets.NATS_TOKEN});
  console.log("NATS JetStream streams ready");
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [action,arg] = process.argv.slice(2);
    if(action === "configure") await configure(arg);
    else if(action === "migrate") await migrate();
    else if(action === "seed") await seed();
    else if(action === "streams") await initStreams();
    else if(action === "default") await setDefault(arg);
    else if(action === "serve") await serve(arg);
    else throw new Error("Expected configure JAVA_HOME, migrate, seed, streams, default DEFINITION or serve SERVICE");
  } catch(error) {
    // Avoid printing driver URLs, environment objects or provider credentials.
    console.error("Native platform failed:",String(error.message).replace(/postgres(?:ql)?:\/\/[^\s]+/g,"[redacted database URL]"));
    process.exitCode = 1;
  }
}

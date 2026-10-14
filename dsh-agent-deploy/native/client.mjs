// Local terminal client and full-stack smoke check. Never prints passwords or access tokens.
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { settings, state } from "./platform.mjs";
const issuer = "http://127.0.0.1:8081/realms/agent-local";
const api = "http://127.0.0.1:8080/api/v1";
const pause = ms => new Promise(done => setTimeout(done,ms));
const unescape = value => value.replaceAll("&amp;","&").replaceAll("&#x3d;","=").replaceAll("&#39;","'").replaceAll("&quot;",'"');

export async function login(index=0) {
  const user = (await settings()).users[index];
  assert.ok(user,"Unknown local user");
  const verifier = randomBytes(32).toString("base64url"), nonce = randomUUID(), oauthState = randomUUID();
  const cookies = new Map();
  const redirect = "http://localhost:3000/callback";
  const authorization = new URL(issuer+"/protocol/openid-connect/auth");
  authorization.search = new URLSearchParams({client_id:"agent-web",response_type:"code",scope:"openid",redirect_uri:redirect,
    state:oauthState,nonce,code_challenge_method:"S256",code_challenge:createHash("sha256").update(verifier).digest("base64url")}).toString();
  async function request(url,init={}) {
    // This helper intentionally only sends local test credentials to the configured local IAM origin.
    assert.equal(new URL(url).origin,new URL(issuer).origin,"Refusing login redirect to another origin");
    const response = await fetch(url,{...init,redirect:"manual",signal:AbortSignal.timeout(15000),headers:{...init.headers,cookie:[...cookies].map(([k,v]) => k+"="+v).join("; ")}});
    for(const cookie of response.headers.getSetCookie()) {
      const [pair] = cookie.split(";"), at = pair.indexOf("=");
      cookies.set(pair.slice(0,at),pair.slice(at+1));
    }
    return response;
  }
  let response = await request(authorization);
  let current = authorization.href;
  for(let count=0;count<10;count++) {
    const location = response.headers.get("location");
    if (location) {
      const next = new URL(location,current);
      await response.body?.cancel();
      if (next.origin+next.pathname === redirect) {
        assert.equal(next.searchParams.get("state"),oauthState,"OAuth state mismatch");
        assert.ok(next.searchParams.get("code"),"Authorization code missing");
        const tokenResponse = await fetch(issuer+"/protocol/openid-connect/token",{method:"POST",signal:AbortSignal.timeout(15000),
          body:new URLSearchParams({grant_type:"authorization_code",client_id:"agent-web",code:next.searchParams.get("code"),code_verifier:verifier,redirect_uri:redirect})});
        assert.equal(tokenResponse.status,200,"Authorization code / PKCE exchange failed");
        const tokens = await tokenResponse.json();
        assert.ok(tokens.access_token,"Access token missing");
        return tokens.access_token;
      }
      current = next.href; response = await request(current); continue;
    }
    assert.equal(response.status,200,"IAM authorization request failed");
    const html = await response.text();
    const form = html.match(/<form\b[^>]*\bid="kc-form-login"[^>]*\baction="([^"]+)"/i)
      ?? html.match(/<form\b[^>]*\baction="([^"]+)"[^>]*\bid="kc-form-login"/i);
    assert.ok(form,"Expected IAM login form; check local credentials/required actions in Keycloak");
    current = new URL(unescape(form[1]),current).href;
    response = await request(current,{method:"POST",body:new URLSearchParams({username:user.username,password:user.password,credentialId:""})});
  }
  throw new Error("IAM login redirect limit reached");
}
export async function call(token,method,path,body,key) {
  const response = await fetch(api+path,{method,signal:AbortSignal.timeout(15000),headers:{authorization:"Bearer "+token,
    ...(body === undefined ? {} : {"content-type":"application/json"}),...(key ? {"idempotency-key":key} : {})},
    ...(body === undefined ? {} : {body:JSON.stringify(body)})});
  const value = await response.json();
  if(!response.ok) throw Object.assign(new Error(`${method} ${path.split("?")[0]}: HTTP ${response.status} ${value.error?.code ?? "ERROR"}`),{status:response.status});
  return value;
}

export async function converse(token,session,content,{onEvent=()=>{},onAccepted=()=>{}}={}) {
  const events = [], started = Date.now(), stop = new AbortController();
  let cursor, endEvent, currentRunId, firstEventMs, firstStatusMs, firstPreviewMs;
  const streamPath = `/events/v1/sessions/${session.id}`;
  const openStream = async () => {
    const subscription = await call(token,"POST",`/sessions/${session.id}/subscription`);
    return fetch("http://127.0.0.1:8082"+streamPath,{headers:{authorization:"Bearer "+token,"x-session-capability":subscription.token,...(cursor ? {"last-event-id":cursor} : {})},
      signal:AbortSignal.any([stop.signal,AbortSignal.timeout(Math.max(1,150000-(Date.now()-started)))])});
  };
  let response = await openStream();
  assert.equal(response.status,200,"SSE authorization/open failed");
  const messageKey = randomUUID();
  let accepted;
  try { accepted = await call(token,"POST",`/sessions/${session.id}/messages`,{content},messageKey); }
  catch(error) { stop.abort(); await response.body?.cancel().catch(()=>{}); throw error; }
  const acceptedMs = Date.now()-started;
  onAccepted(accepted);
  const reading = (async () => {
    while (!stop.signal.aborted) {
      const decoder = new TextDecoder(); let buffer = "";
      for await(const chunk of response.body) {
        buffer += decoder.decode(chunk,{stream:true});
        let boundary;
        while((boundary = buffer.indexOf("\n\n")) !== -1) {
          const frame = buffer.slice(0,boundary); buffer = buffer.slice(boundary+2);
          const lines = frame.split("\n"), data = lines.find(line => line.startsWith("data: "));
          if(!data) continue;
          cursor = lines.find(line => line.startsWith("id: "))?.slice(4) ?? cursor;
          const event = JSON.parse(data.slice(6));
          // New sessions have one run. Existing sessions can replay older events; ignore those runs.
          if(event.payload?.messageId && event.payload.messageId !== accepted.id) continue;
          if(event.payload?.messageId === accepted.id && event.payload.runId) currentRunId = event.payload.runId;
          if(event.payload?.runId && event.payload.runId !== currentRunId) continue;
          const ms = Date.now()-started;
          firstEventMs ??= ms;
          if(event.eventType === "run.status.v1") firstStatusMs ??= ms;
          if(event.eventType === "run.output.preview.v1") firstPreviewMs ??= ms;
          events.push(event); onEvent(event);
          if(["run.completed.v1","run.failed.v1","run.canceled.v1"].includes(event.eventType)) { endEvent=event;return; }
        }
      }
      if(Date.now()-started > 145000) throw new Error("Conversation exceeded local smoke deadline");
      response = await openStream(); assert.equal(response.status,200,"SSE resume failed");
    }
  })();
  try {
    await reading;
    assert.equal(endEvent?.eventType,"run.completed.v1","Agent did not complete successfully");
    const runId = endEvent.payload.runId;
    let reply;
    for(let i=0;i<40;i++) {
      const history = await call(token,"GET",`/sessions/${session.id}/history?limit=100`);
      reply = history.items.find(message => message.role === "assistant" && message.replyToMessageId === accepted.id);
      if(reply) break;
      await pause(250);
    }
    assert.ok(reply,"Final answer was not projected into chat history");
    return {sessionId:session.id,messageId:accepted.id,runId,answer:reply.content,acceptedMs,firstEventMs,firstStatusMs,firstPreviewMs,totalMs:Date.now()-started,events,
      messageKey,accepted};
  } finally { stop.abort(); }
}

async function test() {
  const report = {checkedAt:new Date().toISOString(),checks:[]};
  const pass = name => { report.checks.push(name);console.log("PASS "+name); };
  const token = await login();
  const me = await call(token,"GET","/me");
  assert.equal(me.uid,(await settings()).users[0].uid); pass("Keycloak authorization-code + PKCE and API identity");
  assert.equal((await fetch(api+"/sessions")).status,401); pass("Unauthenticated API access rejected");
  const definitions = await call(token,"GET","/definitions");
  assert.ok(definitions.items.some(d=>d.id==="local-agent" && d.isDefault));
  assert.ok(definitions.items.some(d=>d.id==="local-workflow")); pass("Published native agent and workflow catalog");
  const workspace = await call(token,"POST","/workspaces/ensure");
  const path = "native-smoke/"+randomUUID()+".txt", marker = "LOCAL-"+randomBytes(6).toString("hex");
  const file = await call(token,"PUT",`/workspaces/${workspace.id}/file`,{path,content:"本地部署验证标识："+marker,expectedVersion:null});
  try {
    assert.ok((await call(token,"GET",`/workspaces/${workspace.id}/file?`+new URLSearchParams({path}))).content.includes(marker));
    await assert.rejects(()=>call(token,"PUT",`/workspaces/${workspace.id}/file`,{path,content:"must not replace",expectedVersion:null}),e=>e.status===409);
    await assert.rejects(()=>call(token,"PUT",`/workspaces/${workspace.id}/file`,{path:"../escape.txt",content:"denied",expectedVersion:null}),e=>e.status===400);
    const other = await login(1);
    await assert.rejects(()=>call(other,"GET",`/workspaces/${workspace.id}/file?`+new URLSearchParams({path})),e=>[403,404].includes(e.status));
    pass("Private workspace CRUD, version conflict, path validation and second-user denial");
    const key = randomUUID(), session = await call(token,"POST","/sessions",{title:"本地原生部署验证"},key);
    assert.equal((await call(token,"POST","/sessions",{title:"本地原生部署验证"},key)).id,session.id);
    await assert.rejects(()=>call(other,"GET",`/sessions/${session.id}`),e=>[403,404].includes(e.status));
    pass("Session idempotency and cross-user isolation");
    const content = `请先使用 workspace.read 读取文件 ${path}，然后必须使用 knowledge.search 查询 sourceId 为 local-handbook 的知识库，query 用 PostgreSQL，entityNames 用 DSH平台。根据检索证据用中文简短说明平台使用哪种数据库、它和平台的关系，最后写出文件中的验证标识。`;
    const result = await converse(token,session,content,{onEvent:event=>{if(event.eventType==="run.status.v1") console.log("progress: "+event.payload.phase+(event.payload.tool ? " / "+event.payload.tool : ""));}});
    assert.ok(result.answer.includes(marker),"Agent must read the synthetic workspace file");
    assert.match(result.answer,/PostgreSQL/i);
    assert.ok(result.events.some(e=>e.payload?.tool === "knowledge.search"),"RAG tool was not invoked");
    assert.ok(result.events.some(e=>e.payload?.tool === "workspace.read"),"Workspace tool was not invoked");
    assert.ok(result.firstStatusMs !== undefined,"Missing early status feedback");
    assert.ok(result.firstPreviewMs !== undefined,"Missing streaming model output");
    const duplicate = await call(token,"POST",`/sessions/${session.id}/messages`,{content},result.messageKey);
    assert.equal(duplicate.id,result.messageId);
    report.conversation = {sessionId:result.sessionId,runId:result.runId,acceptedMs:result.acceptedMs,firstStatusMs:result.firstStatusMs,firstPreviewMs:result.firstPreviewMs,totalMs:result.totalMs,answer:result.answer,
      tools:[...new Set(result.events.filter(e=>e.payload?.tool).map(e=>e.payload.tool))],
      phases:[...new Set(result.events.filter(e=>e.eventType==="run.status.v1").map(e=>e.payload.phase))]};
    pass("Real DeepSeek + DSH + workspace tools + non-vector RAG + SSE + durable reply + message idempotency");
    const second = await converse(token,session,"/brief-answer\n不要再调用任何文件工具，只根据此前对话告诉我刚才的验证标识是什么。只返回标识。");
    assert.ok(second.answer.includes(marker),"Native context lost prior conversation");
    const secondTools=[...new Set(second.events.filter(e=>e.payload?.tool).map(e=>e.payload.tool))];
    // DSH expands explicit /skill gestures into context; it intentionally emits no tool event.
    // The regression fixture inspects that injected context. This live check verifies the
    // returned marker and absence of workspace/knowledge rereads, not provider prompt content.
    assert.equal(secondTools.length,0,"History-only explicit-skill turn must not invoke tools");
    report.secondTurn={runId:second.runId,tools:secondTools,markerRetained:true,explicitSkillMode:"native-context-injection",totalMs:second.totalMs,answer:second.answer};
    pass("Second turn: DSH native context and explicit skill invocation");
    for(const endpoint of ["/quota","/usage","/audit"]) await call(token,"GET",endpoint);
    pass("Quota, usage and audit API queries");
  } finally {
    await call(token,"DELETE",`/workspaces/${workspace.id}/file?`+new URLSearchParams({path,expectedVersion:file.version}));
  }
  await writeFile(resolve(state,"verification.json"),JSON.stringify(report,null,2)+"\n",{mode:0o600});
  console.log("Verification saved to .local/native/verification.json. Synthetic session history retained; temporary test file deleted.");
}
async function ask(content) {
  assert.ok(content,"Usage: node dsh-agent-deploy/native/client.mjs ask \"your question\"");
  const token = await login(), session = await call(token,"POST","/sessions",{title:content.slice(0,80)},randomUUID());
  const result = await converse(token,session,content,{onEvent:event=>{
    if(event.eventType === "run.status.v1") console.log("["+event.payload.phase+(event.payload.tool ? ": "+event.payload.tool : "")+"]");
    if(event.eventType === "run.output.preview.v1") process.stdout.write(event.payload.text);
  }});
  console.log("\n\nFinal answer:\n"+result.answer+"\n\nSession: "+result.sessionId);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if(process.argv[2] === "test") await test();
    else if(process.argv[2] === "ask") await ask(process.argv.slice(3).join(" "));
    else if(process.argv[2] === "login") { const token=await login();console.log(JSON.stringify(await call(token,"GET","/me"),null,2)); }
    else throw new Error("Expected test, login or ask QUESTION");
  } catch(error) { console.error("Native client failed:",error.message);process.exitCode=1; }
}

// Windows native infrastructure only; never reads or modifies the user's root .env.
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { readFile, writeFile, mkdir, access } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { parseEnv } from "node:util";
import { spawn } from "node:child_process";
import assert from "node:assert/strict";
import pg from "pg";
import { S3Client, HeadBucketCommand, GetObjectCommand, CreateBucketCommand } from "@aws-sdk/client-s3";

const root = fileURLToPath(new URL("../../", import.meta.url));
const state = resolve(root, ".local/native");
const roles = {
  chat: "CHAT", iam: "IAM", workspace: "WORKSPACE", catalog: "CATALOG",
  catalog_reader: "CATALOG_READ", run_control: "RUN_CONTROL", quota: "QUOTA",
  audit: "AUDIT", audit_writer: "AUDIT_WRITER", knowledge: "KNOWLEDGE", knowledge_reader: "KNOWLEDGE_READ",
};
const owners = ["chat", "iam", "workspace", "catalog", "run_control", "quota", "audit", "knowledge"];
const secret = () => randomBytes(32).toString("hex");
const exists = async path => { try { await access(path); return true; } catch (e) { if (e.code === "ENOENT") return false; throw e; } };
const saveNew = (name, data) => writeFile(resolve(state, name), data, { flag: "wx", mode: 0o600 });
const readEnv = async () => parseEnv(await readFile(resolve(state, ".env"), "utf8"));
const dbUrl = (role, password, database = "agent") => `postgresql://${role}:${encodeURIComponent(password)}@127.0.0.1:5432/${database}`;
async function database(env, role = "platform_admin", database = "agent") {
  const password = role === "platform_admin" ? env.PG_ROOT_PASSWORD : env[roles[role] + "_DB_PASSWORD"];
  const client = new pg.Client({ connectionString: dbUrl(role, password, database), connectionTimeoutMillis: 5000, statement_timeout: 10000 });
  await client.connect();
  return client;
}

async function download() {
  const dir = resolve(root, ".tools/seaweedfs-4.47");
  const archive = resolve(dir, "windows_amd64.zip");
  await mkdir(dir, { recursive: true });
  let bytes;
  if (await exists(archive)) bytes = await readFile(archive);
  else {
    const response = await fetch("https://github.com/seaweedfs/seaweedfs/releases/download/4.47/windows_amd64.zip", { signal: AbortSignal.timeout(180000) });
    if (!response.ok) throw new Error("SeaweedFS download HTTP " + response.status);
    bytes = Buffer.from(await response.arrayBuffer());
  }
  const digest = createHash("sha256").update(bytes).digest("hex");
  assert.equal(digest, "8809359079e62fcd60574ff661449160899622c52072f3f569d346669079efe9", "Official release SHA-256 mismatch");
  if (!(await exists(archive))) await writeFile(archive, bytes, { flag: "wx" });
  console.log("SeaweedFS 4.47 archive verified (SHA-256).");
}

async function init() {
  // PowerShell creates state with a restricted Windows ACL before invoking this action.
  await access(state);
  const bin = resolve(process.argv[3]);
  await access(resolve(bin, "postgres.exe"));
  if (await exists(resolve(state, "settings.json"))) {
    const previous = JSON.parse(await readFile(resolve(state, "settings.json"), "utf8"));
    assert.equal(previous.postgresBin.toLowerCase(), bin.toLowerCase(), "Refusing to change existing PostgreSQL binaries");
  } else await saveNew("settings.json", JSON.stringify({ postgresBin: bin }, null, 2));
  if (!(await exists(resolve(state, ".env")))) {
    // Do not silently re-key an existing cluster if its credential file was lost.
    assert.equal(await exists(resolve(state, "postgres/PG_VERSION")), false, "Existing cluster without credentials: restore .env first");
    assert.equal(await exists(resolve(state, "seaweedfs.json")), false, "Existing S3 config without credentials: restore .env first");
    const env = {
      NODE_ENV: "development", PG_ROOT_PASSWORD: secret(),
      S3_ENDPOINT: "http://127.0.0.1:8333", S3_REGION: "us-east-1", S3_BUCKET: "dsh-workspaces",
      S3_ACCESS_KEY: "dsh" + randomBytes(10).toString("hex"), S3_SECRET_KEY: secret(),
    };
    for (const [role, prefix] of Object.entries(roles)) {
      env[prefix + "_DB_PASSWORD"] = secret();
      env[prefix + "_DATABASE_URL"] = dbUrl(role, env[prefix + "_DB_PASSWORD"]);
    }
    await saveNew(".env", Object.entries(env).map(([k, v]) => `${k}=${v}`).join("\n") + "\n");
  }
  const env = await readEnv();
  const identity = { identities: [{ name: "dsh-workspace", credentials: [{ accessKey: env.S3_ACCESS_KEY, secretKey: env.S3_SECRET_KEY }], actions: ["Read", "Write", "List"].map(a => `${a}:${env.S3_BUCKET}`) }] };
  if (!(await exists(resolve(state, "seaweedfs.json")))) await saveNew("seaweedfs.json", JSON.stringify(identity, null, 2));
  else assert.deepEqual(JSON.parse(await readFile(resolve(state, "seaweedfs.json"), "utf8")), identity, "S3 configuration differs from .env; reconcile manually");
  if (!(await exists(resolve(state, "postgres/PG_VERSION"))) && !(await exists(resolve(state, "postgres-password.txt")))) {
    await saveNew("postgres-password.txt", env.PG_ROOT_PASSWORD + "\n");
  }
  console.log("Native credentials ready; existing credentials preserved.");
}

async function provision() {
  const env = await readEnv();
  // Upgrade older native installations without rotating any existing credentials.
  let added = false;
  for (const [role, prefix] of Object.entries(roles)) {
    if (!env[prefix + "_DB_PASSWORD"]) {
      env[prefix + "_DB_PASSWORD"] = secret();
      env[prefix + "_DATABASE_URL"] = dbUrl(role, env[prefix + "_DB_PASSWORD"]);
      added = true;
    }
  }
  if (added) await writeFile(resolve(state, ".env"), Object.entries(env).map(([k,v]) => `${k}=${v}`).join("\n") + "\n", { mode: 0o600 });
  const admin = await database(env, "platform_admin", "postgres");
  try {
    if (!(await admin.query("SELECT 1 FROM pg_database WHERE datname='agent'")).rowCount) await admin.query("CREATE DATABASE agent OWNER platform_admin");
  } finally { await admin.end(); }
  const client = await database(env);
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(78411299)");
    await client.query("REVOKE CREATE ON SCHEMA public FROM PUBLIC; REVOKE ALL ON DATABASE agent FROM PUBLIC");
    for (const [role, prefix] of Object.entries(roles)) {
      const password = env[prefix + "_DB_PASSWORD"];
      // Role names are a fixed allowlist; passwords are generated hex, never interpolated arbitrary input.
      assert.match(password, /^[a-f0-9]{64}$/);
      if (!(await client.query("SELECT 1 FROM pg_roles WHERE rolname=$1", [role])).rowCount) {
        await client.query(`CREATE ROLE ${role} LOGIN PASSWORD '${password}'`);
      }
      await client.query(`GRANT CONNECT, TEMPORARY ON DATABASE agent TO ${role}`);
      const schema = role === "catalog_reader" ? "catalog" : role === "audit_writer" ? "audit" : role === "knowledge_reader" ? "knowledge" : role;
      await client.query(`ALTER ROLE ${role} SET search_path TO ${schema}`);
    }
    for (const role of owners) await client.query(`CREATE SCHEMA IF NOT EXISTS ${role} AUTHORIZATION ${role}`);
    for (const [owner, reader, grants] of [["catalog", "catalog_reader", "SELECT"], ["audit", "audit_writer", "SELECT, INSERT"], ["knowledge", "knowledge_reader", "SELECT"]]) {
      await client.query(`GRANT USAGE ON SCHEMA ${owner} TO ${reader}`);
      await client.query(`GRANT ${grants} ON ALL TABLES IN SCHEMA ${owner} TO ${reader}`);
      await client.query(`ALTER DEFAULT PRIVILEGES FOR ROLE ${owner} IN SCHEMA ${owner} GRANT ${grants} ON TABLES TO ${reader}`);
    }
    await client.query("COMMIT");
  } catch (e) { await client.query("ROLLBACK"); throw e; }
  finally { await client.end(); }
  console.log(`Database agent and ${Object.keys(roles).length} service roles provisioned; existing passwords retained. Business migrations are a separate step.`);
}

async function verify() {
  const env = await readEnv();
  const client = await database(env);
  try { console.log("PostgreSQL:", (await client.query("SELECT version() AS version")).rows[0].version.split(" on ")[0]); }
  finally { await client.end(); }
  for (const role of Object.keys(roles)) {
    const connection = await database(env, role);
    try {
      const info = (await connection.query("SELECT current_user AS name, current_schema() AS schema")).rows[0];
      assert.equal(info.name, role);
      assert.ok(info.schema);
      if (role === "chat") assert.equal((await connection.query("SELECT has_schema_privilege(current_user, 'workspace', 'USAGE') AS allowed")).rows[0].allowed, false);
    } finally { await connection.end(); }
  }
  const invalid = new pg.Client({ connectionString: dbUrl("chat", "invalid-" + randomUUID()), connectionTimeoutMillis: 5000 });
  try { await assert.rejects(() => invalid.connect(), e => e.code === "28P01"); } finally { await invalid.end(); }
  console.log(`PostgreSQL: ${Object.keys(roles).length} role logins, cross-schema denial and invalid-password rejection PASS.`);
  const { s3Store } = await import("../../dsh-agent-workspace/dist/storage.js");
  const config = { endpoint: env.S3_ENDPOINT, region: env.S3_REGION, bucket: env.S3_BUCKET, accessKeyId: env.S3_ACCESS_KEY, secretAccessKey: env.S3_SECRET_KEY };
  const storage = s3Store(config);
  const sdk = new S3Client({ endpoint: config.endpoint, region: config.region, forcePathStyle: true, maxAttempts: 1, credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey } });
  const key = `_native-probe/${randomUUID()}.txt`;
  const body = Buffer.from("DSH native S3 check: 中文\n");
  let created = false;
  const options = () => ({ abortSignal: AbortSignal.timeout(10000) });
  try {
    await storage.ready();
    await storage.put(key, body); created = true;
    assert.deepEqual(Buffer.from(await storage.get(key, body.length)), body);
    await assert.rejects(() => storage.put(key, Buffer.from("must not overwrite")), e => e.$metadata?.httpStatusCode === 412);
    assert.deepEqual(Buffer.from(await storage.get(key, body.length)), body);
    for (const path of [env.S3_BUCKET, `${env.S3_BUCKET}/${key}`]) {
      const response = await fetch(`${env.S3_ENDPOINT}/${path}`, { signal: AbortSignal.timeout(5000) });
      assert.equal(response.status, 403, "Anonymous S3 access must be denied");
      await response.body?.cancel();
    }
    const deniedBucket = "dsh-denied-" + randomUUID();
    await assert.rejects(() => sdk.send(new CreateBucketCommand({ Bucket: deniedBucket }), options()), e => e.$metadata?.httpStatusCode === 403);
    const bad = new S3Client({ endpoint: config.endpoint, region: config.region, forcePathStyle: true, maxAttempts: 1, credentials: { accessKeyId: config.accessKeyId, secretAccessKey: "invalid" } });
    try { await assert.rejects(() => bad.send(new HeadBucketCommand({ Bucket: config.bucket }), options()), e => e.$metadata?.httpStatusCode === 403); }
    finally { bad.destroy(); }
    await storage.delete(key); created = false;
    await assert.rejects(() => sdk.send(new GetObjectCommand({ Bucket: config.bucket, Key: key }), options()), e => e.$metadata?.httpStatusCode === 404);
    console.log("S3: private bucket, put/get/delete, conditional-write 412, anonymous/invalid-key denial and bucket-scoped credentials PASS.");
  } finally {
    try { if (created) await storage.delete(key); }
    finally { storage.close(); sdk.destroy(); }
  }
}

async function ensureBucket() {
  const env = await readEnv();
  const client = new S3Client({endpoint:env.S3_ENDPOINT,region:env.S3_REGION,forcePathStyle:true,maxAttempts:1,
    credentials:{accessKeyId:env.S3_ACCESS_KEY,secretAccessKey:env.S3_SECRET_KEY}});
  try {
    try { await client.send(new HeadBucketCommand({Bucket:env.S3_BUCKET}),{abortSignal:AbortSignal.timeout(5000)});return; }
    catch(error) { if(error.$metadata?.httpStatusCode !== 404) throw error; }
    assert.equal(env.S3_BUCKET,"dsh-workspaces","Refusing to create an unexpected native bucket");
    // Trusted setup uses the loopback-only filer administration endpoint. The application
    // S3 identity keeps bucket-scoped permissions and never gains an administrator credential.
    const child = spawn(resolve(root,".tools/seaweedfs-4.47/bin/weed.exe"),["shell","-master=127.0.0.1:9333","-filer=127.0.0.1:8888"],
      {cwd:state,windowsHide:true,stdio:["pipe","ignore","ignore"]});
    child.stdin.on("error",()=>{});
    child.stdin.end("fs.mkdir /buckets/dsh-workspaces\n");
    await new Promise((accept,reject) => {
      const timer=setTimeout(()=>{child.kill();reject(new Error("Bucket bootstrap timed out"));},15000);
      child.once("error",error=>{clearTimeout(timer);reject(error);});
      child.once("exit",code=>{clearTimeout(timer);code===0 ? accept() : reject(new Error("Bucket bootstrap failed"));});
    });
    await client.send(new HeadBucketCommand({Bucket:env.S3_BUCKET}),{abortSignal:AbortSignal.timeout(5000)});
    console.log("Native private workspace bucket ready.");
  } finally {client.destroy();}
}

const action = process.argv[2];
try {
  if (action === "download") await download();
  else if (action === "init") await init();
  else if (action === "provision") await provision();
  else if (action === "verify") await verify();
  else if (action === "bucket") await ensureBucket();
  else throw new Error("Expected download, init, provision, bucket or verify");
} catch (error) {
  // Database driver errors may contain the SQL statement; do not dump objects or connection strings.
  console.error("Native infrastructure failed:", error.code ?? error.name, error.message.replace(/postgresql:\/\/[^\s]+/g, "[redacted connection]"));
  process.exitCode = 1;
}

import { randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
const keys = ["PG_ROOT_PASSWORD", "CHAT_DB_PASSWORD", "IAM_DB_PASSWORD",
  "API_CHAT_SECRET", "CHAT_CAPABILITY_SECRET", "NATS_TOKEN", "KC_ADMIN_PASSWORD",
  "WORKSPACE_DB_PASSWORD", "CATALOG_DB_PASSWORD", "CATALOG_READ_DB_PASSWORD",
  "API_WORKSPACE_SECRET", "CHAT_WORKSPACE_SECRET", "API_CATALOG_SECRET", "CHAT_CATALOG_SECRET",
  "RUN_CONTROL_DB_PASSWORD", "API_RUN_CONTROL_SECRET", "RUNTIME_RUN_CONTROL_SECRET",
  "RUN_CONTROL_CHAT_SECRET", "RUN_CONTROL_CATALOG_SECRET", "RUN_CONTROL_WORKSPACE_SECRET", "WORKSPACE_RUN_CONTROL_SECRET",
  "QUOTA_DB_PASSWORD", "AUDIT_DB_PASSWORD", "AUDIT_WRITER_DB_PASSWORD", "API_QUOTA_SECRET", "API_AUDIT_SECRET", "RUN_CONTROL_QUOTA_SECRET", "RUN_CONTROL_AUDIT_SECRET",
  "CHAT_AUDIT_SECRET", "WORKSPACE_AUDIT_SECRET", "CHAT_METRICS_SECRET", "WORKSPACE_METRICS_SECRET", "RUN_CONTROL_METRICS_SECRET"];
const defaults = {
  RUNTIME_ENABLED: "false", DEEPSEEK_API_KEY: "", DEEPSEEK_BASE_URL: "https://api.deepseek.com", RUNTIME_MAX_TOOL_CALLS: "100", POINTS_BILLING_ENABLED: "false",
  API_MAX_IN_FLIGHT: "128", CHAT_MESSAGES_PER_MINUTE: "120", CHAT_PENDING_PER_USER: "1000", CHAT_PENDING_PER_SESSION: "100",
  CHAT_PUBLISH_WORKERS: "2", CHAT_DB_POOL_MAX: "10", CHAT_DB_MAX_WAITING: "64",
  RUN_DELIVERY_WORKERS: "2", RUN_MAX_ACTIVE: "64", RUN_USER_ACTIVE: "2", RUN_TENANT_ACTIVE: "32", RUN_AGING_SECONDS: "60",
  RUN_DB_POOL_MAX: "10", RUN_DB_MAX_WAITING: "64", RUNTIME_CONCURRENCY: "1",
  RUNTIME_MODEL_MAX_RETRIES: "2", RUNTIME_MODEL_RETRY_INITIAL_MS: "500", RUNTIME_MODEL_RETRY_MAX_MS: "10000",
  S3_ENDPOINT: "http://host.docker.internal:9000", S3_REGION: "us-east-1", S3_BUCKET: "dsh-workspaces",
  S3_ACCESS_KEY: "configure-your-storage-access-key", S3_SECRET_KEY: "configure-your-storage-secret-key",
};
const target = new URL(".env", import.meta.url);
const additions = existing => {
  const names = new Set(existing.split(/\r?\n/).map(line => /^([A-Z0-9_]+)=/.exec(line)?.[1]).filter(Boolean));
  return [
    ...keys.filter(key => !names.has(key)).map(key => key + "=" + randomBytes(32).toString("hex")),
    ...Object.entries(defaults).filter(([key]) => !names.has(key)).map(([key, value]) => key + "=" + value),
  ].join("\n");
};
try {
  await writeFile(target, additions("") + "\n", { flag: "wx", mode: 0o600 });
  console.log("Created local credentials. Configure S3 settings before starting Workspace.");
} catch (error) {
  if (error.code !== "EEXIST") throw error;
  const existing = await readFile(target, "utf8");
  const extra = additions(existing);
  if (extra) await writeFile(target, (existing.endsWith("\n") ? "" : "\n") + extra + "\n", { flag: "a", mode: 0o600 });
  console.log(extra ? "Added missing settings; existing values retained. Configure S3 before startup." : "Existing .env retained.");
}

import { z } from "zod";
import { createApiApp } from "./app.js";
import { remoteIdentityVerifier } from "./auth.js";
import { chatClient, serviceClient } from "./chat-client.js";

const env = z.object({
  IAM_ISSUER: z.string().url(), IAM_JWKS_URL: z.string().url(),
  IAM_AUDIENCE: z.string().default("agent-platform"),
  CHAT_URL: z.string().url(), API_CHAT_SECRET: z.string().min(32),
  WORKSPACE_URL: z.url(), API_WORKSPACE_SECRET: z.string().min(32),
  CATALOG_URL: z.url(), API_CATALOG_SECRET: z.string().min(32),
  RUN_CONTROL_URL: z.url(), API_RUN_CONTROL_SECRET: z.string().min(32),
  QUOTA_URL: z.url(), API_QUOTA_SECRET: z.string().min(32), AUDIT_URL: z.url(), API_AUDIT_SECRET: z.string().min(32),
  PORT: z.coerce.number().int().default(8080),
  HOST: z.enum(["127.0.0.1", "0.0.0.0"]).default("0.0.0.0"),
  API_MAX_IN_FLIGHT: z.coerce.number().int().min(1).max(10000).default(128),
}).parse(process.env);
const app = createApiApp({
  maxInFlight: env.API_MAX_IN_FLIGHT,
  authenticate: remoteIdentityVerifier(env.IAM_ISSUER, env.IAM_AUDIENCE, env.IAM_JWKS_URL),
  chat: chatClient(env.CHAT_URL, env.API_CHAT_SECRET), logger: true,
  workspace: serviceClient(env.WORKSPACE_URL, env.API_WORKSPACE_SECRET, "dsh-agent-workspace"),
  catalog: serviceClient(env.CATALOG_URL, env.API_CATALOG_SECRET, "dsh-agent-catalog"),
  runs: serviceClient(env.RUN_CONTROL_URL, env.API_RUN_CONTROL_SECRET, "dsh-agent-run-control"),
  quota: serviceClient(env.QUOTA_URL, env.API_QUOTA_SECRET, "dsh-agent-quota"),
  audit: serviceClient(env.AUDIT_URL, env.API_AUDIT_SECRET, "dsh-agent-audit"),
});
await app.listen({ host: env.HOST, port: env.PORT, backlog: 1024 });
process.once("SIGTERM", () => void app.close());
process.once("SIGINT", () => void app.close());

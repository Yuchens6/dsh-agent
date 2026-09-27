import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import type { Database } from "../dsh-agent-chat/src/database.js";
export const alice = { uid: "alice", tenantId: "tenant-a", roles: ["user"] };
export const bob = { uid: "bob", tenantId: "tenant-a", roles: ["user"] };
export const otherTenant = { ...alice, tenantId: "tenant-b" };
export const secret = "test-only-service-secret-at-least-32-bytes";
export const capabilitySecret = "test-only-capability-secret-separate-32-bytes";
export const testBinding = async () => ({
  workspaceId: "01960000-0000-7000-8000-000000000001", agentDefinitionId: "document-agent", agentDefinitionVersion: 1,
});
export async function database() {
  const pg = new PGlite();
  await pg.exec("CREATE SCHEMA chat");
  await pg.exec(await readFile(new URL("../dsh-agent-chat/migrations/001_initial.sql", import.meta.url), "utf8"));
  await pg.exec(await readFile(new URL("../dsh-agent-chat/migrations/002_execution.sql", import.meta.url), "utf8"));
  await pg.exec(await readFile(new URL("../dsh-agent-chat/migrations/003_lifecycle.sql", import.meta.url), "utf8"));
  await pg.exec(await readFile(new URL("../dsh-agent-chat/migrations/004_audit.sql", import.meta.url), "utf8"));
  await pg.exec(await readFile(new URL("../dsh-agent-chat/migrations/005_admission.sql", import.meta.url), "utf8"));
  const db: Database = {
    query: (sql, values) => pg.query(sql, values),
    transaction: work => pg.transaction(tx => work({ query: (sql, values) => tx.query(sql, values) })),
  };
  return { pg, db };
}
export async function identity() {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const jwk = await exportJWK(publicKey);
  const key = createLocalJWKSet({ keys: [{ ...jwk, kid: "test-key", alg: "RS256" }] });
  const issuer = "https://iam.test/realms/agent";
  async function token(actor = alice, overrides: Record<string, unknown> = {}) {
    return new SignJWT({ tenantId: actor.tenantId, roles: actor.roles, ...overrides })
      .setProtectedHeader({ alg: "RS256", kid: "test-key" }).setSubject(actor.uid)
      .setIssuer(issuer).setAudience("agent-platform").setIssuedAt().setExpirationTime("5m")
      .sign(privateKey);
  }
  return { key, issuer, token, privateKey };
}

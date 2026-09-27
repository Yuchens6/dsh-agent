import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import type { Database } from "../dsh-agent-workspace/src/database.js";
import type { BlobStore } from "../dsh-agent-workspace/src/storage.js";
export async function serviceDatabase(...schemas: Array<"chat" | "workspace" | "catalog" | "run_control" | "quota" | "audit">) {
  const pg = new PGlite();
  for (const schema of schemas) {
    await pg.exec("CREATE SCHEMA " + schema);
    await pg.exec(await readFile(new URL("../dsh-agent-" + schema.replaceAll("_", "-") + "/migrations/001_initial.sql", import.meta.url), "utf8"));
    if (schema === "chat" || schema === "run_control") {
      await pg.exec(await readFile(new URL("../dsh-agent-" + schema.replaceAll("_", "-") + "/migrations/002_execution.sql", import.meta.url), "utf8"));
    }
    if (schema === "run_control") await pg.exec(await readFile(new URL("../dsh-agent-run-control/migrations/003_support.sql", import.meta.url), "utf8"));
    if (schema === "run_control") await pg.exec(await readFile(new URL("../dsh-agent-run-control/migrations/004_usage.sql", import.meta.url), "utf8"));
    if (schema === "run_control") await pg.exec(await readFile(new URL("../dsh-agent-run-control/migrations/005_workflow.sql", import.meta.url), "utf8"));
    if (schema === "run_control") await pg.exec(await readFile(new URL("../dsh-agent-run-control/migrations/006_dispatch.sql", import.meta.url), "utf8"));
    if (schema === "quota") await pg.exec(await readFile(new URL("../dsh-agent-quota/migrations/002_usage.sql", import.meta.url), "utf8"));
    if (schema === "quota") await pg.exec(await readFile(new URL("../dsh-agent-quota/migrations/003_points.sql", import.meta.url), "utf8"));
    if (schema === "chat") await pg.exec(await readFile(new URL("../dsh-agent-chat/migrations/003_lifecycle.sql", import.meta.url), "utf8"));
    if (schema === "chat") await pg.exec(await readFile(new URL("../dsh-agent-chat/migrations/004_audit.sql", import.meta.url), "utf8"));
    if (schema === "chat") await pg.exec(await readFile(new URL("../dsh-agent-chat/migrations/005_admission.sql", import.meta.url), "utf8"));
    if (schema === "workspace") await pg.exec(await readFile(new URL("../dsh-agent-workspace/migrations/002_audit.sql", import.meta.url), "utf8"));
    if (schema === "audit") await pg.exec(await readFile(new URL("../dsh-agent-audit/migrations/002_producers.sql", import.meta.url), "utf8"));
  }
  const db: Database = {
    query: (sql, values) => pg.query(sql, values),
    transaction: work => pg.transaction(tx => work({ query: (sql, values) => tx.query(sql, values) })),
  };
  return { pg, db };
}
export class MemoryBlobs implements BlobStore {
  objects = new Map<string, Uint8Array>();
  puts = 0;
  failPut = false;
  failDelete = false;
  async put(key: string, content: Uint8Array) {
    this.puts++;
    if (this.failPut) throw new Error("secret endpoint failure");
    if (this.objects.has(key)) throw new Error("immutable key exists");
    this.objects.set(key, content.slice());
  }
  async get(key: string, _expectedBytes: number) {
    const content = this.objects.get(key);
    if (!content) throw new Error("missing blob");
    return content.slice();
  }
  async delete(key: string) {
    if (this.failDelete) throw new Error("storage offline");
    this.objects.delete(key);
  }
  async ready() {}
}
export const definition = {
  id: "document-agent", version: 1, name: "文档助手", description: "安全文件操作",
  systemPrompt: "Only approved workspace tools.", model: { provider: "deepseek-official", name: "test-model" },
  tools: ["workspace.list", "workspace.read", "workspace.write"], skills: [],
  execution: { maxTurns: 5, maxOutputTokens: 1000, timeoutSeconds: 30 },
};
export const serviceSecrets = {
  apiWorkspace: "test-only-api-workspace-key-at-least-32",
  chatWorkspace: "test-only-chat-workspace-key-at-least-32",
  apiCatalog: "test-only-api-catalog-key-at-least-32",
  chatCatalog: "test-only-chat-catalog-key-at-least-32",
};

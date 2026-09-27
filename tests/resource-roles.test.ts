import test from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
test("PostgreSQL: Workspace/Catalog 模式隔离，Catalog 在线账号只有只读权限", async t => {
  const pg = new PGlite(); t.after(() => pg.close());
  await pg.exec("CREATE ROLE chat; CREATE ROLE workspace; CREATE ROLE catalog; CREATE ROLE catalog_reader; CREATE ROLE run_control;" +
    "CREATE SCHEMA chat AUTHORIZATION chat; CREATE SCHEMA workspace AUTHORIZATION workspace;" +
    "CREATE SCHEMA catalog AUTHORIZATION catalog; CREATE SCHEMA run_control AUTHORIZATION run_control; GRANT USAGE ON SCHEMA catalog TO catalog_reader;" +
    "ALTER DEFAULT PRIVILEGES FOR ROLE catalog IN SCHEMA catalog GRANT SELECT ON TABLES TO catalog_reader;");
  for (const schema of ["workspace", "catalog", "chat", "run_control"]) {
    await pg.exec("SET ROLE " + schema);
    await pg.exec(await readFile(new URL("../dsh-agent-" + schema.replaceAll("_", "-") + "/migrations/001_initial.sql", import.meta.url), "utf8"));
    if (schema === "chat" || schema === "run_control") {
      await pg.exec(await readFile(new URL("../dsh-agent-" + schema.replaceAll("_", "-") + "/migrations/002_execution.sql", import.meta.url), "utf8"));
    }
    await pg.exec("RESET ROLE");
  }
  await pg.exec("SET ROLE workspace");
  await assert.rejects(pg.query("SELECT * FROM chat.conversations"), /permission denied/);
  await assert.rejects(pg.query("SELECT * FROM catalog.definitions"), /permission denied/);
  await pg.exec("RESET ROLE; SET ROLE catalog_reader");
  assert.equal((await pg.query("SELECT version FROM catalog.schema_migrations")).rows.length, 1);
  await assert.rejects(pg.query("INSERT INTO catalog.definitions(id,version,document,document_hash) VALUES('x',1,'{}','x')"), /permission denied/);
  await assert.rejects(pg.query("DELETE FROM catalog.tenant_definitions"), /permission denied/);
  await assert.rejects(pg.query("SELECT * FROM workspace.files"), /permission denied/);
  await pg.exec("RESET ROLE; SET ROLE run_control");
  assert.equal((await pg.query("SELECT version FROM run_control.schema_migrations")).rows.length, 2);
  await assert.rejects(pg.query("SELECT * FROM chat.conversation_messages"), /permission denied/);
  await assert.rejects(pg.query("SELECT * FROM workspace.files"), /permission denied/);
});

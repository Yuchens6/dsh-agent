import test from "node:test";
import assert from "node:assert/strict";
import { CatalogRepository } from "../dsh-agent-catalog/src/repository.js";
import { alice, otherTenant } from "./helpers.js";
import { serviceDatabase, definition } from "./workspace-catalog-helpers.js";

test("Catalog: 明确租户授权、不可变版本、默认版本切换且旧版可查", async t => {
  const { pg, db } = await serviceDatabase("catalog"); t.after(() => pg.close());
  const repo = new CatalogRepository(db);
  await assert.rejects(repo.getDefault(alice), /NOT_FOUND/);
  await repo.publish(definition, alice.tenantId, true);
  await repo.publish(definition, alice.tenantId, true);
  assert.equal((await repo.getDefault(alice)).version, 1);
  assert.deepEqual((await repo.list(otherTenant)).items, []);
  await assert.rejects(repo.get(otherTenant, definition.id, 1), /NOT_FOUND/);
  await assert.rejects(repo.publish({ ...definition, systemPrompt: "Changed" }, alice.tenantId, true), /VERSION_CONFLICT/);
  assert.equal((await repo.getDefault(alice)).version, 1);
  await repo.publish({ ...definition, version: 2, name: "新版" }, alice.tenantId, true);
  assert.equal((await repo.getDefault(alice)).version, 2);
  assert.equal((await repo.get(alice, definition.id, 1)).version, 1);
  const page = await repo.list(alice);
  assert.equal(page.items.filter(d => d.isDefault).length, 1);
  assert.equal("systemPrompt" in page.items[0]!, false);
  await assert.rejects(db.query("UPDATE catalog.definitions SET document='{}'::jsonb"), /immutable/);
  await assert.rejects(db.query("DELETE FROM catalog.definitions"), /immutable/);
});

test("Catalog: 拒绝 shell/MCP、未知配置、重复工具、未审核远程技能引用", async t => {
  const { pg, db } = await serviceDatabase("catalog"); t.after(() => pg.close());
  const repo = new CatalogRepository(db);
  for (const unsafe of [
    { ...definition, tools: ["bash"] },
    { ...definition, mcp: { url: "https://untrusted.test" } },
    { ...definition, tools: ["workspace.read", "workspace.read"] },
    { ...definition, skills: [{ id: "x", version: 1, url: "https://untrusted.test" }] },
    { ...definition, execution: { ...definition.execution, timeoutSeconds: 100000 } },
  ]) await assert.rejects(repo.publish(unsafe, alice.tenantId, true));
  assert.equal((await db.query("SELECT * FROM catalog.definitions")).rows.length, 0);
});

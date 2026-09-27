import test from "node:test";
import assert from "node:assert/strict";
import { WorkspaceRepository } from "../dsh-agent-workspace/src/repository.js";
import { alice, bob, otherTenant } from "./helpers.js";
import { serviceDatabase, MemoryBlobs } from "./workspace-catalog-helpers.js";

test("Workspace: 按租户/用户唯一分配、跨用户所有操作拒绝、拒绝宿主路径", async t => {
  const { pg, db } = await serviceDatabase("workspace"); t.after(() => pg.close());
  const store = new MemoryBlobs(), repo = new WorkspaceRepository(db, store);
  const workspace = await repo.ensure(alice);
  assert.equal(workspace.id, (await repo.ensure(alice)).id);
  assert.equal(workspace.directoryName, alice.uid);
  assert.notEqual(workspace.id, (await repo.ensure(otherTenant)).id);
  const file = await repo.write(alice, workspace.id, { path: "文档/你好.txt", content: "你好", expectedVersion: null });
  assert.equal(file.sizeBytes, 6);
  for (const foreign of [bob, otherTenant]) {
    await assert.rejects(repo.get(foreign, workspace.id), /NOT_FOUND/);
    await assert.rejects(repo.list(foreign, workspace.id, { limit: 10 }), /NOT_FOUND/);
    await assert.rejects(repo.read(foreign, workspace.id, file.path), /NOT_FOUND/);
    await assert.rejects(repo.write(foreign, workspace.id, { path: "x", content: "x", expectedVersion: null }), /NOT_FOUND/);
    await assert.rejects(repo.delete(foreign, workspace.id, file.path, file.version), /NOT_FOUND/);
  }
  for (const path of ["../bob/key", "/etc/passwd", "a/../../b", "C:/Windows/a", "a\\b", "a//b", "a/", ".", "a/.", "%2e%2e/secret", "a\0b", "cafe\u0301", "\ud800"]) {
    await assert.rejects(repo.write(alice, workspace.id, { path, content: "bad", expectedVersion: null }), path);
  }
  await assert.rejects(repo.write(alice, workspace.id, { path: "a", content: "\ud800", expectedVersion: null }));
  await assert.rejects(repo.write(alice, workspace.id, { path: "a", content: "\0", expectedVersion: null }));
  assert.equal(store.puts, 1, "越权/非法路径在访问对象存储前拒绝");
  assert.equal((await repo.read(alice, workspace.id, file.path)).content, "你好");
  assert.equal(store.objects.keys().next().value, workspace.id + "/" + file.version);
});

test("Workspace: 版本条件更新、删除重建无 ABA、目录冲突及稳定游标分页", async t => {
  const { pg, db } = await serviceDatabase("workspace"); t.after(() => pg.close());
  const repo = new WorkspaceRepository(db, new MemoryBlobs());
  const { id } = await repo.ensure(alice);
  const first = await repo.write(alice, id, { path: "notes/a.txt", content: "old", expectedVersion: null });
  const second = await repo.write(alice, id, { path: first.path, content: "new", expectedVersion: first.version });
  assert.notEqual(first.version, second.version);
  await assert.rejects(repo.write(alice, id, { path: first.path, content: "lost", expectedVersion: first.version }), /VERSION_CONFLICT/);
  await assert.rejects(repo.delete(alice, id, first.path, first.version), /VERSION_CONFLICT/);
  await assert.rejects(repo.write(alice, id, { path: "notes", content: "not directory", expectedVersion: null }), /VERSION_CONFLICT/);
  await assert.rejects(repo.write(alice, id, { path: "notes/a.txt/nested", content: "x", expectedVersion: null }), /VERSION_CONFLICT/);
  await repo.write(alice, id, { path: "notes/b.txt", content: "b", expectedVersion: null });
  await repo.write(alice, id, { path: "other.txt", content: "c", expectedVersion: null });
  const page = await repo.list(alice, id, { prefix: "notes", limit: 1 });
  const next = await repo.list(alice, id, { prefix: "notes", limit: 1, after: page.nextCursor! });
  assert.deepEqual([page.items[0]!.path, next.items[0]!.path], ["notes/a.txt", "notes/b.txt"]);
  assert.equal(next.nextCursor, null);
  await repo.delete(alice, id, first.path, second.version);
  const recreated = await repo.write(alice, id, { path: first.path, content: "recreated", expectedVersion: null });
  assert.notEqual(recreated.version, first.version);
  await assert.rejects(repo.delete(alice, id, first.path, second.version), /VERSION_CONFLICT/);
  const workspace = await repo.get(alice, id);
  assert.equal(workspace.fileCount, 3);
  assert.equal(workspace.usedBytes, 11);
});

test("Workspace: 上传失败不发布元数据，回收可重试且释放预留额度", async t => {
  const { pg, db } = await serviceDatabase("workspace"); t.after(() => pg.close());
  const store = new MemoryBlobs(), repo = new WorkspaceRepository(db, store);
  const { id } = await repo.ensure(alice);
  const original = await repo.write(alice, id, { path: "a.txt", content: "original", expectedVersion: null });
  store.failPut = true;
  await assert.rejects(repo.write(alice, id, { path: "a.txt", content: "replacement", expectedVersion: original.version }), /DEPENDENCY_UNAVAILABLE/);
  assert.equal((await repo.read(alice, id, "a.txt")).content, "original");
  await db.query("UPDATE workspace.blobs SET created_at=now()-interval '2 hours' WHERE state='staged'");
  store.failDelete = true;
  await assert.rejects(repo.collectOne(), /offline/);
  assert.equal((await db.query("SELECT * FROM workspace.blobs WHERE state='staged'")).rows.length, 1);
  store.failDelete = false;
  assert.equal(await repo.collectOne(), true);
  assert.equal(Number((await db.query("SELECT reserved_bytes FROM workspace.workspaces WHERE id=$1", [id])).rows[0]!.reserved_bytes), 0);
  assert.equal(await repo.collectOne(), false);
  await repo.delete(alice, id, "a.txt", original.version);
  assert.equal(store.objects.size, 1, "删除只解除当前引用，保留短暂回收窗口");
  await db.query("UPDATE workspace.blobs SET retired_at=now()-interval '2 hours' WHERE state='retired'");
  assert.equal(await repo.collectOne(), true);
  assert.equal(store.objects.size, 0);
});

test("Workspace: 字节和文件数配额、并发修改只提交一个版本", async t => {
  const { pg, db } = await serviceDatabase("workspace"); t.after(() => pg.close());
  const store = new MemoryBlobs();
  const repo = new WorkspaceRepository(db, store, { fileBytes: 10, workspaceBytes: 10, files: 1, stagingBytes: 20 });
  const { id } = await repo.ensure(alice);
  await assert.rejects(repo.write(alice, id, { path: "large", content: "中".repeat(4), expectedVersion: null }), /INVALID_REQUEST/);
  const file = await repo.write(alice, id, { path: "one", content: "12345", expectedVersion: null });
  await assert.rejects(repo.write(alice, id, { path: "two", content: "2", expectedVersion: null }), /QUOTA_EXCEEDED/);
  const results = await Promise.allSettled(["a", "b"].map(content => repo.write(alice, id,
    { path: "one", content, expectedVersion: file.version })));
  assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
  assert.equal((await repo.get(alice, id)).usedBytes, 1);
  assert.equal((await db.query("SELECT * FROM workspace.blobs WHERE state='live'")).rows.length, 1);
});

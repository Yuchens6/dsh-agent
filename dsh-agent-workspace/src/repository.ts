import { v7 as uuid } from "uuid";
import { WorkspacePath, WriteTextFile, type Principal, type Workspace, type FileMetadata } from "@dsh-agent/contracts";
import type { Database, Sql } from "./database.js";
import type { BlobStore } from "./storage.js";
import { WorkspaceError } from "./errors.js";
import { enqueueAudit, publishAuditBatch } from "./audit.js";
import type { WorkspaceAuditRecord } from "@dsh-agent/contracts";
const iso = (v: unknown) => new Date(v as string).toISOString();
const metadata = (r: Record<string, unknown>): FileMetadata => ({
  path: String(r.path), version: String(r.blob_id), sizeBytes: Number(r.size_bytes), updatedAt: iso(r.updated_at),
});
const view = (r: Record<string, unknown>): Workspace => ({
  id: String(r.id), directoryName: String(r.owner_uid), usedBytes: Number(r.used_bytes),
  fileCount: Number(r.file_count), createdAt: iso(r.created_at),
});
function path(input: string) {
  const parsed = WorkspacePath.parse(input);
  if (!parsed.isWellFormed() || parsed !== parsed.normalize("NFC")) throw new WorkspaceError(400, "INVALID_REQUEST");
  return parsed;
}
export class WorkspaceRepository {
  constructor(private db: Database, private blobs: BlobStore,
    private limits = { fileBytes: 65_536, workspaceBytes: 16 * 1024 * 1024, files: 1024, stagingBytes: 1024 * 1024 }) {}
  private async own(tx: Sql, actor: Principal, id: string, lock = false) {
    const result = await tx.query("SELECT * FROM workspace.workspaces WHERE id=$1 AND tenant_id=$2 AND owner_uid=$3" +
      (lock ? " FOR UPDATE" : ""), [id, actor.tenantId, actor.uid]);
    if (!result.rows[0]) throw new WorkspaceError(404, "NOT_FOUND");
    return result.rows[0];
  }
  async ensure(actor: Principal) {
    return this.db.transaction(async tx => {
      const inserted = await tx.query("INSERT INTO workspace.workspaces(id,tenant_id,owner_uid) VALUES($1,$2,$3) " +
        "ON CONFLICT(tenant_id,owner_uid) DO NOTHING RETURNING id", [uuid(), actor.tenantId, actor.uid]);
      const result = await tx.query("SELECT * FROM workspace.workspaces WHERE tenant_id=$1 AND owner_uid=$2", [actor.tenantId, actor.uid]);
      if (inserted.rows[0]) await this.audit(tx, actor, String(inserted.rows[0].id), "workspace.created");
      return view(result.rows[0]!);
    });
  }
  async get(actor: Principal, id: string) { return view(await this.own(this.db, actor, id)); }
  async list(actor: Principal, id: string, query: { prefix?: string; after?: string; limit: number }, authorize?: () => Promise<void>) {
    await this.own(this.db, actor, id);
    const prefix = query.prefix ? path(query.prefix) + "/" : "";
    const after = query.after ? path(query.after) : null;
    const result = await this.db.query("SELECT * FROM workspace.files WHERE workspace_id=$1 " +
      "AND left(path,length($2))=$2 AND ($3::text IS NULL OR path > $3 COLLATE \"C\") ORDER BY path LIMIT $4",
      [id, prefix, after, query.limit + 1]);
    await authorize?.();
    return { items: result.rows.slice(0, query.limit).map(metadata),
      nextCursor: result.rows.length > query.limit ? String(result.rows[query.limit - 1]!.path) : null };
  }
  async read(actor: Principal, id: string, input: string, authorize?: () => Promise<void>) {
    const filename = path(input);
    // 与覆盖/删除/垃圾回收使用同一工作区锁，读对象时不会被并发清理。
    return this.db.transaction(async tx => {
      await this.own(tx, actor, id, true);
      const result = await tx.query("SELECT f.*, b.object_key FROM workspace.files f JOIN workspace.blobs b " +
        "ON b.id=f.blob_id WHERE f.workspace_id=$1 AND f.path=$2", [id, filename]);
      const row = result.rows[0];
      if (!row) throw new WorkspaceError(404, "NOT_FOUND");
      await authorize?.();
      let bytes: Uint8Array;
      try { bytes = await this.blobs.get(String(row.object_key), Number(row.size_bytes)); }
      catch { throw new WorkspaceError(503, "DEPENDENCY_UNAVAILABLE"); }
      if (bytes.byteLength !== Number(row.size_bytes) || bytes.byteLength > this.limits.fileBytes) {
        throw new WorkspaceError(503, "DEPENDENCY_UNAVAILABLE");
      }
      await authorize?.();
      try { return { ...metadata(row), content: new TextDecoder("utf-8", { fatal: true }).decode(bytes) }; }
      catch { throw new WorkspaceError(503, "DEPENDENCY_UNAVAILABLE"); }
    });
  }
  private async checkWrite(tx: Sql, workspace: Record<string, unknown>, filename: string, expected: string | null, size: number) {
    const id = String(workspace.id);
    const found = await tx.query("SELECT * FROM workspace.files WHERE workspace_id=$1 AND path=$2", [id, filename]);
    const old = found.rows[0];
    if ((old ? String(old.blob_id) : null) !== expected) throw new WorkspaceError(409, "VERSION_CONFLICT");
    // 文件与目录不得重名；目录只是路径前缀，没有符号链接和实体宿主目录。
    const collision = await tx.query("SELECT 1 FROM workspace.files WHERE workspace_id=$1 AND path<>$2 AND " +
      "(left(path,length($2)+1)=$2||'/' OR left($2,length(path)+1)=path||'/') LIMIT 1", [id, filename]);
    if (collision.rows.length) throw new WorkspaceError(409, "VERSION_CONFLICT");
    if (Number(workspace.used_bytes) - Number(old?.size_bytes ?? 0) + size > this.limits.workspaceBytes ||
      Number(workspace.file_count) + (old ? 0 : 1) > this.limits.files) throw new WorkspaceError(429, "QUOTA_EXCEEDED");
    return old;
  }
  async write(actor: Principal, id: string, input: unknown, authorize?: () => Promise<void>) {
    const data = WriteTextFile.parse(input);
    const filename = path(data.path);
    if (!data.content.isWellFormed() || data.content.includes("\0")) throw new WorkspaceError(400, "INVALID_REQUEST");
    const bytes = Buffer.from(data.content, "utf8");
    if (bytes.length > this.limits.fileBytes) throw new WorkspaceError(400, "INVALID_REQUEST");
    const version = uuid(), objectKey = id + "/" + version;
    // 持久化上传票据并预留额度。即使进程在对象上传后崩溃，垃圾回收仍可找到对象。
    await this.db.transaction(async tx => {
      const workspace = await this.own(tx, actor, id, true);
      await this.checkWrite(tx, workspace, filename, data.expectedVersion, bytes.length);
      const pending = await tx.query("SELECT count(*)::integer AS count FROM workspace.blobs WHERE workspace_id=$1 AND state='staged'", [id]);
      if (Number(pending.rows[0]!.count) >= 16) throw new WorkspaceError(429, "QUOTA_EXCEEDED");
      if (Number(workspace.reserved_bytes) + Math.max(1, bytes.length) > this.limits.stagingBytes) {
        throw new WorkspaceError(429, "QUOTA_EXCEEDED");
      }
      await authorize?.();
      await tx.query("INSERT INTO workspace.blobs(id,workspace_id,object_key,size_bytes,state) VALUES($1,$2,$3,$4,'staged')",
        [version, id, objectKey, bytes.length]);
      await tx.query("UPDATE workspace.workspaces SET reserved_bytes=reserved_bytes+$2 WHERE id=$1", [id, Math.max(1, bytes.length)]);
    });
    try { await this.blobs.put(objectKey, bytes); }
    catch { throw new WorkspaceError(503, "DEPENDENCY_UNAVAILABLE"); }
    return this.db.transaction(async tx => {
      const workspace = await this.own(tx, actor, id, true);
      const staged = await tx.query("SELECT id FROM workspace.blobs WHERE id=$1 AND state='staged' " +
        "AND created_at > now()-interval '1 hour' FOR UPDATE", [version]);
      if (!staged.rows.length) throw new WorkspaceError(409, "VERSION_CONFLICT");
      const old = await this.checkWrite(tx, workspace, filename, data.expectedVersion, bytes.length);
      // 在不可变对象上传后、可见文件版本提交前再次授权；失败保留 staged 票据供回收。
      // 授权与本地提交不构成跨服务原子事务；即使随后发生取消，已获最终授权的在途提交仍可能完成。
      await authorize?.();
      await tx.query("UPDATE workspace.blobs SET state='live' WHERE id=$1", [version]);
      if (old) await tx.query("UPDATE workspace.blobs SET state='retired',retired_at=now() WHERE id=$1", [old.blob_id]);
      const result = await tx.query("INSERT INTO workspace.files(workspace_id,path,blob_id,size_bytes) VALUES($1,$2,$3,$4) " +
        "ON CONFLICT(workspace_id,path) DO UPDATE SET blob_id=$3,size_bytes=$4,updated_at=now() RETURNING *",
        [id, filename, version, bytes.length]);
      await tx.query("UPDATE workspace.workspaces SET used_bytes=used_bytes+$2,file_count=file_count+$3," +
        "reserved_bytes=reserved_bytes-$4 WHERE id=$1",
        [id, bytes.length - Number(old?.size_bytes ?? 0), old ? 0 : 1, Math.max(1, bytes.length)]);
      await this.audit(tx, actor, id, "file.written", { version, sizeBytes: bytes.length, ...(old ? { previousVersion: String(old.blob_id) } : {}) });
      return metadata(result.rows[0]!);
    });
  }
  async delete(actor: Principal, id: string, input: string, expectedVersion: string) {
    const filename = path(input);
    await this.db.transaction(async tx => {
      await this.own(tx, actor, id, true);
      const result = await tx.query("SELECT * FROM workspace.files WHERE workspace_id=$1 AND path=$2", [id, filename]);
      const row = result.rows[0];
      if (!row) throw new WorkspaceError(404, "NOT_FOUND");
      if (String(row.blob_id) !== expectedVersion) throw new WorkspaceError(409, "VERSION_CONFLICT");
      await tx.query("DELETE FROM workspace.files WHERE workspace_id=$1 AND path=$2", [id, filename]);
      await tx.query("UPDATE workspace.blobs SET state='retired',retired_at=now() WHERE id=$1", [row.blob_id]);
      await tx.query("UPDATE workspace.workspaces SET used_bytes=used_bytes-$2,file_count=file_count-1 WHERE id=$1", [id, row.size_bytes]);
      await this.audit(tx, actor, id, "file.deleted", { version: String(row.blob_id), sizeBytes: Number(row.size_bytes) });
    });
    return { deleted: true as const };
  }
  async collectOne() {
    return this.db.transaction(async tx => {
      // 所有路径采用 workspace → blob 的锁顺序；避免与提交和读取死锁。
      const chosen = await tx.query("SELECT w.id FROM workspace.workspaces w WHERE EXISTS " +
        "(SELECT 1 FROM workspace.blobs b WHERE b.workspace_id=w.id AND " +
        "((b.state='staged' AND b.created_at < now()-interval '1 hour') OR " +
        "(b.state='retired' AND b.retired_at < now()-interval '1 hour'))) FOR UPDATE OF w SKIP LOCKED LIMIT 1");
      if (!chosen.rows[0]) return false;
      const found = await tx.query("SELECT * FROM workspace.blobs WHERE workspace_id=$1 AND " +
        "((state='staged' AND created_at < now()-interval '1 hour') OR " +
        "(state='retired' AND retired_at < now()-interval '1 hour')) ORDER BY created_at FOR UPDATE LIMIT 1", [chosen.rows[0].id]);
      const blob = found.rows[0]!;
      await this.blobs.delete(String(blob.object_key));
      await tx.query("DELETE FROM workspace.blobs WHERE id=$1", [blob.id]);
      if (blob.state === "staged") await tx.query("UPDATE workspace.workspaces SET reserved_bytes=reserved_bytes-$2 WHERE id=$1",
        [blob.workspace_id, Math.max(1, Number(blob.size_bytes))]);
      return true;
    });
  }
  private async audit(tx: Sql, actor: Principal, workspaceId: string, action: WorkspaceAuditRecord["action"], extra: Partial<Pick<WorkspaceAuditRecord, "version" | "previousVersion" | "sizeBytes">> = {}) {
    await enqueueAudit(tx, { eventId: uuid(), occurredAt: new Date().toISOString(), producer: "dsh-agent-workspace",
      tenantId: actor.tenantId, ownerUid: actor.uid, workspaceId, action, ...extra });
  }
  publishAuditBatch(deliver: (record: WorkspaceAuditRecord) => Promise<void>) { return publishAuditBatch(this.db, deliver); }
  async metrics(): Promise<Record<string, number>> {
    const row = (await this.db.query("SELECT " +
      "(SELECT count(*) FROM workspace.audit_outbox WHERE delivered_at IS NULL) AS audit_pending," +
      "(SELECT COALESCE(GREATEST(EXTRACT(EPOCH FROM clock_timestamp()-min(created_at)),0),0) FROM workspace.audit_outbox WHERE delivered_at IS NULL) AS audit_oldest_age_seconds," +
      "(SELECT COALESCE(max(attempts),0) FROM workspace.audit_outbox WHERE delivered_at IS NULL) AS audit_max_attempts," +
      "(SELECT count(*) FROM workspace.blobs WHERE state='staged') AS blobs_staged," +
      "(SELECT count(*) FROM workspace.blobs WHERE (state='staged' AND created_at<clock_timestamp()-interval '1 hour') OR (state='retired' AND retired_at<clock_timestamp()-interval '1 hour')) AS blobs_gc_pending")).rows[0]!;
    return Object.fromEntries(Object.entries(row).map(([key,value]) => [key, Number(value)]));
  }
}

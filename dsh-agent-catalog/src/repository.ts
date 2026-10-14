import { createHash } from "node:crypto";
import { AgentDefinition, DefinitionSummary, IdentityId, type Principal, type ErrorCode } from "@dsh-agent/contracts";
import type { Database, Sql } from "./database.js";
export class CatalogError extends Error {
  constructor(public status: number, public code: ErrorCode) { super(code); }
}
export class CatalogRepository {
  constructor(private db: Database) {}
  async revoke(tenantId: string, id: string, version: number) {
    IdentityId.parse(tenantId); IdentityId.parse(id);
    if (!Number.isSafeInteger(version) || version < 1) throw new CatalogError(400, "INVALID_REQUEST");
    await this.db.transaction(async tx => {
      await tx.query("SELECT pg_advisory_xact_lock(hashtext($1))", [tenantId]);
      // 仅撤销指定租户授权，保留不可变定义；不会撤回其他租户或正在运行的冻结输入。
      await tx.query("DELETE FROM catalog.tenant_definitions WHERE tenant_id=$1 AND definition_id=$2 AND definition_version=$3", [tenantId, id, version]);
    });
    return { revoked: true as const };
  }
  async list(actor: Principal) {
    const result = await this.db.query("SELECT d.document,g.is_default FROM catalog.definitions d " +
      "JOIN catalog.tenant_definitions g ON g.definition_id=d.id AND g.definition_version=d.version " +
      "WHERE g.tenant_id=$1 ORDER BY d.id,d.version LIMIT 101", [actor.tenantId]);
    if (result.rows.length > 100) throw new CatalogError(503, "DEPENDENCY_UNAVAILABLE");
    return { items: result.rows.map(r => {
      const d = AgentDefinition.parse(r.document);
      return DefinitionSummary.parse({ id: d.id, version: d.version, name: d.name,
        description: d.description, tools: d.tools, isDefault: r.is_default, kind: d.workflow ? "workflow" : "agent" });
    }) };
  }
  async getDefault(actor: Principal) {
    const result = await this.db.query("SELECT d.document FROM catalog.definitions d JOIN catalog.tenant_definitions g " +
      "ON g.definition_id=d.id AND g.definition_version=d.version WHERE g.tenant_id=$1 AND g.is_default", [actor.tenantId]);
    if (!result.rows[0]) throw new CatalogError(404, "NOT_FOUND");
    return AgentDefinition.parse(result.rows[0].document);
  }
  async get(actor: Principal, id: string, version: number) {
    const result = await this.db.query("SELECT d.document FROM catalog.definitions d JOIN catalog.tenant_definitions g " +
      "ON g.definition_id=d.id AND g.definition_version=d.version WHERE g.tenant_id=$1 AND d.id=$2 AND d.version=$3",
      [actor.tenantId, id, version]);
    if (!result.rows[0]) throw new CatalogError(404, "NOT_FOUND");
    return AgentDefinition.parse(result.rows[0].document);
  }
  // Full definitions remain operator-only. Studio uses a separate constrained publishing path.
  async publish(input: unknown, tenantId: string, makeDefault: boolean) {
    const definition = AgentDefinition.parse(input);
    IdentityId.parse(tenantId);
    if (new Set(definition.tools).size !== definition.tools.length ||
      new Set(definition.skills.map(s => s.id)).size !== definition.skills.length) throw new CatalogError(400, "INVALID_REQUEST");
    await this.db.transaction(async tx => {
      await tx.query("SELECT pg_advisory_xact_lock(hashtext($1))", [tenantId]);
      await this.persist(tx, definition, tenantId, makeDefault);
    });
    return definition;
  }
  // Caller must hold the tenant advisory lock. Published versions are always immutable.
  async persist(tx: Sql, definition: AgentDefinition, tenantId: string, makeDefault: boolean) {
    const serialized = JSON.stringify(AgentDefinition.parse(definition));
    const hash = createHash("sha256").update(serialized).digest("hex");
      await tx.query("INSERT INTO catalog.definitions(id,version,document,document_hash) VALUES($1,$2,$3,$4) " +
        "ON CONFLICT(id,version) DO NOTHING", [definition.id, definition.version, serialized, hash]);
      const existing = await tx.query("SELECT document_hash FROM catalog.definitions WHERE id=$1 AND version=$2",
        [definition.id, definition.version]);
      if (existing.rows[0]!.document_hash !== hash) throw new CatalogError(409, "VERSION_CONFLICT");
      const count = await tx.query("SELECT count(*)::integer AS count FROM catalog.tenant_definitions WHERE tenant_id=$1 " +
        "AND NOT (definition_id=$2 AND definition_version=$3)", [tenantId, definition.id, definition.version]);
      if (Number(count.rows[0]!.count) >= 100) throw new CatalogError(429, "QUOTA_EXCEEDED");
      if (makeDefault) await tx.query("UPDATE catalog.tenant_definitions SET is_default=false WHERE tenant_id=$1 AND is_default", [tenantId]);
      await tx.query("INSERT INTO catalog.tenant_definitions(tenant_id,definition_id,definition_version,is_default) " +
        "VALUES($1,$2,$3,$4) ON CONFLICT(tenant_id,definition_id,definition_version) " +
        "DO UPDATE SET is_default=catalog.tenant_definitions.is_default OR EXCLUDED.is_default",
        [tenantId, definition.id, definition.version, makeDefault]);
  }
}

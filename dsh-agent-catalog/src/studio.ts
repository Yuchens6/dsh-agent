import { createHash } from "node:crypto";
import { AgentDefinition, StudioPublish, StudioState, type Principal } from "@dsh-agent/contracts";
import type { Database } from "./database.js";
import { CatalogRepository, CatalogError } from "./repository.js";

export const isStudioAdmin = (actor: Principal) => actor.roles.includes("tenant-admin");
export class StudioRepository {
  constructor(private db: Database) {}
  async state(actor: Principal) {
    const { rows } = await this.db.query("SELECT * FROM catalog.studio_agents WHERE tenant_id=$1 ORDER BY updated_at DESC LIMIT 100", [actor.tenantId]);
    return StudioState.parse({ enabled: true, canPublish: isStudioAdmin(actor), items: rows.map(row => ({
      id: row.id, slug: row.slug, version: row.version, base: { id: row.base_id, version: row.base_version },
      updatedBy: row.updated_by, updatedAt: new Date(row.updated_at as string).toISOString(),
    })) });
  }
  async publish(actor: Principal, input: unknown) {
    if (!isStudioAdmin(actor)) throw new CatalogError(403, "FORBIDDEN");
    const data = StudioPublish.parse(input);
    const id = "tenant-" + createHash("sha256").update(actor.tenantId).digest("hex").slice(0, 32) + "-" + data.slug;
    return this.db.transaction(async tx => {
      // Serialize with operator grants/revocations and other publications for this tenant.
      await tx.query("SELECT pg_advisory_xact_lock(hashtext($1))", [actor.tenantId]);
      const baseResult = await tx.query("SELECT d.document FROM catalog.definitions d JOIN catalog.tenant_definitions g " +
        "ON g.definition_id=d.id AND g.definition_version=d.version WHERE g.tenant_id=$1 AND d.id=$2 AND d.version=$3 " +
        "AND NOT EXISTS (SELECT 1 FROM catalog.studio_agents s WHERE s.id=d.id)", [actor.tenantId, data.base.id, data.base.version]);
      if (!baseResult.rows[0]) throw new CatalogError(404, "NOT_FOUND");
      const base = AgentDefinition.parse(baseResult.rows[0].document);
      if (data.tools.some(tool => !base.tools.includes(tool)) || new Set(data.tools).size !== data.tools.length)
        throw new CatalogError(403, "FORBIDDEN");
      const candidate = AgentDefinition.parse({ id, version: data.expectedVersion + 1,
        name: data.name, description: data.description, systemPrompt: data.systemPrompt,
        model: base.model, execution: base.execution, tools: data.tools, skills: data.skills,
        ...(data.tools.includes("knowledge.search") ? { knowledgeSources: base.knowledgeSources } : {}),
        ...(data.workflow ? { workflow: data.workflow } : {}),
      });
      const current = (await tx.query("SELECT * FROM catalog.studio_agents WHERE id=$1", [id])).rows[0];
      if (current && (current.tenant_id !== actor.tenantId || current.base_id !== data.base.id || current.base_version !== data.base.version))
        throw new CatalogError(409, "VERSION_CONFLICT");
      const revision = current ? Number(current.version) : 0;
      const catalog = new CatalogRepository(this.db);
      if (revision === candidate.version) {
        const prior = (await tx.query("SELECT document_hash FROM catalog.definitions WHERE id=$1 AND version=$2", [id, revision])).rows[0];
        const hash = createHash("sha256").update(JSON.stringify(candidate)).digest("hex");
        if (prior?.document_hash === hash) return candidate; // Exact lost-response replay, without regranting revoked access.
      }
      if (revision !== data.expectedVersion) throw new CatalogError(409, "VERSION_CONFLICT");
      await catalog.persist(tx, candidate, actor.tenantId, false);
      await tx.query("INSERT INTO catalog.studio_agents(id,tenant_id,slug,version,base_id,base_version,updated_by) VALUES($1,$2,$3,$4,$5,$6,$7) " +
        "ON CONFLICT(id) DO UPDATE SET version=EXCLUDED.version,updated_by=EXCLUDED.updated_by,updated_at=now()",
        [id, actor.tenantId, data.slug, candidate.version, data.base.id, data.base.version, actor.uid]);
      return candidate;
    });
  }
}

import { AuditRecord, type Principal, type ErrorCode } from "@dsh-agent/contracts";
import type { Database } from "./database.js";
export class ServiceError extends Error { constructor(public status: number, public code: ErrorCode) { super(code); } }
export class AuditRepository {
 constructor(private db: Database) {}
 async append(value: unknown) {
  const record = AuditRecord.parse(value);
  await this.db.transaction(async tx => {
   await tx.query("INSERT INTO audit.records(event_id,tenant_id,owner_uid,run_id,envelope) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING",
    [record.eventId, record.tenantId, record.ownerUid, "runId" in record ? record.runId ?? null : null, JSON.stringify(record)]);
   const row = (await tx.query("SELECT envelope=$2::jsonb AS same FROM audit.records WHERE event_id=$1", [record.eventId, JSON.stringify(record)])).rows[0]!;
   if (!row.same) throw new ServiceError(409, "IDEMPOTENCY_CONFLICT");
  });
  return { recorded: true as const };
 }
 async list(actor: Principal, query: { limit: number; after?: string }) {
  const rows = (await this.db.query("SELECT envelope FROM audit.records WHERE tenant_id=$1 AND owner_uid=$2 AND ($3::uuid IS NULL OR event_id<$3) ORDER BY event_id DESC LIMIT $4",
   [actor.tenantId, actor.uid, query.after ?? null, query.limit + 1])).rows;
  const items = rows.slice(0, query.limit).map(row => AuditRecord.parse(row.envelope));
  return { items, nextCursor: rows.length > query.limit ? items.at(-1)!.eventId : null };
 }
}

import { SignJWT } from "jose";
import { z } from "zod";
import { WorkspaceAuditRecord } from "@dsh-agent/contracts";
import type { Database, Sql } from "./database.js";
export async function enqueueAudit(tx: Sql, value: WorkspaceAuditRecord) {
 const record = WorkspaceAuditRecord.parse(value);
 await tx.query("INSERT INTO workspace.audit_outbox(event_id,envelope) VALUES($1,$2)", [record.eventId, JSON.stringify(record)]);
}
export async function publishAuditBatch(db: Database, deliver: (record: WorkspaceAuditRecord) => Promise<void>) {
 return db.transaction(async tx => {
  // 只锁单个发件箱票据，不在网络投递时持有会话或工作区锁。
  const row = (await tx.query("SELECT * FROM workspace.audit_outbox WHERE delivered_at IS NULL AND next_attempt_at<=clock_timestamp() ORDER BY next_attempt_at,event_id FOR UPDATE SKIP LOCKED LIMIT 1")).rows[0];
  if (!row) return "idle" as const;
  try { await deliver(WorkspaceAuditRecord.parse(row.envelope)); }
  catch {
   await tx.query("UPDATE workspace.audit_outbox SET attempts=attempts+1,next_attempt_at=clock_timestamp()+($2::integer*interval '1 second') WHERE event_id=$1",
    [row.event_id, Math.min(60, 2 ** Math.min(Number(row.attempts), 6))]);
   return "retry" as const;
  }
  await tx.query("UPDATE workspace.audit_outbox SET attempts=attempts+1,delivered_at=clock_timestamp() WHERE event_id=$1", [row.event_id]);
  return "delivered" as const;
 });
}
export function auditClient(baseUrl: string, secret: string) {
 const url = new URL(baseUrl), key = new TextEncoder().encode(secret);
 if (!["http:", "https:"].includes(url.protocol) || url.pathname !== "/" || url.username || url.password || url.hash || url.search || key.length < 32) throw new Error("Audit origin and strong service key required");
 return async (value: WorkspaceAuditRecord) => {
  const record = WorkspaceAuditRecord.parse(value);
  const token = await new SignJWT({}).setProtectedHeader({ alg: "HS256", typ: "JWT" })
   .setIssuer("dsh-agent-workspace").setAudience("dsh-agent-audit").setIssuedAt().setExpirationTime("30s").sign(key);
  const response = await fetch(new URL("/control/v1/records", url), { method: "POST", redirect: "error", signal: AbortSignal.timeout(2000),
   headers: { authorization: "Bearer " + token, "content-type": "application/json" }, body: JSON.stringify(record) });
  if (!response.ok) { await response.body?.cancel(); throw new Error("Audit delivery rejected"); }
  const reader = response.body?.getReader(); if (!reader) throw new Error("Missing response");
  const parts: Uint8Array[] = []; let length = 0;
  try { while (true) { const part = await reader.read(); if (part.done) break;
   length += part.value.byteLength; if (length > 4096) throw new Error("Oversized acknowledgement"); parts.push(part.value);
  } } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
  z.object({ recorded: z.literal(true) }).strict().parse(JSON.parse(Buffer.concat(parts).toString("utf8")));
 };
}


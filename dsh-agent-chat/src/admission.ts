import type { Principal } from "@dsh-agent/contracts";
import type { Sql } from "./database.js";
export const defaultAdmission = { messagesPerMinute: 120, pendingPerUser: 1000, pendingPerSession: 100 };
export type AdmissionPolicy = typeof defaultAdmission;
export class AdmissionError extends Error {
  readonly statusCode = 429;
  constructor(readonly retryAfter: number) { super("QUOTA_EXCEEDED"); }
}
export function validateAdmission(policy: AdmissionPolicy) {
  if (!Object.values(policy).every(v => Number.isSafeInteger(v) && v > 0 && v <= 1_000_000)) throw new Error("Invalid message admission policy");
}
export async function admitMessage(tx: Sql, actor: Principal, sessionId: string, policy: AdmissionPolicy) {
  // 由已认证主体生成键；用户行在新消息事务内更新，各副本共享，失败回滚不消耗次数。
  const permit = await tx.query("INSERT INTO chat.message_admission(tenant_id,owner_uid,window_start,used) " +
    "VALUES($1,$2,clock_timestamp(),1) ON CONFLICT(tenant_id,owner_uid) DO UPDATE SET " +
    "window_start=CASE WHEN chat.message_admission.window_start<=clock_timestamp()-interval '60 seconds' THEN clock_timestamp() ELSE chat.message_admission.window_start END," +
    "used=CASE WHEN chat.message_admission.window_start<=clock_timestamp()-interval '60 seconds' THEN 1 ELSE chat.message_admission.used+1 END " +
    "WHERE chat.message_admission.window_start<=clock_timestamp()-interval '60 seconds' OR chat.message_admission.used<$3 RETURNING used",
    [actor.tenantId,actor.uid,policy.messagesPerMinute]);
  if (!permit.rows.length) throw new AdmissionError(60);
  // 仅限制本服务尚未投递到消息代理的运行请求，不把它误称为全链路队列长度。
  const pending = (await tx.query("SELECT count(*) AS total,count(*) FILTER(WHERE session_id=$3) AS session FROM " +
    "(SELECT session_id FROM chat.conversation_outbox WHERE published_at IS NULL AND subject='agent.commands.run.requested.v1' " +
    "AND envelope->>'tenantId'=$1 AND envelope->>'ownerUid'=$2 LIMIT $4) pending",
    [actor.tenantId,actor.uid,sessionId,policy.pendingPerUser])).rows[0]!;
  if (Number(pending.total)>=policy.pendingPerUser || Number(pending.session)>=policy.pendingPerSession) throw new AdmissionError(5);
}

import { QuotaReserve, QuotaClose, ModelUsageEvent, ModelUsageSummary, type Principal, type QuotaUsage } from "@dsh-agent/contracts";
import type { Database } from "./database.js";
import { reservePoints, settlePoints } from "./points.js";
import { ServiceError } from "./errors.js";
export { ServiceError } from "./errors.js";
export const defaultPolicy = { userActive: 2, tenantActive: 32, userDailyOutputTokens: 1_000_000, tenantDailyOutputTokens: 100_000_000 };
export class QuotaRepository {
 constructor(private db: Database, readonly policy = defaultPolicy, private billingEnabled = false) {
  if (!Object.values(policy).every(v => Number.isSafeInteger(v) && v > 0)) throw new Error("Invalid quota policy");
 }
 async reserve(value: unknown) {
  const data = QuotaReserve.parse(value), { actor, runId, outputTokenBudget: budget } = data;
  return this.db.transaction(async tx => {
   // 所有租户内决策共用行锁；不依赖单实例内存计数，不跨服务查询。
   await tx.query("INSERT INTO quota.tenants VALUES($1) ON CONFLICT DO NOTHING", [actor.tenantId]);
   await tx.query("SELECT tenant_id FROM quota.tenants WHERE tenant_id=$1 FOR UPDATE", [actor.tenantId]);
   const previous = (await tx.query("SELECT *,deadline_at>clock_timestamp() AS valid FROM quota.reservations WHERE run_id=$1", [runId])).rows[0];
   if (previous) {
    if (previous.tenant_id !== actor.tenantId || previous.owner_uid !== actor.uid) throw new ServiceError(409, "IDEMPOTENCY_CONFLICT");
    if (previous.closed || !previous.valid) throw new ServiceError(409, "INVALID_STATE");
    if (Number(previous.budget) !== budget || new Date(previous.deadline_at as string).toISOString() !== data.deadlineAt) throw new ServiceError(409, "IDEMPOTENCY_CONFLICT");
    const priced = (await tx.query("SELECT price FROM quota.points_runs WHERE run_id=$1", [runId])).rows[0];
    if (priced && (priced.price as {model:string;provider:string}).model !== data.billingModel?.name) throw new ServiceError(409,"IDEMPOTENCY_CONFLICT");
    return { reserved: true as const };
   }
   const valid = (await tx.query("SELECT $1::timestamptz>clock_timestamp() AND $1::timestamptz<=clock_timestamp()+interval '3700 seconds' AS valid", [data.deadlineAt])).rows[0]!.valid;
   if (!valid) throw new ServiceError(409, "INVALID_STATE");
   const counts = (await tx.query("SELECT count(*) FILTER(WHERE NOT closed AND deadline_at>clock_timestamp())::integer AS active," +
    "count(*) FILTER(WHERE NOT closed AND deadline_at>clock_timestamp() AND owner_uid=$2)::integer AS user_active," +
    "COALESCE(sum(budget) FILTER(WHERE day=(clock_timestamp() AT TIME ZONE 'UTC')::date),0) AS daily," +
    "COALESCE(sum(budget) FILTER(WHERE day=(clock_timestamp() AT TIME ZONE 'UTC')::date AND owner_uid=$2),0) AS user_daily FROM quota.reservations WHERE tenant_id=$1",
    [actor.tenantId, actor.uid])).rows[0]!;
   if (Number(counts.active) >= this.policy.tenantActive || Number(counts.user_active) >= this.policy.userActive ||
    Number(counts.daily) + budget > this.policy.tenantDailyOutputTokens || Number(counts.user_daily) + budget > this.policy.userDailyOutputTokens) throw new ServiceError(429, "QUOTA_EXCEEDED");
   const inserted = await tx.query("INSERT INTO quota.reservations(run_id,tenant_id,owner_uid,budget,day,deadline_at) VALUES($1,$2,$3,$4,(clock_timestamp() AT TIME ZONE 'UTC')::date,$5) ON CONFLICT DO NOTHING RETURNING run_id",
    [runId, actor.tenantId, actor.uid, budget, data.deadlineAt]);
   if (!inserted.rows.length) throw new ServiceError(409, "IDEMPOTENCY_CONFLICT");
   if (this.billingEnabled) await reservePoints(tx,actor,runId,data.billingModel);
   return { reserved: true as const };
  });
 }
 async close(value: unknown) {
  const { runId, actor, expectedCalls } = QuotaClose.parse(value);
  return this.db.transaction(async tx => {
   await tx.query("INSERT INTO quota.tenants VALUES($1) ON CONFLICT DO NOTHING", [actor.tenantId]);
   await tx.query("SELECT tenant_id FROM quota.tenants WHERE tenant_id=$1 FOR UPDATE", [actor.tenantId]);
   // 先关闭后迟到预留时保留墓碑；关闭不退回保守预算，不能伪装成真实账单结算。
   await tx.query("INSERT INTO quota.reservations(run_id,tenant_id,owner_uid,budget,day,closed) VALUES($1,$2,$3,0,(clock_timestamp() AT TIME ZONE 'UTC')::date,true) ON CONFLICT DO NOTHING", [runId, actor.tenantId, actor.uid]);
   const updated = await tx.query("UPDATE quota.reservations SET closed=true WHERE run_id=$1 AND tenant_id=$2 AND owner_uid=$3 RETURNING run_id", [runId, actor.tenantId, actor.uid]);
   if (!updated.rows.length) throw new ServiceError(409, "IDEMPOTENCY_CONFLICT");
   await settlePoints(tx,runId,expectedCalls);
   return { closed: true as const };
  });
 }
 async usage(actor: Principal): Promise<QuotaUsage> {
  const row = (await this.db.query("SELECT count(*) FILTER(WHERE NOT closed AND deadline_at>clock_timestamp())::integer AS active," +
   "COALESCE(sum(budget) FILTER(WHERE day=(clock_timestamp() AT TIME ZONE 'UTC')::date),0) AS daily FROM quota.reservations WHERE tenant_id=$1 AND owner_uid=$2", [actor.tenantId, actor.uid])).rows[0]!;
  return { active: Number(row.active), reservedOutputTokensToday: Number(row.daily), activeLimit: this.policy.userActive, dailyOutputTokenLimit: this.policy.userDailyOutputTokens, accounting: "conservative-reservation" };
 }
 async recordModelUsage(value: unknown) {
  const event = ModelUsageEvent.parse(value), { actor, report } = event;
  return this.db.transaction(async tx => {
   const reservation = (await tx.query("SELECT * FROM quota.reservations WHERE run_id=$1 FOR UPDATE", [event.runId])).rows[0];
   if (!reservation || reservation.tenant_id !== actor.tenantId || reservation.owner_uid !== actor.uid || Number(reservation.budget) <= 0) throw new ServiceError(409, "INVALID_STATE");
   // 终态事件可先于开始事件投递；后到的开始不能覆盖已知用量。
   await tx.query("INSERT INTO quota.model_calls(run_id,attempt,call,tenant_id,owner_uid,provider,model,started_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING",
    [event.runId,event.attempt,report.call,actor.tenantId,actor.uid,event.provider,event.model,event.startedAt]);
   const prior = (await tx.query("SELECT *,tokens IS NOT DISTINCT FROM $4::jsonb AS same_tokens FROM quota.model_calls WHERE run_id=$1 AND attempt=$2 AND call=$3",
    [event.runId,event.attempt,report.call,report.phase === "finished" && report.tokens !== null ? JSON.stringify(report.tokens) : null])).rows[0]!;
   if (prior.tenant_id !== actor.tenantId || prior.owner_uid !== actor.uid || prior.provider !== event.provider || prior.model !== event.model || new Date(prior.started_at as string).toISOString() !== event.startedAt) throw new ServiceError(409,"IDEMPOTENCY_CONFLICT");
   if (report.phase === "finished") {
    if (prior.finished && !prior.same_tokens) throw new ServiceError(409,"IDEMPOTENCY_CONFLICT");
    await tx.query("UPDATE quota.model_calls SET finished=true,tokens=$4 WHERE run_id=$1 AND attempt=$2 AND call=$3",
     [event.runId,event.attempt,report.call,report.tokens === null ? null : JSON.stringify(report.tokens)]);
   }
   await settlePoints(tx,event.runId);
   return { recorded: true as const };
  });
 }
 async modelUsage(actor: Principal, day = new Date().toISOString().slice(0,10)) {
  const row = (await this.db.query("SELECT count(*) AS started, count(*) FILTER(WHERE tokens IS NOT NULL) AS reported," +
   "count(*) FILTER(WHERE finished AND tokens IS NULL) AS unknown, count(*) FILTER(WHERE NOT finished) AS pending," +
   "COALESCE(sum((tokens->>'inputTokens')::bigint),0)::text AS input, COALESCE(sum((tokens->>'outputTokens')::bigint),0)::text AS output," +
   "COALESCE(sum((tokens->>'cacheReadTokens')::bigint),0)::text AS cache, COALESCE(sum((tokens->>'reasoningTokens')::bigint),0)::text AS reasoning," +
   "count(*) FILTER(WHERE tokens ? 'cacheReadTokens') AS cache_reported, count(*) FILTER(WHERE tokens ? 'reasoningTokens') AS reasoning_reported " +
   "FROM quota.model_calls WHERE tenant_id=$1 AND owner_uid=$2 AND started_at >= ($3::date::timestamp AT TIME ZONE 'UTC') AND started_at < (($3::date+1)::timestamp AT TIME ZONE 'UTC')",
   [actor.tenantId,actor.uid,day])).rows[0]!;
  return ModelUsageSummary.parse({ day, accounting: "provider-reported", startedCalls: Number(row.started), reportedCalls: Number(row.reported),
   unknownCalls: Number(row.unknown), pendingCalls: Number(row.pending), inputTokens: row.input, outputTokens: row.output,
   cacheReadTokens: row.cache, reasoningTokens: row.reasoning, cacheReadReportedCalls: Number(row.cache_reported), reasoningReportedCalls: Number(row.reasoning_reported) });
 }
}

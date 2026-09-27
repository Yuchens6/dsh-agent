import { v7 as uuid } from "uuid";
import { z } from "zod";
import { PricingPolicy, FixedDecimal, IdentityId, ResourceId, ModelTokens, PointsBalance, PointsLedgerPage, type Principal } from "@dsh-agent/contracts";
import type { Database, Sql } from "./database.js";
import { ServiceError } from "./errors.js";
const scale = 1_000_000n;
export function micro(value: string): bigint {
  FixedDecimal.parse(value); const [whole, fraction = ""] = value.split(".");
  return BigInt(whole!) * scale + BigInt(fraction.padEnd(6,"0"));
}
export function decimal(value: unknown): string {
  const n = BigInt(String(value)), sign = n < 0n ? "-" : "", a = n < 0n ? -n : n;
  return sign + (a / scale) + "." + (a % scale).toString().padStart(6,"0");
}
const ceil = (a: bigint, b: bigint) => (a + b - 1n) / b;
export function priceTokens(policy: PricingPolicy, value: unknown) {
  const t = ModelTokens.parse(value);
  // DSH 缓存细分缺失时输入含缓存总量。单价不同则无法准确拆分，不能猜。
  if (t.cacheReadTokens === undefined && micro(policy.inputPerMillion) !== micro(policy.cacheReadPerMillion)) return null;
  const amount = ceil(BigInt(t.inputTokens)*micro(policy.inputPerMillion) + BigInt(t.cacheReadTokens ?? 0)*micro(policy.cacheReadPerMillion) + BigInt(t.outputTokens)*micro(policy.outputPerMillion), scale);
  return { amount, points: ceil(amount*micro(policy.pointsPerYuan),scale) };
}
async function account(tx: Sql, tenant: string, uid: string) {
  await tx.query("INSERT INTO quota.points_accounts(tenant_id,owner_uid) VALUES($1,$2) ON CONFLICT DO NOTHING",[tenant,uid]);
  return (await tx.query("SELECT * FROM quota.points_accounts WHERE tenant_id=$1 AND owner_uid=$2 FOR UPDATE",[tenant,uid])).rows[0]!;
}
export async function reservePoints(tx: Sql, actor: Principal, runId: string, model?: { provider: string; name: string }) {
  if (!model) throw new ServiceError(503,"DEPENDENCY_UNAVAILABLE");
  const found = (await tx.query("SELECT p.document FROM quota.points_active_prices a JOIN quota.points_prices p ON p.id=a.price_id WHERE a.provider=$1 AND a.model=$2",[model.provider,model.name])).rows[0];
  if (!found) throw new ServiceError(503,"DEPENDENCY_UNAVAILABLE");
  const policy = PricingPolicy.parse(found.document), hold = micro(policy.reservePointsPerRun);
  const wallet = await account(tx,actor.tenantId,actor.uid);
  const pending = (await tx.query("SELECT 1 FROM quota.points_runs r WHERE r.tenant_id=$1 AND r.owner_uid=$2 AND NOT r.released AND (r.expected_calls IS NOT NULL OR EXISTS(SELECT 1 FROM quota.points_charges c WHERE c.run_id=r.run_id AND c.status<>'settled')) LIMIT 1",[actor.tenantId,actor.uid])).rows.length;
  if (pending || BigInt(String(wallet.balance))-BigInt(String(wallet.held)) < hold) throw new ServiceError(429,"QUOTA_EXCEEDED");
  await tx.query("UPDATE quota.points_accounts SET held=held+$3 WHERE tenant_id=$1 AND owner_uid=$2",[actor.tenantId,actor.uid,hold.toString()]);
  await tx.query("INSERT INTO quota.points_runs(run_id,tenant_id,owner_uid,price,remaining_hold) VALUES($1,$2,$3,$4,$5)",[runId,actor.tenantId,actor.uid,JSON.stringify(policy),hold.toString()]);
}
export async function settlePoints(tx: Sql, runId: string, expectedCalls?: number) {
  const run = (await tx.query("SELECT * FROM quota.points_runs WHERE run_id=$1 FOR UPDATE",[runId])).rows[0];
  if (!run) return; // 升级前/未开启积分的运行不追溯收费。
  if (expectedCalls !== undefined) {
    if (run.expected_calls !== null && Number(run.expected_calls) !== expectedCalls) throw new ServiceError(409,"IDEMPOTENCY_CONFLICT");
    await tx.query("UPDATE quota.points_runs SET expected_calls=$2 WHERE run_id=$1",[runId,expectedCalls]); run.expected_calls = expectedCalls;
  }
  const policy = PricingPolicy.parse(run.price);
  const calls = (await tx.query("SELECT * FROM quota.model_calls WHERE run_id=$1 ORDER BY attempt,call",[runId])).rows;
  if (run.expected_calls !== null && calls.length > Number(run.expected_calls)) throw new ServiceError(409,"INVALID_STATE");
  const wallet = await account(tx,String(run.tenant_id),String(run.owner_uid));
  let balance = BigInt(String(wallet.balance)), held = BigInt(String(wallet.held)), remaining = BigInt(String(run.remaining_hold));
  let complete = run.expected_calls !== null && calls.length === Number(run.expected_calls);
  for (const call of calls) {
    if (call.provider !== policy.provider || call.model !== policy.model) throw new ServiceError(409,"INVALID_STATE");
    const previous = (await tx.query("SELECT status FROM quota.points_charges WHERE run_id=$1 AND attempt=$2 AND call=$3",[runId,call.attempt,call.call])).rows[0];
    if (previous?.status === "settled") continue;
    const cost = call.finished && call.tokens !== null ? priceTokens(policy,call.tokens) : null;
    // 未结束的调用只是暂存；只有终报缺失计量才成为待结算阻塞。
    if (!call.finished) { complete = false; continue; }
    const payable = cost !== null && balance - (held - remaining) >= cost.points;
    const status = !cost ? "pending_usage" : payable ? "settled" : "pending_balance";
    await tx.query("INSERT INTO quota.points_charges(run_id,attempt,call,status,amount,points) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(run_id,attempt,call) DO UPDATE SET status=EXCLUDED.status,amount=EXCLUDED.amount,points=EXCLUDED.points",
      [runId,call.attempt,call.call,status,cost?.amount.toString() ?? null,cost?.points.toString() ?? null]);
    if (!payable || !cost) { complete = false; continue; }
    const consumedHold = cost.points < remaining ? cost.points : remaining;
    remaining -= consumedHold; held -= consumedHold; balance -= cost.points;
    await tx.query("INSERT INTO quota.points_ledger(id,tenant_id,owner_uid,kind,delta,run_id,amount,price_id,attempt,call) VALUES($1,$2,$3,'charge',$4,$5,$6,$7,$8,$9)",
      [uuid(),run.tenant_id,run.owner_uid,(-cost.points).toString(),runId,cost.amount.toString(),policy.id,call.attempt,call.call]);
  }
  if (complete) { held -= remaining; remaining = 0n; }
  await tx.query("UPDATE quota.points_accounts SET balance=$3,held=$4 WHERE tenant_id=$1 AND owner_uid=$2",[run.tenant_id,run.owner_uid,balance.toString(),held.toString()]);
  await tx.query("UPDATE quota.points_runs SET remaining_hold=$2,released=$3 WHERE run_id=$1",[runId,remaining.toString(),complete]);
}
export const PointsCommand = z.discriminatedUnion("kind",[
  z.object({ kind:z.literal("price"),policy:PricingPolicy }).strict(),
  z.object({ kind:z.literal("grant"),id:ResourceId,tenantId:IdentityId,points:FixedDecimal,operator:IdentityId,reason:z.string().min(1).max(200) }).strict(),
  z.object({ kind:z.literal("allocate"),id:ResourceId,tenantId:IdentityId,uid:IdentityId,points:FixedDecimal,operator:IdentityId,reason:z.string().min(1).max(200) }).strict(),
  z.object({ kind:z.literal("reconcile"),runId:ResourceId }).strict(),
]);
export class PointsRepository {
  constructor(private db: Database, private enabled = false) {}
  async command(value: unknown) {
    const cmd = PointsCommand.parse(value);
    return this.db.transaction(async tx => {
      if (cmd.kind === "reconcile") { await settlePoints(tx,cmd.runId); return { recorded:true }; }
      if (cmd.kind === "price") {
        await tx.query("INSERT INTO quota.points_prices(id,document) VALUES($1,$2) ON CONFLICT DO NOTHING",[cmd.policy.id,JSON.stringify(cmd.policy)]);
        const same = (await tx.query("SELECT document=$2::jsonb AS same FROM quota.points_prices WHERE id=$1",[cmd.policy.id,JSON.stringify(cmd.policy)])).rows[0]!.same;
        if (!same) throw new ServiceError(409,"VERSION_CONFLICT");
        await tx.query("INSERT INTO quota.points_active_prices(provider,model,price_id) VALUES($1,$2,$3) ON CONFLICT(provider,model) DO UPDATE SET price_id=EXCLUDED.price_id",[cmd.policy.provider,cmd.policy.model,cmd.policy.id]);
        return { recorded:true };
      }
      const points = micro(cmd.points); if (points <= 0n) throw new ServiceError(400,"INVALID_REQUEST");
      // 操作身份先插入，重试只确认，不重复发放或分配。
      const inserted = (await tx.query("INSERT INTO quota.points_operations(id,payload) VALUES($1,$2) ON CONFLICT DO NOTHING RETURNING id",[cmd.id,JSON.stringify(cmd)])).rows.length;
      if (!inserted) {
        const same = (await tx.query("SELECT payload=$2::jsonb AS same FROM quota.points_operations WHERE id=$1",[cmd.id,JSON.stringify(cmd)])).rows[0]!.same;
        if (!same) throw new ServiceError(409,"IDEMPOTENCY_CONFLICT");
        return { recorded:true };
      }
      const company = await account(tx,cmd.tenantId,"");
      if (cmd.kind === "allocate" && BigInt(String(company.balance)) < points) throw new ServiceError(429,"QUOTA_EXCEEDED");
      const delta = cmd.kind === "grant" ? points : -points;
      await tx.query("UPDATE quota.points_accounts SET balance=balance+$2 WHERE tenant_id=$1 AND owner_uid=''",[cmd.tenantId,delta.toString()]);
      await tx.query("INSERT INTO quota.points_ledger(id,tenant_id,owner_uid,kind,delta,operation_id) VALUES($1,$2,'',$3,$4,$5)",[uuid(),cmd.tenantId,cmd.kind,delta.toString(),cmd.id]);
      if (cmd.kind === "allocate") {
        await account(tx,cmd.tenantId,cmd.uid);
        await tx.query("UPDATE quota.points_accounts SET balance=balance+$3 WHERE tenant_id=$1 AND owner_uid=$2",[cmd.tenantId,cmd.uid,points.toString()]);
        await tx.query("INSERT INTO quota.points_ledger(id,tenant_id,owner_uid,kind,delta,operation_id) VALUES($1,$2,$3,'allocate',$4,$5)",[uuid(),cmd.tenantId,cmd.uid,points.toString(),cmd.id]);
      }
      return { recorded:true };
    });
  }
  async balance(actor: Principal) {
    const row = (await this.db.query("SELECT balance,held FROM quota.points_accounts WHERE tenant_id=$1 AND owner_uid=$2",[actor.tenantId,actor.uid])).rows[0];
    const pending = (await this.db.query("SELECT count(*) AS count FROM quota.points_runs r WHERE r.tenant_id=$1 AND r.owner_uid=$2 AND NOT r.released AND (r.expected_calls IS NOT NULL OR EXISTS(SELECT 1 FROM quota.points_charges c WHERE c.run_id=r.run_id AND c.status<>'settled'))",[actor.tenantId,actor.uid])).rows[0]!;
    const balance = BigInt(String(row?.balance ?? 0)), held = BigInt(String(row?.held ?? 0));
    return PointsBalance.parse({balance:decimal(balance),held:decimal(held),available:decimal(balance-held),billingEnabled:this.enabled,pendingRuns:Number(pending.count)});
  }
  async ledger(actor: Principal, query: {limit:number;after?:string}) {
    const rows = (await this.db.query("SELECT * FROM quota.points_ledger WHERE tenant_id=$1 AND owner_uid=$2 AND ($3::uuid IS NULL OR id<$3) ORDER BY id DESC LIMIT $4",[actor.tenantId,actor.uid,query.after ?? null,query.limit+1])).rows;
    return PointsLedgerPage.parse({ items:rows.slice(0,query.limit).map(r=>({id:r.id,kind:r.kind,delta:decimal(r.delta),createdAt:new Date(r.created_at as string).toISOString(),runId:r.run_id,attempt:r.attempt,call:r.call,amountCny:r.amount===null?null:decimal(r.amount),pricingId:r.price_id})),nextCursor:rows.length>query.limit?rows[query.limit-1]!.id:null });
  }
}

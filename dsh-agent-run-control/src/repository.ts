import { createHash, randomUUID } from "node:crypto";
import { v7 as uuid } from "uuid";
import { RunRequest, FinishRun, ExecutionInput, WorkspaceAuthorizationRequest, type WorkspaceAuthorization, type WorkspaceRunReference, type WorkspaceCapability, type AssistantResult, type Run, type Principal, type RunLease, type ClaimedRun, type ErrorCode, type PublicEvent } from "@dsh-agent/contracts";
import type { Database, Sql } from "./database.js";
import { RunAuditRecord as AuditRecord, QuotaClose, ModelCallReport, ModelUsageEvent } from "@dsh-agent/contracts";
import { activeStep, nextStep, progress } from "./workflow.js";
import { WorkflowStepResult } from "@dsh-agent/contracts";

export class RunError extends Error {
  constructor(public status: number, public code: ErrorCode) { super(code); }
}
const iso = (value: unknown) => new Date(value as string).toISOString();
const view = (row: Record<string, unknown>): Run => ({
  id: String(row.id), sessionId: String(row.session_id), messageId: String(row.message_id),
  state: row.state as Run["state"], attempt: Number(row.attempt),
  output: row.output === null ? null : String(row.output), failureCode: row.failure_code as Run["failureCode"],
  createdAt: iso(row.created_at), updatedAt: iso(row.updated_at),
});
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export class RunRepository {
  constructor(private db: Database, private config = { leaseSeconds: 30, timeoutSeconds: 120, maxActive: 64 },
    private dispatch = { userActive: 2, tenantActive: 32, agingSeconds: 60 }) {
    if (![config.leaseSeconds, config.timeoutSeconds, config.maxActive].every(v => Number.isSafeInteger(v) && v > 0) ||
      config.leaseSeconds > config.timeoutSeconds || config.timeoutSeconds > 3600 || config.maxActive > 1000) throw new Error("Invalid scheduler configuration");
    if (!Object.values(dispatch).every(v=>Number.isSafeInteger(v)&&v>0&&v<=3600)) throw new Error("Invalid dispatch limits");
  }
  async accept(input: unknown) {
    const request = RunRequest.parse(input);
    if (request.subjectId !== request.payload.messageId) throw new RunError(400, "INVALID_REQUEST");
    return this.db.transaction(async tx => {
      const inserted = await tx.query("INSERT INTO run_control.runs(id,tenant_id,owner_uid,session_id,message_id,state,trace_id) " +
        "VALUES($1,$2,$3,$4,$5,'queued',$6) ON CONFLICT(session_id,message_id) DO NOTHING RETURNING id",
        [uuid(), request.tenantId, request.ownerUid, request.sessionId, request.payload.messageId, request.traceId]);
      const found = await tx.query("SELECT * FROM run_control.runs WHERE session_id=$1 AND message_id=$2 FOR UPDATE",
        [request.sessionId, request.payload.messageId]);
      const row = found.rows[0]!;
      if (row.tenant_id !== request.tenantId || row.owner_uid !== request.ownerUid) throw new RunError(409, "IDEMPOTENCY_CONFLICT");
      await tx.query("INSERT INTO run_control.inbox(event_id,run_id) VALUES($1,$2) ON CONFLICT(event_id) DO NOTHING", [request.eventId, row.id]);
      const inbox = await tx.query("SELECT run_id FROM run_control.inbox WHERE event_id=$1", [request.eventId]);
      if (inbox.rows[0]!.run_id !== row.id) throw new RunError(409, "IDEMPOTENCY_CONFLICT");
      if (inserted.rows.length) await this.audit(tx, row, "run.accepted");
      return view(row);
    });
  }
  async reject(sequence: number, reason: "INVALID_REQUEST" | "IDEMPOTENCY_CONFLICT") {
    if (!Number.isSafeInteger(sequence) || sequence <= 0) throw new Error("Invalid stream sequence");
    await this.db.query("INSERT INTO run_control.rejected_requests(stream_sequence,reason) VALUES($1,$2) " +
      "ON CONFLICT(stream_sequence) DO NOTHING", [sequence, reason]);
  }
  private async own(tx: Sql, actor: Principal, id: string, lock = false) {
    const result = await tx.query("SELECT * FROM run_control.runs WHERE id=$1 AND tenant_id=$2 AND owner_uid=$3" +
      (lock ? " FOR UPDATE" : ""), [id, actor.tenantId, actor.uid]);
    if (!result.rows[0]) throw new RunError(404, "NOT_FOUND");
    return result.rows[0];
  }
  async get(actor: Principal, id: string) { return view(await this.own(this.db, actor, id)); }
  async workflowProgress(actor: Principal, id: string) {
    return this.db.transaction(async tx => progress(tx, await this.own(tx, actor, id)));
  }
  async workflowNext(workerId: string, id: string, lease: RunLease) {
    return this.db.transaction(async tx => {
      const row = await this.leased(tx, workerId, id, lease);
      if (row.state !== "running" || row.lease_valid !== true) throw new RunError(409, "LEASE_LOST");
      if (!row.execution_input || !ExecutionInput.parse(row.execution_input).definition.workflow) throw new RunError(409, "INVALID_STATE");
      return nextStep(tx, row);
    });
  }
  async workflowResult(workerId: string, id: string, value: unknown) {
    const data = WorkflowStepResult.parse(value);
    if (!data.output.isWellFormed() || data.output.includes("\0")) throw new RunError(400, "INVALID_REQUEST");
    return this.db.transaction(async tx => {
      const row = await this.leased(tx, workerId, id, data.lease);
      const step = (await tx.query("SELECT * FROM run_control.workflow_steps WHERE run_id=$1 AND attempt=$2 AND step_id=$3", [id,row.attempt,data.stepId])).rows[0];
      if (step?.state === "succeeded") {
        if (step.output !== data.output) throw new RunError(409, "IDEMPOTENCY_CONFLICT");
        return { recorded: true as const };
      }
      if (row.state !== "running" || row.lease_valid !== true) throw new RunError(409, "LEASE_LOST");
      if (step?.state !== "running") throw new RunError(409, "INVALID_STATE");
      const calls = (await tx.query("SELECT count(*) AS total,count(*) FILTER(WHERE final_report IS NULL) AS pending FROM run_control.model_calls WHERE run_id=$1 AND attempt=$2 AND step_id=$3", [id,row.attempt,data.stepId])).rows[0]!;
      if (!Number(calls.total) || Number(calls.pending)) throw new RunError(409, "INVALID_STATE");
      await tx.query("UPDATE run_control.workflow_steps SET state='succeeded',output=$4,completed_at=clock_timestamp() WHERE run_id=$1 AND attempt=$2 AND step_id=$3", [id,row.attempt,data.stepId,data.output]);
      return { recorded: true as const };
    });
  }
  async list(actor: Principal, query: { limit: number; after?: string; sessionId?: string }) {
    const result = await this.db.query("SELECT * FROM run_control.runs WHERE tenant_id=$1 AND owner_uid=$2 " +
      "AND ($3::uuid IS NULL OR id<$3) AND ($4::uuid IS NULL OR session_id=$4) ORDER BY id DESC LIMIT $5",
      [actor.tenantId, actor.uid, query.after ?? null, query.sessionId ?? null, query.limit + 1]);
    return { items: result.rows.slice(0, query.limit).map(view), nextCursor: result.rows.length > query.limit ? String(result.rows[query.limit - 1]!.id) : null };
  }
  async claim(workerId: string): Promise<ClaimedRun | null> {
    return this.db.transaction(async tx => {
      // 全局短事务锁确保多副本领取不穿透并发上限；不覆盖模型执行时间。
      await tx.query("SELECT id FROM run_control.scheduler WHERE id=1 FOR UPDATE");
      const active = await tx.query("SELECT count(*)::integer AS count FROM run_control.runs WHERE state='running' " +
        "OR (state='canceled' AND lease_expires_at>clock_timestamp())");
      if (Number(active.rows[0]!.count) >= this.config.maxActive) return null;
      const candidate = await tx.query("WITH user_load AS MATERIALIZED (SELECT tenant_id,owner_uid,count(*) AS n FROM run_control.runs " +
        "WHERE state='running' OR (state='canceled' AND lease_expires_at>clock_timestamp()) GROUP BY tenant_id,owner_uid), " +
        "tenant_load AS (SELECT tenant_id,sum(n) AS n FROM user_load GROUP BY tenant_id) " +
        "SELECT r.* FROM run_control.runs r LEFT JOIN user_load u ON u.tenant_id=r.tenant_id AND u.owner_uid=r.owner_uid " +
        "LEFT JOIN tenant_load t ON t.tenant_id=r.tenant_id WHERE r.state='queued' AND COALESCE(u.n,0)<$1 AND COALESCE(t.n,0)<$2 AND NOT EXISTS " +
        "(SELECT 1 FROM run_control.runs x WHERE x.session_id=r.session_id AND " +
        "(x.state='running' OR (x.state='canceled' AND x.lease_expires_at>clock_timestamp()) OR " +
        "(x.state='queued' AND x.enqueue_sequence<r.enqueue_sequence))) " +
        "AND NOT EXISTS (SELECT 1 FROM run_control.result_projections p JOIN run_control.runs x ON x.id=p.run_id " +
        "WHERE x.session_id=r.session_id AND p.projected_at IS NULL) " +
        "ORDER BY CASE WHEN r.created_at<clock_timestamp()-($3::integer*interval '1 second') THEN 0 ELSE 1 END," +
        "CASE WHEN r.created_at<clock_timestamp()-($3::integer*interval '1 second') THEN r.enqueue_sequence ELSE 0 END," +
        "COALESCE(t.n,0),COALESCE(u.n,0),r.enqueue_sequence FOR UPDATE OF r SKIP LOCKED LIMIT 1",
        [this.dispatch.userActive,this.dispatch.tenantActive,this.dispatch.agingSeconds]);
      if (!candidate.rows[0]) return null;
      const result = await tx.query("UPDATE run_control.runs SET state='running',attempt=attempt+1,worker_id=$2,lease_id=$3," +
        "lease_expires_at=clock_timestamp()+($4::integer * interval '1 second'),deadline_at=clock_timestamp()+($5::integer * interval '1 second')," +
        "updated_at=now() WHERE id=$1 RETURNING *",
        [candidate.rows[0].id, workerId, randomUUID(), this.config.leaseSeconds, this.config.timeoutSeconds]);
      const row = result.rows[0]!;
      await this.audit(tx, row, "run.started");
      return { run: view(row), actor: { uid: String(row.owner_uid), tenantId: String(row.tenant_id), roles: [] },
        lease: { leaseId: String(row.lease_id), attempt: Number(row.attempt) },
        leaseExpiresAt: iso(row.lease_expires_at), deadlineAt: iso(row.deadline_at) };
    });
  }
  private async leased(tx: Sql, workerId: string, id: string, lease: RunLease): Promise<Record<string, unknown>> {
    const result = await tx.query("SELECT * FROM run_control.runs WHERE id=$1 FOR UPDATE", [id]);
    const row = result.rows[0];
    if (!row || row.worker_id !== workerId || row.lease_id !== lease.leaseId || Number(row.attempt) !== lease.attempt) {
      throw new RunError(409, "LEASE_LOST");
    }
    // 行锁可能等待；取得锁之后重新读取实际时间，不能使用事务开始时固定的 now()。
    const validity = await tx.query("SELECT lease_expires_at>clock_timestamp() AND deadline_at>clock_timestamp() AS valid " +
      "FROM run_control.runs WHERE id=$1", [id]);
    return { ...row, lease_valid: validity.rows[0]!.valid };
  }
  async heartbeat(workerId: string, id: string, lease: RunLease) {
    return this.db.transaction(async tx => {
      const row = await this.leased(tx, workerId, id, lease);
      if (row.state !== "running" || row.lease_valid !== true) throw new RunError(409, "LEASE_LOST");
      const updated = await tx.query("UPDATE run_control.runs SET lease_expires_at=LEAST(deadline_at,clock_timestamp()+($2::integer * interval '1 second'))," +
        "updated_at=now() WHERE id=$1 AND lease_expires_at>clock_timestamp() AND deadline_at>clock_timestamp() RETURNING lease_expires_at", [id, this.config.leaseSeconds]);
      if (!updated.rows[0]) throw new RunError(409, "LEASE_LOST");
      return { leaseExpiresAt: iso(updated.rows[0]!.lease_expires_at) };
    });
  }
  async input(workerId: string, id: string, lease: RunLease,
    resolve: (actor: Principal, run: Run) => Promise<ExecutionInput>,
    reserve?: (actor: Principal, input: ExecutionInput, deadlineAt: string) => Promise<void>): Promise<ExecutionInput> {
    const initial = await this.db.transaction(async tx => {
      const row = await this.leased(tx, workerId, id, lease);
      if (row.state !== "running" || row.lease_valid !== true) throw new RunError(409, "LEASE_LOST");
      return row;
    });
    if (initial.execution_input) return ExecutionInput.parse(initial.execution_input);
    // 外部服务调用不占用运行行锁；返回后重新授权，取消/租约到期优先于快照保存。
    const actor = { tenantId: String(initial.tenant_id), uid: String(initial.owner_uid), roles: [] };
    const input = ExecutionInput.parse(await resolve(actor, view(initial)));
    if (input.runId !== id || input.context.sessionId !== initial.session_id || input.context.messageId !== initial.message_id ||
      input.definition.id !== input.context.binding.agentDefinitionId || input.definition.version !== input.context.binding.agentDefinitionVersion ||
      input.context.messages.some(m => m.sessionId !== initial.session_id) ||
      input.context.messages.at(-1)!.id !== initial.message_id || input.context.messages.at(-1)!.role !== "user" ||
      input.context.messages.reduce((sum, m) => sum + m.content.length, 0) > 64_000) throw new RunError(503, "DEPENDENCY_UNAVAILABLE");
    // 预留发生在模型输入交付之前；确认丢失可用同一运行标识幂等重传。
    await reserve?.(actor, input, iso(initial.deadline_at));
    return this.db.transaction(async tx => {
      const row = await this.leased(tx, workerId, id, lease);
      if (row.state !== "running" || row.lease_valid !== true) throw new RunError(409, "LEASE_LOST");
      if (row.execution_input) return ExecutionInput.parse(row.execution_input);
      await tx.query("UPDATE run_control.runs SET execution_input=$2 WHERE id=$1", [id, JSON.stringify(input)]);
      return input;
    });
  }
  private async event(tx: Sql, row: Record<string, unknown>, eventType: PublicEvent["eventType"], text?: string) {
    if (eventType === "run.completed.v1" || eventType === "run.failed.v1" || eventType === "run.canceled.v1") {
      await this.audit(tx, row, eventType.slice(0, -3) as AuditRecord["action"]);
      const calls = (await tx.query("SELECT count(*)::integer AS count FROM run_control.model_calls WHERE run_id=$1", [row.id])).rows[0]!;
      const payload = QuotaClose.parse({ runId: row.id, actor: { tenantId: row.tenant_id, uid: row.owner_uid, roles: [] }, expectedCalls: Number(calls.count) });
      // 不以取消响应宣称在途执行已经停止；失败/取消保守保留至总截止时间后一段宽限。
      const delay = eventType === "run.completed.v1" ? new Date().toISOString() : new Date(Math.max(Date.now(), row.deadline_at ? new Date(row.deadline_at as string).getTime() + 60_000 : Date.now())).toISOString();
      await tx.query("INSERT INTO run_control.support_outbox(id,kind,payload,next_attempt_at) VALUES($1,'quota-close',$2,$3)", [uuid(), JSON.stringify(payload), delay]);
    }
    const envelope = { eventId: uuid(), occurredAt: new Date().toISOString(), producer: "dsh-agent-run-control",
      tenantId: row.tenant_id, ownerUid: row.owner_uid, sessionId: row.session_id, subjectId: row.id, traceId: row.trace_id,
      eventType, payload: text === undefined ? { runId: row.id } : { runId: row.id, text } };
    await tx.query("INSERT INTO run_control.outbox(event_id,run_id,subject,envelope) VALUES($1,$2,$3,$4)",
      [envelope.eventId, row.id, "agent.events." + row.tenant_id + "." + row.owner_uid + "." + row.session_id, JSON.stringify(envelope)]);
  }
  async workspaceCapability(workerId: string, id: string, lease: RunLease,
    sign: (reference: WorkspaceRunReference, expiresAt: number) => Promise<WorkspaceCapability>) {
    return this.db.transaction(async tx => {
      const row = await this.leased(tx, workerId, id, lease);
      if (row.state !== "running" || row.lease_valid !== true) throw new RunError(409, "LEASE_LOST");
      if (!row.execution_input) throw new RunError(409, "INVALID_STATE");
      const input = ExecutionInput.parse(row.execution_input);
      if (!input.definition.tools.length) throw new RunError(403, "FORBIDDEN");
      const expiresAt = Math.floor(Math.min(new Date(row.lease_expires_at as string).getTime(), new Date(row.deadline_at as string).getTime()) / 1000);
      return sign({ runId: id, workerId, ...lease }, expiresAt);
    });
  }
  async authorizeWorkspace(input: unknown): Promise<WorkspaceAuthorization> {
    const request = WorkspaceAuthorizationRequest.parse(input);
    return this.db.transaction(async tx => {
      const row = await this.leased(tx, request.workerId, request.runId, request);
      if (row.state !== "running" || row.lease_valid !== true) throw new RunError(409, "LEASE_LOST");
      if (!row.execution_input) throw new RunError(409, "INVALID_STATE");
      const snapshot = ExecutionInput.parse(row.execution_input);
      if (!snapshot.definition.tools.includes(request.tool)) throw new RunError(403, "FORBIDDEN");
      if (snapshot.definition.workflow) {
        const active = await activeStep(tx, row);
        const node = snapshot.definition.workflow.steps.find(s => s.id === active?.step_id);
        if (!node?.tools.includes(request.tool)) throw new RunError(403, "FORBIDDEN");
      }
      return { ...request, actor: { tenantId: String(row.tenant_id), uid: String(row.owner_uid), roles: [] },
        workspaceId: snapshot.context.binding.workspaceId,
        leaseExpiresAt: iso(Math.min(new Date(row.lease_expires_at as string).getTime(), new Date(row.deadline_at as string).getTime())) };
    });
  }
  async finish(workerId: string, id: string, input: unknown) {
    const data = FinishRun.parse(input);
    if (data.state === "succeeded" && (!data.output.isWellFormed() || data.output.includes("\0"))) throw new RunError(400, "INVALID_REQUEST");
    const resultHash = hash(data);
    return this.db.transaction(async tx => {
      const row = await this.leased(tx, workerId, id, data);
      if (row.result_hash === resultHash) return view(row);
      if (row.state !== "running" || row.lease_valid !== true) throw new RunError(409, "LEASE_LOST");
      if (data.state === "succeeded" && row.execution_input && ExecutionInput.parse(row.execution_input).definition.workflow) {
        const current = await progress(tx, row);
        if (!current.steps.length || current.steps.some(s => s.state !== "succeeded" && s.state !== "skipped")) throw new RunError(409, "INVALID_STATE");
        const last = (await tx.query("SELECT output FROM run_control.workflow_steps WHERE run_id=$1 AND attempt=$2 AND state='succeeded' ORDER BY position DESC LIMIT 1", [id,row.attempt])).rows[0];
        if (last?.output !== data.output) throw new RunError(409, "INVALID_STATE");
      }
      const result = await tx.query("UPDATE run_control.runs SET state=$2,output=$3,failure_code=$4,result_hash=$5,updated_at=now() " +
        "WHERE id=$1 RETURNING *", [id, data.state, data.state === "succeeded" ? data.output : null,
        data.state === "failed" ? data.failureCode : null, resultHash]);
      if (data.state === "succeeded") {
        await tx.query("INSERT INTO run_control.result_projections(run_id) VALUES($1)", [id]);
        // 当前协议回传完整结果；拆成小事件是为满足代理大小约束，不冒充模型实时流。
        const points = Array.from(data.output);
        for (let offset = 0; offset < points.length; offset += 4000) {
          await this.event(tx, row, "run.output.delta.v1", points.slice(offset, offset + 4000).join(""));
        }
      }
      await this.event(tx, row, data.state === "succeeded" ? "run.completed.v1" : "run.failed.v1");
      return view(result.rows[0]!);
    });
  }
  async cancel(actor: Principal, id: string) {
    return this.db.transaction(async tx => {
      const row = await this.own(tx, actor, id, true);
      if (row.state === "canceled") return view(row);
      if (row.state !== "queued" && row.state !== "running") throw new RunError(409, "INVALID_STATE");
      const result = await tx.query("UPDATE run_control.runs SET state='canceled',updated_at=now() WHERE id=$1 RETURNING *", [id]);
      await this.event(tx, row, "run.canceled.v1");
      // 运行中取消继续占用会话槽位，直到旧租约到期或执行端确认停止。
      return view(result.rows[0]!);
    });
  }
  async release(workerId: string, id: string, lease: RunLease) {
    return this.db.transaction(async tx => {
      const row = await this.leased(tx, workerId, id, lease);
      if (row.state !== "canceled") throw new RunError(409, "INVALID_STATE");
      await tx.query("UPDATE run_control.runs SET lease_expires_at=clock_timestamp() WHERE id=$1", [id]);
      return { released: true as const };
    });
  }
  async expireBatch() {
    return this.db.transaction(async tx => {
      const result = await tx.query("SELECT *,deadline_at<=clock_timestamp() AS timed_out FROM run_control.runs WHERE state='running' " +
        "AND (lease_expires_at<=clock_timestamp() OR deadline_at<=clock_timestamp()) ORDER BY lease_expires_at FOR UPDATE SKIP LOCKED LIMIT 100");
      for (const row of result.rows) {
        await tx.query("UPDATE run_control.runs SET state='failed',failure_code=$2,updated_at=now() WHERE id=$1",
          [row.id, row.timed_out ? "TIMEOUT" : "LEASE_EXPIRED"]);
        await this.event(tx, row, "run.failed.v1");
      }
      // 不自动再次执行：租约丢失无法证明外部副作用是否发生。
      return result.rows.length;
    });
  }
  async publishBatch(publish: (subject: string, event: PublicEvent) => Promise<void>) {
    return this.db.transaction(async tx => {
      const found = await tx.query("SELECT r.id FROM run_control.runs r WHERE EXISTS " +
        "(SELECT 1 FROM run_control.outbox o WHERE o.run_id=r.id AND o.published_at IS NULL) " +
        "AND NOT EXISTS (SELECT 1 FROM run_control.result_projections p WHERE p.run_id=r.id AND p.projected_at IS NULL) " +
        "ORDER BY r.enqueue_sequence FOR UPDATE OF r SKIP LOCKED LIMIT 1");
      if (!found.rows[0]) return 0;
      const result = await tx.query("SELECT * FROM run_control.outbox WHERE run_id=$1 AND published_at IS NULL ORDER BY sequence LIMIT 50", [found.rows[0].id]);
      for (const row of result.rows) {
        await publish(String(row.subject), row.envelope as PublicEvent);
        await tx.query("UPDATE run_control.outbox SET published_at=now() WHERE event_id=$1", [row.event_id]);
      }
      return result.rows.length;
    });
  }
  async projectBatch(deliver: (actor: Principal, sessionId: string, result: AssistantResult) => Promise<void>) {
    return this.db.transaction(async tx => {
      // 只锁投影票据，不锁运行/调度器；单次 HTTP 有界，同一票据由一个副本投递。
      const found = await tx.query("SELECT p.run_id,p.attempts,r.tenant_id,r.owner_uid,r.session_id,r.message_id,r.output " +
        "FROM run_control.result_projections p JOIN run_control.runs r ON r.id=p.run_id " +
        "WHERE p.projected_at IS NULL AND p.next_attempt_at<=clock_timestamp() " +
        "ORDER BY p.next_attempt_at,r.enqueue_sequence FOR UPDATE OF p SKIP LOCKED LIMIT 1");
      const row = found.rows[0];
      if (!row) return "idle" as const;
      try {
        await deliver({ tenantId: String(row.tenant_id), uid: String(row.owner_uid), roles: [] }, String(row.session_id),
          { runId: String(row.run_id), messageId: String(row.message_id), output: String(row.output) });
      } catch {
        const delay = Math.min(60, 2 ** Math.min(Number(row.attempts), 6));
        await tx.query("UPDATE run_control.result_projections SET attempts=attempts+1,next_attempt_at=clock_timestamp()+($2::integer * interval '1 second') WHERE run_id=$1",
          [row.run_id, delay]);
        return "retry" as const;
      }
      await tx.query("UPDATE run_control.result_projections SET attempts=attempts+1,projected_at=clock_timestamp() WHERE run_id=$1", [row.run_id]);
      return "projected" as const;
    });
  }
  private async audit(tx: Sql, row: Record<string, unknown>, action: AuditRecord["action"]) {
    const record = AuditRecord.parse({ eventId: uuid(), occurredAt: new Date().toISOString(), producer: "dsh-agent-run-control",
      tenantId: row.tenant_id, ownerUid: row.owner_uid, runId: row.id, sessionId: row.session_id, action });
    await tx.query("INSERT INTO run_control.support_outbox(id,kind,payload) VALUES($1,'audit',$2)", [record.eventId, JSON.stringify(record)]);
  }
  async reportUsage(workerId: string, id: string, lease: RunLease, value: unknown) {
    const report = ModelCallReport.parse(value);
    return this.db.transaction(async tx => {
      const row = await this.leased(tx, workerId, id, lease);
      if (!row.execution_input) throw new RunError(409, "INVALID_STATE");
      const input = ExecutionInput.parse(row.execution_input);
      if (report.call > input.definition.execution.maxTurns) throw new RunError(409, "INVALID_STATE");
      let previous = (await tx.query("SELECT * FROM run_control.model_calls WHERE run_id=$1 AND attempt=$2 AND call=$3", [id, lease.attempt, report.call])).rows[0];
      if (report.phase === "started") {
        // 重复开始也要检查当前租约，确认丢失不能成为取消后调用模型的许可。
        if (row.state !== "running" || row.lease_valid !== true) throw new RunError(409, "LEASE_LOST");
        let stepId: string | null = null;
        if (input.definition.workflow) {
          const active = await activeStep(tx, row), node = input.definition.workflow.steps.find(s => s.id === active?.step_id);
          if (!node) throw new RunError(409, "INVALID_STATE");
          stepId = node.id;
          if (previous && previous.step_id !== stepId) throw new RunError(409, "INVALID_STATE");
          const used = (await tx.query("SELECT count(*) AS count FROM run_control.model_calls WHERE run_id=$1 AND attempt=$2 AND step_id=$3", [id,lease.attempt,stepId])).rows[0]!;
          if (!previous && Number(used.count) >= node.maxTurns) throw new RunError(409, "INVALID_STATE");
        }
        if (previous) {
          if (previous.final_report) throw new RunError(409, "INVALID_STATE");
          return { recorded: true as const };
        }
        if (report.call > 1) {
          const prior = (await tx.query("SELECT final_report FROM run_control.model_calls WHERE run_id=$1 AND attempt=$2 AND call=$3", [id, lease.attempt, report.call - 1])).rows[0];
          if (!prior?.final_report) throw new RunError(409, "INVALID_STATE");
        }
        previous = (await tx.query("INSERT INTO run_control.model_calls(run_id,attempt,call,step_id) VALUES($1,$2,$3,$4) RETURNING *", [id, lease.attempt, report.call, stepId])).rows[0]!;
      } else {
        // 只补记已开始调用的计量，可在取消/超时后完成；绝不恢复租约或执行权限。
        if (!previous) throw new RunError(409, "INVALID_STATE");
        if (previous.final_report) {
          const same = (await tx.query("SELECT final_report=$4::jsonb AS same FROM run_control.model_calls WHERE run_id=$1 AND attempt=$2 AND call=$3", [id, lease.attempt, report.call, JSON.stringify(report)])).rows[0]!.same;
          if (!same) throw new RunError(409, "IDEMPOTENCY_CONFLICT");
          return { recorded: true as const };
        }
        await tx.query("UPDATE run_control.model_calls SET final_report=$4 WHERE run_id=$1 AND attempt=$2 AND call=$3", [id, lease.attempt, report.call, JSON.stringify(report)]);
      }
      const event = ModelUsageEvent.parse({ eventId: uuid(), runId: id, attempt: lease.attempt,
        actor: { tenantId: row.tenant_id, uid: row.owner_uid, roles: [] }, provider: input.definition.model.provider,
        model: input.definition.model.name, startedAt: iso(previous.started_at), report });
      await tx.query("INSERT INTO run_control.support_outbox(id,kind,payload) VALUES($1,'model-usage',$2)", [event.eventId, JSON.stringify(event)]);
      return { recorded: true as const };
    });
  }
  async supportBatch(deliver: (kind: "audit" | "quota-close" | "model-usage", payload: unknown) => Promise<void>) {
    return this.db.transaction(async tx => {
      const row = (await tx.query("SELECT * FROM run_control.support_outbox WHERE delivered_at IS NULL AND next_attempt_at<=clock_timestamp() ORDER BY next_attempt_at,id FOR UPDATE SKIP LOCKED LIMIT 1")).rows[0];
      if (!row) return "idle" as const;
      try { await deliver(row.kind as "audit" | "quota-close" | "model-usage", row.payload); }
      catch {
        await tx.query("UPDATE run_control.support_outbox SET attempts=attempts+1,next_attempt_at=clock_timestamp()+($2::integer*interval '1 second') WHERE id=$1",
          [row.id, Math.min(60, 2 ** Math.min(Number(row.attempts), 6))]);
        return "retry" as const;
      }
      await tx.query("UPDATE run_control.support_outbox SET delivered_at=clock_timestamp(),attempts=attempts+1 WHERE id=$1", [row.id]);
      return "delivered" as const;
    });
  }
  async metrics(): Promise<Record<string, number>> {
    const row = (await this.db.query("SELECT " +
      "(SELECT count(*) FROM run_control.runs WHERE state='queued') AS runs_queued," +
      "(SELECT count(*) FROM run_control.runs WHERE state='running') AS runs_running," +
      "(SELECT count(*) FROM run_control.runs WHERE state='running' AND (lease_expires_at<=clock_timestamp() OR deadline_at<=clock_timestamp())) AS runs_overdue," +
      "(SELECT count(*) FROM run_control.support_outbox WHERE delivered_at IS NULL AND next_attempt_at<=clock_timestamp()) AS support_due," +
      "(SELECT count(*) FROM run_control.support_outbox WHERE delivered_at IS NULL) AS support_pending," +
      "(SELECT COALESCE(GREATEST(EXTRACT(EPOCH FROM clock_timestamp()-min(created_at)),0),0) FROM run_control.support_outbox WHERE delivered_at IS NULL) AS support_oldest_age_seconds," +
      "(SELECT COALESCE(max(attempts),0) FROM run_control.support_outbox WHERE delivered_at IS NULL) AS support_max_attempts," +
      "(SELECT COALESCE(GREATEST(EXTRACT(EPOCH FROM clock_timestamp()-min(created_at)),0),0) FROM run_control.support_outbox WHERE delivered_at IS NULL AND attempts>0) AS support_retry_oldest_age_seconds," +
      "(SELECT count(*) FROM run_control.result_projections WHERE projected_at IS NULL) AS projections_pending," +
      "(SELECT COALESCE(max(attempts),0) FROM run_control.result_projections WHERE projected_at IS NULL) AS projections_max_attempts")).rows[0]!;
    return Object.fromEntries(Object.entries(row).map(([key,value]) => [key, Number(value)]));
  }
}

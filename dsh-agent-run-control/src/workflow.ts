import { ExecutionInput, WorkflowProgress, type RunProgress } from "@dsh-agent/contracts";
import type { Sql } from "./database.js";
import { RunError } from "./repository.js";
// 本模块只访问本服务数据库；调用方持有运行行锁并完成租约检查。
export async function activeStep(tx: Sql, row: Record<string, unknown>) {
  return (await tx.query("SELECT * FROM run_control.workflow_steps WHERE run_id=$1 AND attempt=$2 AND state='running'", [row.id, row.attempt])).rows[0];
}
// State projection only: DSH selects steps/conditions, this boundary validates permissions/accounting.
export async function observeStep(tx: Sql, row: Record<string, unknown>, report: Extract<RunProgress, { kind: "workflow" }>) {
  const workflow = ExecutionInput.parse(row.execution_input).definition.workflow;
  const position = workflow?.steps.findIndex(s => s.id === report.stepId) ?? -1;
  if (position < 0) throw new RunError(409, "INVALID_STATE");
  const records = (await tx.query("SELECT * FROM run_control.workflow_steps WHERE run_id=$1 AND attempt=$2 ORDER BY position", [row.id, row.attempt])).rows;
  const step = records.find(r => r.step_id === report.stepId);
  if (report.state === "succeeded") {
    if (step?.state !== "running") throw new RunError(409, "INVALID_STATE");
    const calls = (await tx.query("SELECT count(*) AS total,count(*) FILTER(WHERE final_report IS NULL) AS pending FROM run_control.model_calls WHERE run_id=$1 AND attempt=$2 AND step_id=$3",
      [row.id,row.attempt,report.stepId])).rows[0]!;
    if (!Number(calls.total) || Number(calls.pending)) throw new RunError(409, "INVALID_STATE");
    await tx.query("UPDATE run_control.workflow_steps SET state='succeeded',output=$4,completed_at=clock_timestamp() WHERE run_id=$1 AND attempt=$2 AND step_id=$3",
      [row.id,row.attempt,report.stepId,report.output]);
  } else {
    // This release exposes sequential presets only. Reject overlapping/duplicate observations.
    if (step || records.some(r => r.state === "running")) throw new RunError(409, "INVALID_STATE");
    await tx.query("INSERT INTO run_control.workflow_steps(run_id,attempt,step_id,position,state,completed_at) VALUES($1,$2,$3,$4,$5,CASE WHEN $5='skipped' THEN clock_timestamp() ELSE NULL END)",
      [row.id,row.attempt,report.stepId,position,report.state]);
  }
}
export async function progress(tx: Sql, row: Record<string, unknown>) {
  const workflow = row.execution_input ? ExecutionInput.parse(row.execution_input).definition.workflow : undefined;
  const rows = (await tx.query("SELECT * FROM run_control.workflow_steps WHERE run_id=$1 AND attempt=$2 ORDER BY position", [row.id,row.attempt])).rows;
  return WorkflowProgress.parse({ runId: row.id, state: row.state, enabled: !!workflow, steps: (workflow?.steps ?? []).map(step => {
    const record = rows.find(r => r.step_id === step.id);
    const state = record?.state === "running" && (row.state === "failed" || row.state === "canceled") ? "interrupted" : record?.state ?? "pending";
    return { id: step.id, state, startedAt: record ? new Date(record.started_at as string).toISOString() : null,
      completedAt: record?.completed_at ? new Date(record.completed_at as string).toISOString() : null };
  }) });
}

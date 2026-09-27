import { ExecutionInput, WorkflowNext, WorkflowProgress } from "@dsh-agent/contracts";
import type { Sql } from "./database.js";
// 本模块只访问本服务数据库；调用方持有运行行锁并完成租约检查。
export async function activeStep(tx: Sql, row: Record<string, unknown>) {
  return (await tx.query("SELECT * FROM run_control.workflow_steps WHERE run_id=$1 AND attempt=$2 AND state='running'", [row.id, row.attempt])).rows[0];
}
export async function nextStep(tx: Sql, row: Record<string, unknown>) {
  const input = ExecutionInput.parse(row.execution_input), workflow = input.definition.workflow!;
  const rows = (await tx.query("SELECT * FROM run_control.workflow_steps WHERE run_id=$1 AND attempt=$2 ORDER BY position", [row.id, row.attempt])).rows;
  let previousOutput: string | null = null;
  for (let position = 0; position < workflow.steps.length; position++) {
    const step = workflow.steps[position]!, recorded = rows.find(r => r.step_id === step.id);
    if (recorded?.state === "succeeded") { previousOutput = String(recorded.output); continue; }
    if (recorded?.state === "skipped") continue;
    if (recorded) return WorkflowNext.parse({ complete: false, step, previousOutput });
    const skip = step.whenPreviousContains !== undefined && !previousOutput?.includes(step.whenPreviousContains);
    await tx.query("INSERT INTO run_control.workflow_steps(run_id,attempt,step_id,position,state,completed_at) VALUES($1,$2,$3,$4,$5,CASE WHEN $5='skipped' THEN clock_timestamp() ELSE NULL END)",
      [row.id,row.attempt,step.id,position,skip ? "skipped" : "running"]);
    if (!skip) return WorkflowNext.parse({ complete: false, step, previousOutput });
  }
  return WorkflowNext.parse({ complete: true, output: previousOutput });
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

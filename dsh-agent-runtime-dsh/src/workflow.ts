import { randomUUID } from "node:crypto";
import { ExecutionInput, type ClaimedRun, type WorkflowNext } from "@dsh-agent/contracts";
import { RuntimeError, type RuntimeClient } from "./client.js";
import type { Executor } from "./worker.js";
import { setTimeout as pause } from "node:timers/promises";

export function stepInput(input: ExecutionInput, next: Extract<WorkflowNext, { complete: false }>): ExecutionInput {
  const { workflow: _workflow, ...definition } = input.definition;
  const history = input.context.messages.slice(0, -1), current = input.context.messages.at(-1)!;
  if (next.previousOutput !== null) history.push({ id: randomUUID(), sessionId: input.context.sessionId,
    role: "assistant", content: next.previousOutput, createdAt: new Date().toISOString() });
  let truncated = input.context.truncated;
  while (history.length >= 40 || history.reduce((size,m) => size + m.content.length, current.content.length) > 64_000) { history.shift(); truncated = true; }
  return ExecutionInput.parse({ ...input, definition: { ...definition,
    systemPrompt: definition.systemPrompt + "\n\nApproved workflow step:\n" + next.step.instructions,
    tools: next.step.tools, execution: { ...definition.execution, maxTurns: next.step.maxTurns } },
    context: { ...input.context, messages: [...history,current], truncated } });
}

// 单次运行内协调步骤；仅重传状态命令，不重跑任何模型步骤。
export async function executeWorkflow(client: RuntimeClient, claim: ClaimedRun, input: ExecutionInput,
  execute: Executor, tool: Parameters<Executor>[1], signal: AbortSignal, report: NonNullable<Parameters<Executor>[3]>) {
  const workflow = input.definition.workflow!;
  let callOffset = 0;
  const seen = new Set<string>();
  const retry = async <T>(fn: () => Promise<T>): Promise<T> => {
    for (let attempt = 0; ; attempt++) {
      signal.throwIfAborted();
      try { return await fn(); } catch (error) {
        if (attempt === 2 || error instanceof RuntimeError && error.status === 409) throw error;
        await pause(100 * (attempt + 1), undefined, { signal });
      }
    }
  };
  for (let transition = 0; transition <= workflow.steps.length; transition++) {
    const next = await retry(() => client.workflowNext(claim, signal));
    if (next.complete) return next.output;
    const expected = workflow.steps.find(s => s.id === next.step.id);
    if (!expected || JSON.stringify(expected) !== JSON.stringify(next.step) || seen.has(next.step.id)) throw new Error("Invalid workflow transition");
    seen.add(next.step.id);
    let calls = 0;
    const result = await execute(stepInput(input,next), async call => {
      if (!next.step.tools.includes(call.tool)) throw new Error("Step tool denied");
      return tool(call);
    }, signal, async value => {
      if (value.call > next.step.maxTurns) throw new Error("Step model budget exceeded");
      calls = Math.max(calls, value.call);
      await report({ ...value, call: callOffset + value.call });
    });
    signal.throwIfAborted();
    await retry(() => client.workflowResult(claim, next.step.id, result, signal));
    callOffset += calls;
  }
  throw new Error("Workflow transition budget exceeded");
}

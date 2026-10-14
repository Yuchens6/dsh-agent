import { randomUUID } from "node:crypto";
import { Context } from "@deepseek-ai/cordis";
import AgentRegistry from "@deepseek-ai/dsh-agent";
import AgentLoop from "@deepseek-ai/dsh-agent-loop";
import LlmRuntime from "@deepseek-ai/dsh-llm";
import SessionStore, { SessionId } from "@deepseek-ai/dsh-session";
import SystemPrompt from "@deepseek-ai/dsh-system-prompt";
import ToolRuntime from "@deepseek-ai/dsh-tools";
import SubagentRuntime, { type SubagentResult } from "@deepseek-ai/dsh-subagent";
import WorkflowWorkerThread from "@deepseek-ai/dsh-workflow-worker-thread";
import { ExecutionInput, type WorkflowStep } from "@dsh-agent/contracts";
import { runEngine } from "./engine.js";

// Trusted deployment code. Prompts and model outputs are data, never script source.
// Sequencing and conditions execute in the official DSH workflow engine.
const script = `
let previousOutput = null;
for (const step of args.steps) {
  if (step.whenPreviousContains !== undefined && !(previousOutput ?? "").includes(step.whenPreviousContains)) {
    log(JSON.stringify({ stepId: step.id, state: "skipped" }));
    continue;
  }
  const output = await agent(JSON.stringify({ stepId: step.id, previousOutput }), { label: step.id });
  if (typeof output !== "string" || !output) throw new Error("Step failed");
  previousOutput = output;
}
return previousOutput;
`;

export function stepInput(input: ExecutionInput, step: WorkflowStep, previousOutput: string | null): ExecutionInput {
  const { workflow: _workflow, ...definition } = input.definition;
  const history = input.context.messages.slice(0, -1), current = input.context.messages.at(-1)!;
  if (previousOutput !== null) history.push({ id: randomUUID(), sessionId: input.context.sessionId,
    role: "assistant", content: previousOutput, createdAt: new Date().toISOString() });
  return ExecutionInput.parse({ ...input, definition: { ...definition,
    systemPrompt: definition.systemPrompt + "\n\nApproved workflow step:\n" + step.instructions,
    tools: step.tools, execution: { ...definition.execution, maxTurns: step.maxTurns } },
    context: { ...input.context, messages: [...history,current] } });
}

// Identity-scoped tools and accounting bridge, not a second workflow scheduler.
export const runNativeWorkflow: typeof runEngine = async (input, adapter, tool, signal, maxToolCalls,
  reportUsage = async () => {}, reportProgress = async () => {}, consumeTool = () => {}) => {
  const workflow = input.definition.workflow!;
  const ctx = new Context(), stop = new AbortController();
  const runSignal = AbortSignal.any([signal, stop.signal]);
  let pending = Promise.resolve(), callOffset = 0, tools = 0;
  const seen = new Set<string>();
  const observe = (report: Parameters<typeof reportProgress>[0]) => {
    pending = pending.then(() => { runSignal.throwIfAborted(); return reportProgress(report); });
    void pending.catch(() => stop.abort());
    return pending;
  };
  try {
    await ctx.plugin(LlmRuntime); await ctx.plugin(SessionStore);
    await ctx.plugin(SystemPrompt, { includeHarnessIdentity: false, includeRuntimeContext: false });
    await ctx.plugin(ToolRuntime, { mode: "native" }); await ctx.plugin(AgentRegistry);
    await ctx.plugin(AgentLoop, { agents: [], maxParallelToolCalls: 1 });
    await ctx.plugin(SubagentRuntime);
    ctx.effect(() => ctx.subagents.registerProvider({
      name: "platform-preset", inheritsParentContext: false,
      capabilities: { outputSchema: false, depthLimit: false, toolFilter: false, persona: false },
      async start(request) {
        await pending; runSignal.throwIfAborted();
        const text = request.prompt.map(block => block.type === "text" ? block.text : "").join("");
        const data = JSON.parse(text) as { stepId: string; previousOutput: string | null };
        const step = workflow.steps.find(s => s.id === data.stepId);
        if (!step || seen.has(step.id) || request.agentOptions) throw new Error("Unapproved workflow invocation");
        seen.add(step.id);
        const childStop = new AbortController();
        const childSignal = AbortSignal.any([runSignal, request.signal, childStop.signal]);
        const result: Promise<SubagentResult> = (async (): Promise<SubagentResult> => {
          await observe({ kind: "workflow", stepId: step.id, state: "running" });
          let calls = 0;
          const output = await runEngine(stepInput(input, step, data.previousOutput), adapter, async call => {
            if (!step.tools.includes(call.tool)) throw new Error("Step tool denied");
            return tool(call);
          }, childSignal, maxToolCalls, async value => {
            if (value.call > step.maxTurns || callOffset + value.call > input.definition.execution.maxTurns) throw new Error("Model budget exceeded");
            calls = Math.max(calls, value.call);
            await reportUsage({ ...value, call: callOffset + value.call });
          }, value => observe("call" in value ? { ...value, call: callOffset + value.call } : value), () => {
            if (++tools > maxToolCalls) throw new Error("Workflow tool budget exceeded");
            consumeTool();
          });
          childSignal.throwIfAborted();
          await observe({ kind: "workflow", stepId: step.id, state: "succeeded", output });
          callOffset += calls;
          return { output: [{ type: "text", text: output }], stopReason: "completed" };
        })().catch(() => ({ output: [], stopReason: childSignal.aborted ? "aborted" : "error" }));
        return { id: SessionId(randomUUID()), localAgent: undefined, result,
          async dispose() { childStop.abort(); await result; } };
      },
    }));
    await ctx.plugin(WorkflowWorkerThread, { provider: "platform-preset", maxConcurrentAgents: 1,
      maxTotalAgents: workflow.steps.length, maxItemsPerCall: 8, syncTimeoutMs: 1000, disposeGraceMs: 1000 });
    ctx.on("workflow/log", (_info, message) => {
      const data = JSON.parse(message) as { stepId: string; state: string };
      if (data.state !== "skipped" || !workflow.steps.some(s => s.id === data.stepId) || seen.has(data.stepId)) { stop.abort(); return; }
      seen.add(data.stepId);
      void observe({ kind: "workflow", stepId: data.stepId, state: "skipped" });
    });
    const parent = await ctx.agents.create({ sessionId: SessionId(input.runId), signal: runSignal,
      agentOptions: { provider: "deepseek-official", model: input.definition.model.name } });
    try {
      const run = ctx.workflowEngine.start({ meta: { name: "approved-preset", description: "Approved platform workflow" },
        script, args: { steps: workflow.steps.map(({ id, whenPreviousContains }) => ({ id, whenPreviousContains })) },
        parent: parent.agent, signal: runSignal });
      try {
        const result = await run.result;
        await pending; runSignal.throwIfAborted();
        if (result.stopReason !== "completed" || typeof result.value !== "string" || !result.value) throw new Error("Native workflow failed");
        return result.value;
      } finally { await run.dispose(); }
    } finally { await parent.dispose(); }
  } finally { stop.abort(); await ctx.fiber.dispose(); }
};

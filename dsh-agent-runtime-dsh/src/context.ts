import { freezeMessage, MessageId } from "@deepseek-ai/dsh-llm";
import { Session, SessionId } from "@deepseek-ai/dsh-session";
import type { ExecutionInput } from "@dsh-agent/contracts";

// Import the complete Chat transcript, not a platform-selected model context.
// These are text-only imported turns, NOT a replay of historical DSH tool events.
export function historySeed(input: ExecutionInput) {
  if (input.context.truncated) throw new Error("Truncated legacy context cannot be executed");
  const session = Session.create(SessionId(input.context.sessionId));
  let turn = 0, open = false;
  const close = () => {
    if (!open) return;
    session.append("step/end", { turn, step: 1 });
    session.append("turn/end", { turn, reason: { kind: "completed" } });
    open = false;
  };
  for (const item of input.context.messages.slice(0, -1)) {
    if (item.role === "user" || !open) {
      close(); turn++; open = true;
      session.append("turn/start", { turn });
      session.append("step/start", { turn, step: 1 });
    }
    const content = [{ type: "text" as const, text: item.content }];
    if (item.role === "user") {
      session.append("user/message", freezeMessage({ id: MessageId(item.id), role: "user", content,
        source: { kind: "user" } }), { surfaceOp: "append" });
    } else {
      session.append("assistant/message", { turn, step: 1, message: freezeMessage({
        id: MessageId(item.id), role: "assistant", content, source: { kind: "model",
          provider: input.definition.model.provider, model: input.definition.model.name },
      }) }, { surfaceOp: "append" });
    }
  }
  close();
  return session.events;
}

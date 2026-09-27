import type { StreamChunk } from "@deepseek-ai/dsh-llm";
import { ModelTokens, type ModelCallReport } from "@dsh-agent/contracts";
export type UsageReporter = (report: ModelCallReport) => Promise<void>;

// 每次流只取最后一次供应商用量快照，不能把累计快照再次相加。
export async function* meterStream(source: () => AsyncIterable<StreamChunk>, call: number, report: UsageReporter): AsyncIterable<StreamChunk> {
  await report({ call, phase: "started" });
  let tokens: ModelTokens | null = null, finished = false;
  try {
    for await (const chunk of source()) {
      if (chunk.type === "usage") {
        const parsed = ModelTokens.safeParse(chunk.usage);
        tokens = parsed.success ? parsed.data : null;
      }
      // 消费方可能在 finish 后停止迭代，必须先等待持久化确认。
      if (chunk.type === "finish") {
        finished = true; await report({ call, phase: "finished", tokens });
      }
      yield chunk;
    }
  } finally {
    if (!finished) await report({ call, phase: "finished", tokens });
  }
}

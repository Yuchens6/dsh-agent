import type { StreamChunk } from "@deepseek-ai/dsh-llm";
import type { RunProgress } from "@dsh-agent/contracts";
export type ProgressReporter = (report: RunProgress) => Promise<void>;

// 一次最多预取一个供应商片段；首片立即发送，此后按时间/大小合并。
// 只转发正文，不转发 reasoning、工具参数或供应商私有字段。
export async function* previewStream(source: () => AsyncIterable<StreamChunk>, call: number,
  report: ProgressReporter, signal: AbortSignal, windowMs = 75): AsyncIterable<StreamChunk> {
  const iterator = source()[Symbol.asyncIterator]();
  let pending = iterator.next(), buffer = "", first = true, sentAt = 0;
  async function flush() {
    while (buffer.length) {
      let length = Math.min(2048, buffer.length);
      const end = buffer.charCodeAt(length - 1);
      if (end >= 0xd800 && end <= 0xdbff) length--;
      if (!length) return;
      const text = buffer.slice(0, length); buffer = buffer.slice(length);
      signal.throwIfAborted();
      await report({ kind: "text", call, text });
      first = false; sentAt = Date.now();
    }
  }
  try {
    while (true) {
      signal.throwIfAborted();
      let timer: ReturnType<typeof setTimeout> | undefined;
      // 单个高代理项暂留，直到后续片段补齐；避免零延迟空转。
      const canFlush = buffer.length > 1 || buffer.length === 1 && !/[\uD800-\uDBFF]/.test(buffer);
      const item = await (canFlush
        ? Promise.race([pending, new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), Math.max(1, windowMs - (Date.now() - sentAt))); })])
        : pending).finally(() => clearTimeout(timer));
      if (item === null) { await flush(); continue; }
      if (item.done) { await flush(); if (buffer) throw new Error("Invalid text boundary"); break; }
      const chunk = item.value;
      if (chunk.type === "text-delta") {
        buffer += chunk.text;
        if (first || buffer.length >= 2048 || Date.now() - sentAt >= windowMs) await flush();
      }
      if (chunk.type === "finish") { await flush(); if (buffer) throw new Error("Invalid text boundary"); }
      yield chunk;
      pending = iterator.next();
    }
  } finally { await iterator.return?.(); }
}

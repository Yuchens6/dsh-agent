import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ChildMessage } from "./protocol.js";
import type { Executor } from "./worker.js";
import { RuntimeError } from "./client.js";

export function processExecutor(config: { apiKey: string; baseUrl: string; maxToolCalls: number }): Executor {
  return async (input, tool, signal, reportUsage = async () => {}) => {
    signal.throwIfAborted();
    const env: Record<string, string> = {};
    for (const name of ["SystemRoot", "WINDIR", "TEMP", "TMP", "PATH", "LANG", "LC_ALL"]) {
      if (process.env[name]) env[name] = process.env[name]!;
    }
    const child = fork(fileURLToPath(new URL("../dist/child.js", import.meta.url)), [], {
      cwd: fileURLToPath(new URL("..", import.meta.url)), env, execArgv: ["--max-old-space-size=256"],
      windowsHide: true, stdio: ["ignore", "ignore", "ignore", "ipc"], serialization: "json",
    });
    return new Promise<string>((resolve, reject) => {
      let finished = false, output: string | undefined, failed = false, active = false, lastId = 0;
      let usageActive = false, lastUsageId = 0;
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      const stop = () => {
        if (finished) return;
        child.kill("SIGTERM");
        killTimer ??= setTimeout(() => child.kill("SIGKILL"), 1000);
      };
      const fail = () => { failed = true; stop(); };
      signal.addEventListener("abort", fail, { once: true });
      child.on("error", fail);
      child.on("message", raw => {
        const parsed = ChildMessage.safeParse(raw);
        if (failed || output !== undefined || !parsed.success) { fail(); return; }
        const message = parsed.data;
        if (message.kind === "failed") { fail(); return; }
        if (message.kind === "result") {
          if (active || usageActive || output !== undefined) { fail(); return; }
          output = message.output; stop(); return;
        }
        if (message.kind === "usage") {
          if (usageActive || active || message.id !== lastUsageId + 1 || message.id > input.definition.execution.maxTurns * 2) { fail(); return; }
          lastUsageId = message.id; usageActive = true;
          void reportUsage(message.report).then(() => {
            usageActive = false;
            if (!finished && !failed && child.connected) child.send({ kind: "usage-ack", id: message.id }, error => { if (error) fail(); });
          }, () => { usageActive = false; fail(); });
          return;
        }
        if (active || message.id !== lastId + 1 || message.id > config.maxToolCalls || !input.definition.tools.includes(message.call.tool)) { fail(); return; }
        lastId = message.id; active = true;
        void tool(message.call).then(result => {
          active = false;
          if (!finished && !failed && child.connected) child.send({ kind: "tool-result", id: message.id, result }, error => { if (error) fail(); });
        }, () => { active = false; fail(); });
      });
      // close 也覆盖启动失败（可能只有 error，没有 exit），且此时通信通道已经关闭。
      child.once("close", () => {
        finished = true; clearTimeout(killTimer); signal.removeEventListener("abort", fail);
        if (!failed && !signal.aborted && output !== undefined) resolve(output);
        else reject(new RuntimeError("EXECUTION_FAILED"));
      });
      if (signal.aborted) fail();
      else child.send({ kind: "start", input, ...config }, error => { if (error) fail(); });
    });
  };
}

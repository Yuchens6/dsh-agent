import { setTimeout as pause, setImmediate as yieldTurn } from "node:timers/promises";
// 每个工作循环至多占一个在途任务；有工作立即续跑，空闲/失败才退避。
export function backgroundWorkers(count: number, signal: AbortSignal, task: () => Promise<boolean>, onError: () => void, idleMs = 500) {
  if (!Number.isInteger(count) || count < 1 || count > 16 || idleMs < 1) throw new Error("Invalid worker configuration");
  return Promise.all(Array.from({length:count}, async () => {
    while (!signal.aborted) {
      let busy = false;
      try { busy = await task(); } catch { if (!signal.aborted) onError(); }
      if (signal.aborted) break;
      if (busy) await yieldTurn();
      else await pause(idleMs + Math.floor(Math.random()*Math.max(1,idleMs/4)),undefined,{signal}).catch(()=>{});
    }
  })).then(()=>undefined);
}


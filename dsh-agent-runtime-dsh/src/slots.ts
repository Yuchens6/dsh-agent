import { setTimeout as pause } from "node:timers/promises";
// 每个槽位一次仅领取一个任务；无预取队列，停止后等待所有在途执行清理。
export async function runSlots<T>(options: {
  concurrency:number; signal:AbortSignal; claim:(signal:AbortSignal)=>Promise<T|null>;
  execute:(claim:T,signal:AbortSignal)=>Promise<void>; health:(slot:number,healthy:boolean)=>void;
  idleMs?:number;
}) {
  if (!Number.isInteger(options.concurrency) || options.concurrency<1 || options.concurrency>16) throw new Error("Invalid runtime concurrency");
  await Promise.all(Array.from({length:options.concurrency},async(_,slot)=>{
    while(!options.signal.aborted) {
      let delay=options.idleMs ?? 1000;
      try {
        const claim=await options.claim(options.signal); options.health(slot,true);
        if(claim!==null) { await options.execute(claim,options.signal); continue; }
      } catch {
        if(options.signal.aborted) break;
        options.health(slot,false); delay*=2;
      }
      await pause(delay+Math.floor(Math.random()*delay/4),undefined,{signal:options.signal}).catch(()=>{});
    }
  }));
}

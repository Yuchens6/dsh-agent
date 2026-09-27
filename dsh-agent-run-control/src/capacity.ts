import type { Database } from "./database.js";
export class DatabaseCapacityError extends Error {
  readonly statusCode = 503;
  constructor() { super("DEPENDENCY_UNAVAILABLE"); }
}
// 包含正在使用连接与等待连接的操作；满载立即失败，不再进入 pg 的等待队列。
export function boundedDatabase(inner: Database, capacity: number) {
  if (!Number.isInteger(capacity) || capacity<1 || capacity>1100) throw new Error("Invalid database capacity");
  let active=0, rejected=0;
  async function use<T>(work:()=>Promise<T>) {
    if(active>=capacity) { rejected++; throw new DatabaseCapacityError(); }
    active++;
    try { return await work(); } finally { active--; }
  }
  const db:Database={
    query<T extends Record<string,unknown>>(sql:string,values?:unknown[]) { return use(()=>inner.query<T>(sql,values)); },
    transaction:work=>use(()=>inner.transaction(work)),
  };
  return {db,snapshot:()=>({db_operations:active,db_capacity:capacity,db_rejected_total:rejected})};
}


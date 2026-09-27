// 本副本的在途上限，不是跨副本用户配额。拒绝额外请求，不建立等待队列。
export class Admission {
  private active = 0;
  constructor(readonly limit: number) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10000) throw new Error("Invalid API capacity");
  }
  enter(): (() => void) | undefined {
    if (this.active >= this.limit) return;
    this.active++; let released = false;
    return () => { if (!released) { released = true; this.active--; } };
  }
  get inFlight() { return this.active; }
}

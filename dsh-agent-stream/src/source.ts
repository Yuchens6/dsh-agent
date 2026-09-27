import type { NatsConnection } from "@nats-io/transport-node";
import { jetstream, jetstreamManager, DeliverPolicy } from "@nats-io/jetstream";
import type { Principal } from "@dsh-agent/contracts";

export interface Delivery { sequence: number; event: unknown }
export interface Subscription extends AsyncIterable<Delivery> { close(): Promise<void> }
export interface EventSource {
  open(actor: Principal, sessionId: string, after?: number): Promise<Subscription>;
}
export class CursorExpired extends Error {}
export function natsSource(nc: NatsConnection, stream = "DSH_EVENTS"): EventSource {
  return {
    async open(actor, sessionId, after) {
      const manager = await jetstreamManager(nc, { timeout: 3000 });
      const info = await manager.streams.info(stream);
      if (after !== undefined && (after < info.state.first_seq - 1 || after > info.state.last_seq)) {
        throw new CursorExpired();
      }
      const subject = "agent.events." + actor.tenantId + "." + actor.uid + "." + sessionId;
      const consumer = await jetstream(nc, { timeout: 3000 }).consumers.get(stream, {
        filter_subjects: subject, inactive_threshold: 120_000_000_000,
        deliver_policy: after === undefined ? DeliverPolicy.All : DeliverPolicy.StartSequence,
        ...(after === undefined ? {} : { opt_start_seq: after + 1 }),
      });
      let sub;
      try { sub = await consumer.consume({ max_messages: 16 }); }
      catch (error) { await consumer.delete().catch(() => undefined); throw error; }
      let closed = false;
      return {
        async close() {
          if (closed) return;
          closed = true;
          // close 排队发送迭代结束标记；等待它会与暂停在 yield 的 SSE 消费者互相等待。
          // 调用时已经同步撤销底层订阅和计时器，服务端消费者在下一行独立删除。
          void sub.close();
          await consumer.delete().catch(() => undefined);
        },
        async *[Symbol.asyncIterator]() {
          for await (const msg of sub) {
            let event: unknown;
            try { event = msg.json(); } catch { continue; }
            yield { sequence: msg.seq, event };
          }
        },
      };
    },
  };
}

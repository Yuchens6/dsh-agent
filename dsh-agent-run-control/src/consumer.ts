import type { NatsConnection } from "@nats-io/transport-node";
import { jetstreamManager, jetstream, AckPolicy, DeliverPolicy, RetentionPolicy, DiscardPolicy } from "@nats-io/jetstream";
import { ZodError } from "zod";
import { RunError, type RunRepository } from "./repository.js";
export const requestStream = "DSH_RUN_REQUESTS";
export const requestSubject = "agent.commands.run.requested.v1";
export const consumerName = "run-control-v1";
export async function openRequestConsumer(nc: NatsConnection) {
  const manager = await jetstreamManager(nc, { timeout: 3000 });
  const stream = await manager.streams.info(requestStream);
  if (stream.config.retention !== RetentionPolicy.Workqueue || stream.config.discard !== DiscardPolicy.New || stream.config.max_age !== 0) {
    throw new Error("Run request stream must retain unacknowledged requests without expiry");
  }
  let info;
  try { info = await manager.consumers.info(requestStream, consumerName); }
  catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === 10014)) throw error;
    info = await manager.consumers.add(requestStream, { durable_name: consumerName, ack_policy: AckPolicy.Explicit,
      deliver_policy: DeliverPolicy.All, filter_subject: requestSubject, max_ack_pending: 1,
      ack_wait: 30_000_000_000, max_deliver: -1 });
  }
  if (info.config.ack_policy !== AckPolicy.Explicit || info.config.max_ack_pending !== 1 ||
    info.config.max_deliver !== -1 || info.config.filter_subject !== requestSubject) throw new Error("Unexpected run consumer configuration");
  const consumer = await jetstream(nc).consumers.get(requestStream, consumerName);
  return consumer.consume({ max_messages: 1 });
}
export interface RequestDelivery {
  seq: number; subject: string; json(): unknown; ack(): void; nak(delay: number): void;
}
export async function processRequest(repository: RunRepository, message: RequestDelivery) {
  let input: unknown;
  try { input = message.json(); }
  catch {
    await repository.reject(message.seq, "INVALID_REQUEST"); message.ack(); return;
  }
  try {
    if (message.subject !== requestSubject) throw new RunError(400, "INVALID_REQUEST");
    await repository.accept(input);
  } catch (error) {
    if (error instanceof ZodError || error instanceof RunError && [400, 409].includes(error.status)) {
      await repository.reject(message.seq, error instanceof RunError && error.status === 409 ? "IDEMPOTENCY_CONFLICT" : "INVALID_REQUEST");
      message.ack(); return;
    }
    message.nak(5000); throw error;
  }
  // 数据库事务成功后才确认；确认丢失会重投，由消息标识和事件标识双重去重。
  message.ack();
}

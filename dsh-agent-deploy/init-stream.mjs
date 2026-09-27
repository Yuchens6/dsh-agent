import { connect } from "@nats-io/transport-node";
import { jetstreamManager, StorageType, RetentionPolicy, DiscardPolicy } from "@nats-io/jetstream";
const nc = await connect({ servers: process.env.NATS_URL, token: process.env.NATS_TOKEN });
try {
  const manager = await jetstreamManager(nc);
  const config = {
    name: "DSH_EVENTS", subjects: ["agent.events.>"],
    storage: StorageType.File, retention: RetentionPolicy.Limits,
    max_age: 24 * 60 * 60 * 1_000_000_000, max_bytes: 1024 * 1024 * 1024,
    max_msg_size: 131072, duplicate_window: 120_000_000_000, num_replicas: 1,
  };
  try { await manager.streams.info(config.name); }
  catch (error) {
    if (error.code !== 10059) throw error;
    await manager.streams.add(config);
  }
  const requests = {
    name: "DSH_RUN_REQUESTS", subjects: ["agent.commands.run.requested.v1"],
    storage: StorageType.File, retention: RetentionPolicy.Workqueue, discard: DiscardPolicy.New,
    max_age: 0, max_bytes: 1024 * 1024 * 1024, max_msg_size: 8192,
    duplicate_window: 120_000_000_000, num_replicas: 1,
  };
  try {
    const existing = await manager.streams.info(requests.name);
    if (existing.config.retention !== requests.retention || existing.config.discard !== requests.discard ||
      existing.config.max_age !== 0) throw new Error("Unsafe existing run request stream configuration");
  } catch (error) {
    if (error.code !== 10059) throw error;
    await manager.streams.add(requests);
  }
} finally { await nc.drain(); }

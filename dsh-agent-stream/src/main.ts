import { z } from "zod";
import { connect } from "@nats-io/transport-node";
import { createStreamApp } from "./app.js";
import { remoteIdentityVerifier, capabilityVerifier } from "./auth.js";
import { natsSource } from "./source.js";
const env = z.object({
  IAM_ISSUER: z.string().url(), IAM_JWKS_URL: z.string().url(),
  IAM_AUDIENCE: z.string().default("agent-platform"), CHAT_CAPABILITY_SECRET: z.string().min(32),
  NATS_URL: z.string().url(), NATS_TOKEN: z.string().min(1),
  PORT: z.coerce.number().int().default(8080),
  HOST: z.enum(["127.0.0.1", "0.0.0.0"]).default("0.0.0.0"),
}).parse(process.env);
const nc = await connect({ servers: env.NATS_URL, token: env.NATS_TOKEN, timeout: 3000 });
const app = createStreamApp({
  authenticate: remoteIdentityVerifier(env.IAM_ISSUER, env.IAM_AUDIENCE, env.IAM_JWKS_URL),
  verifyCapability: capabilityVerifier(env.CHAT_CAPABILITY_SECRET),
  source: natsSource(nc), logger: true,
  ready: async () => { if (nc.isClosed()) throw new Error(); await nc.flush(); },
});
await app.listen({ host: env.HOST, port: env.PORT });
let stopping = false;
async function stop() {
  if (stopping) return; stopping = true;
  await app.close(); await nc.drain();
}
process.once("SIGTERM", () => void stop());
process.once("SIGINT", () => void stop());

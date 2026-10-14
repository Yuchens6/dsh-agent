import { createWebApp } from "./app.js";
const port = Number(process.env.PORT ?? 3000);
const app = createWebApp({ apiUrl: process.env.API_URL ?? "http://127.0.0.1:8080",
  streamUrl: process.env.STREAM_URL ?? "http://127.0.0.1:8082", issuer: process.env.IAM_ISSUER ?? "http://127.0.0.1:8081/realms/agent-local",
  publicOrigin: process.env.WEB_ORIGIN ?? "http://localhost:3000", clientId: process.env.IAM_CLIENT_ID ?? "agent-web" });
await app.listen({ host: process.env.HOST ?? "127.0.0.1", port });
console.log(`Agent Studio: ${process.env.WEB_ORIGIN ?? "http://localhost:3000"}`);
const stop = async () => { await app.close(); };
process.once("SIGINT", () => void stop()); process.once("SIGTERM", () => void stop());

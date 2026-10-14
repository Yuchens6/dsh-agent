import test from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { createWebApp } from "../dsh-agent-web/src/app.js";

test("Web: 静态页面、CSP、主机和来源校验，以及仅转发白名单认证头", async t => {
  const upstream = Fastify(); const seen: Record<string, unknown>[] = [];
  upstream.get("/api/v1/me", async req => { seen.push(req.headers); return { uid: "alice" }; });
  upstream.post("/realms/test/protocol/openid-connect/token", async () => ({ access_token: "fixture-token" }));
  const origin = await upstream.listen({ host: "127.0.0.1", port: 0 }); t.after(() => upstream.close());
  const web = createWebApp({ apiUrl: origin, streamUrl: origin, issuer: origin + "/realms/test", publicOrigin: "http://localhost:3000", clientId: "agent-web" }); t.after(() => web.close());
  const headers = { host: "localhost:3000" };
  const page = await web.inject({ url: "/", headers });
  assert.equal(page.statusCode, 200); assert.match(page.body, /智能体工作台/);
  assert.match(String(page.headers["content-security-policy"]), /frame-ancestors 'none'/);
  assert.equal((await web.inject({ url: "/config", headers })).json().clientId, "agent-web");
  assert.equal((await web.inject({ url: "/", headers: { host: "evil.test" } })).statusCode, 421);
  assert.equal((await web.inject({ url: "/api/v1/me", headers: { ...headers, origin: "https://evil.test" } })).statusCode, 403);
  const response = await web.inject({ url: "/api/v1/me", headers: { ...headers, authorization: "Bearer user", cookie: "secret=ignore", "x-tenant-id": "evil" } });
  assert.equal(response.json().uid, "alice"); assert.equal(seen[0]!.authorization, "Bearer user");
  assert.equal(seen[0]!.cookie, undefined); assert.equal(seen[0]!["x-tenant-id"], undefined);
  assert.equal((await web.inject({ url: "/.env", headers })).statusCode, 404);
  assert.equal((await web.inject({ method: "POST", url: "/auth/token", headers: { ...headers, "content-type": "application/x-www-form-urlencoded" }, payload: "client_id=admin-cli&grant_type=password" })).statusCode, 400);
});

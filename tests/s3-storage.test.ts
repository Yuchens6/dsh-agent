import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { s3Store } from "../dsh-agent-workspace/src/storage.js";

test("S3 适配器: 真实 HTTP 编解码、签名请求、不可覆盖对象与读取字节上限", async t => {
  // 此处是协议夹具，不是完整 S3 服务；生产供应商仍需集成验收。
  const objects = new Map<string, Buffer>();
  const requests: string[] = [];
  const server = createServer(async (req, res) => {
    requests.push(req.method!);
    assert.match(req.headers.authorization ?? "", /^AWS4-HMAC-SHA256 /);
    const key = new URL(req.url!, "http://local").pathname;
    if (req.method === "HEAD") { res.writeHead(200); res.end(); return; }
    if (req.method === "PUT") {
      assert.equal(req.headers["if-none-match"], "*");
      if (objects.has(key)) { res.writeHead(412); res.end(); return; }
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      objects.set(key, Buffer.concat(chunks));
      res.writeHead(200, { etag: '"fixture"' }); res.end(); return;
    }
    if (req.method === "GET") {
      const object = objects.get(key);
      if (!object) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { "content-length": object.length }); res.end(object); return;
    }
    if (req.method === "DELETE") { objects.delete(key); res.writeHead(204); res.end(); return; }
    res.writeHead(405); res.end();
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address() as { port: number };
  const store = s3Store({
    endpoint: "http://127.0.0.1:" + address.port, region: "us-east-1", bucket: "workspace-test",
    accessKeyId: "test-access", secretAccessKey: "test-only-key",
  });
  t.after(async () => { store.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  await store.ready();
  const content = Buffer.from("你好，工作区");
  await store.put("workspace/version", content);
  assert.deepEqual(Buffer.from(await store.get("workspace/version", content.length)), content);
  await assert.rejects(store.put("workspace/version", Buffer.from("overwrite")));
  await assert.rejects(store.get("workspace/version", content.length - 1), /size mismatch/);
  await store.delete("workspace/version");
  await assert.rejects(store.get("workspace/version", content.length));
  assert.equal(objects.size, 0);
  assert.deepEqual(requests, ["HEAD", "PUT", "GET", "PUT", "GET", "DELETE", "GET"]);
});

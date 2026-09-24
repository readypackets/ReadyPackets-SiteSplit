import assert from "node:assert/strict";
import { createServer, request as httpRequest, type IncomingMessage } from "node:http";

process.env.NODE_ENV = "production";
process.env.APP_URL = "https://portal.example.test";
process.env.PUBLIC_SITE_URL = "https://www.example.test";
process.env.ALLOWED_ORIGINS = "https://portal.example.test,https://www.example.test";
process.env.DATABASE_URL = "mysql://readypackets:placeholder@127.0.0.1:3306/readypackets";
process.env.SESSION_SECRET = "a".repeat(64);
process.env.DATA_ENCRYPTION_KEY = "b".repeat(64);
process.env.EMAIL_INDEX_KEY = "c".repeat(64);
process.env.STORAGE_DRIVER = "local";
process.env.STORAGE_LOCAL_ROOT = "/tmp/readypackets-dual-site-smoke";
process.env.TRUST_PROXY_HOPS = "1";
process.env.BIND_HOST = "127.0.0.1";

const { createApp } = await import("../server/app.js");
const server = createServer(createApp());

function request(port: number, host: string, path: string): Promise<{ status: number; headers: IncomingMessage["headers"]; body: string }> {
  return new Promise((resolve, reject) => {
    const client = httpRequest({ host: "127.0.0.1", port, path, method: "GET", headers: { Host: host, "X-Forwarded-Proto": "https" } }, (response: IncomingMessage) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => { body += chunk; });
      response.on("end", () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body }));
    });
    client.on("error", reject);
    client.end();
  });
}

await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
assert(address && typeof address !== "string");
try {
  const publicHome = await request(address.port, "www.example.test", "/");
  assert.equal(publicHome.status, 200);
  assert.match(publicHome.body, /data-rp-surface="public"/);
  assert.match(publicHome.body, /robots" content="index, follow/);

  const portalHome = await request(address.port, "portal.example.test", "/portal");
  assert.equal(portalHome.status, 200);
  assert.match(portalHome.body, /data-rp-surface="portal"/);
  assert.match(portalHome.body, /robots" content="noindex, nofollow, noarchive"/);

  const signIn = await request(address.port, "www.example.test", "/login");
  assert.equal(signIn.status, 302);
  assert.equal(signIn.headers.location, "https://portal.example.test/login");

  const portalRoot = await request(address.port, "portal.example.test", "/");
  assert.equal(portalRoot.status, 302);
  assert.equal(portalRoot.headers.location, "https://portal.example.test/login");

  const packets = await request(address.port, "portal.example.test", "/packets");
  assert.equal(packets.status, 302);
  assert.equal(packets.headers.location, "https://www.example.test/packets");

  console.log("Dual-site host routing smoke test passed.");
} finally {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

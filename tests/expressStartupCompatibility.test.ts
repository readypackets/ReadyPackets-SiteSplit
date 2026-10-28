import { createServer, request } from "node:http";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { createApp } from "../server/app.js";
import { env } from "../server/config/env.js";

describe("Express 5 startup compatibility", () => {
  it("constructs the complete application without path-to-regexp startup errors", () => {
    expect(() => createApp()).not.toThrow();
  });

  it("returns generic 404 responses for every mobile surface until an operator explicitly enables mobile OAuth", async () => {
    const server = createServer(createApp());
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Test server did not bind a TCP port.");
    try {
      for (const [path, options] of [
        ["/.well-known/openid-configuration", {}],
        ["/.well-known/assetlinks.json", {}],
        ["/api/mobile/v1/authorize", {}],
        ["/api/mobile/v1/token", { method: "POST" }],
        ["/api/mobile/v1/revoke", { method: "POST" }],
      ] as const) {
        const response = await new Promise<{ status: number; body: string }>((resolve, reject) => {
          const req = request({
            host: "127.0.0.1",
            port: address.port,
            path,
            method: options.method ?? "GET",
            headers: { Host: env.appHostname },
          }, (res) => {
            let body = "";
            res.setEncoding("utf8");
            res.on("data", (chunk: string) => { body += chunk; });
            res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
          });
          req.on("error", reject);
          req.end();
        });
        expect(response.status, path).toBe(404);
        expect(response.body, path).not.toContain("<!doctype html");
      }
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("uses a named brace catch-all for the GET-only SPA fallback", () => {
    const source = readFileSync(resolve(process.cwd(), "server/app.ts"), "utf8");
    expect(source).toContain('app.get("/{*splat}", async (req: Request, res: Response) => {');
    expect(source).not.toContain('app.get("*", async (req: Request, res: Response) => {');
  });

  it("ships a syntax-valid, immutable source-only repair helper that preserves configuration, TLS, and data", () => {
    const repairPath = resolve(process.cwd(), "deploy/repair-express5-startup.sh");
    const source = readFileSync(repairPath, "utf8");
    expect(spawnSync("bash", ["-n", repairPath], { encoding: "utf8" }).status).toBe(0);
    expect(source).toContain('readonly COMMIT="9cce95ff4ca123d3c358659140c7f25b9feee5d9"');
    expect(source).toContain('grep -Fq "Missing parameter name at index 1: *"');
    expect(source).toContain('journalctl -u "$SERVICE" --since "14 days ago" --no-pager');
    expect(source).toContain("--confirm-known-express5-journal-error");
    expect(source).toContain("operator explicitly confirmed the already-verified Express 5 journal signature");
    expect(source).toContain('git -C "$SOURCE_DIR" worktree add --detach "$SOURCE_STAGE" "$RESOLVED_COMMIT"');
    expect(source).toContain('pnpm exec esbuild server/index.ts');
    expect(source).toContain('ENV_DIGEST_BEFORE="$(sha256sum "$ENV_FILE" | awk');
    expect(source).toContain('ENV_DIGEST_AFTER="$(sha256sum "$ENV_FILE" | awk');
    expect(source).toContain('mv -- "${APP_DIR}/dist/server.js" "$PREVIOUS_SERVER"');
    expect(source).toContain('restore_previous_server');
    expect(source).toContain("Protected environment: byte-for-byte unchanged");
    expect(source).not.toContain('bash "$SOURCE_DIR/deploy/install.sh"');
    expect(source).not.toContain("--tls-provider");
    expect(source).not.toContain("--cloudflare-api-token");
    expect(source).not.toContain("--no-seed");
  });
});

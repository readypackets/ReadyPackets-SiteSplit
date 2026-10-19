import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { createApp } from "../server/app.js";

describe("Express 5 startup compatibility", () => {
  it("constructs the complete application without path-to-regexp startup errors", () => {
    expect(() => createApp()).not.toThrow();
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
